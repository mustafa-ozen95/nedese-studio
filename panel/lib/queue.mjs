/**
 * Job queue: GPU jobs run ONE AT A TIME (ComfyUI and a voice-over never together).
 *
 * Every job lives in its own folder (<ai>\outputs\<id>\) with job.json + log.txt + its outputs; the database
 * (lib/database.mjs) is an index of them: when the panel reopens, waiting jobs go on in order and the ones cut off
 * while running become "interrupted" ("Retry" goes on).
 * A job goes on when the browser tab closes too: the server runs it, the page only reads its state.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { freemem } from 'node:os';
import { CancelError, UserError, friendlyError, isOutOfVram } from './errors.mjs';
import { nodeName, nodeDurationSummary, classes } from './graph.mjs';
import { measureGpu } from './gpu.mjs';
import { isGpuBusy } from './gpu-watchdog.mjs';
import { closeComfy, comfyProcesses, comfyPatch, comfyPaths } from './comfy-process.mjs';
import { moveToRecycleBin } from './deletion.mjs';
import { exifOrientation, imageSize } from './media.mjs';
import { fixOrientation } from './ffmpeg.mjs';
import { findLlm } from './llm.mjs';
import { comfyFlags, fineSetting } from './fine-settings.mjs';

const WAIT = (ms, signal) =>
  new Promise((ok, red) => {
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', cancel);
      ok();
    }, ms);
    const cancel = () => {
      clearTimeout(t);
      red(new CancelError());
    };
    if (signal?.aborted) cancel();
    else signal?.addEventListener('abort', cancel, { once: true });
  });

// The type may hold digits (model3d) and capitals (pageVideo: its files answered 404 and it could not be deleted)
export const JOB_ID = /^\d{8}-\d{6}-[a-z][a-zA-Z0-9]*-[0-9a-f]{4}$/;
const ID = JOB_ID;
const OUTPUT_LIMIT = 60;
// Jobs that serve another screen (the chat's read aloud): in the queue while they run, never in the gallery or job pages
export const HIDDEN_TYPES = ['speech'];

export class Queue {
  /**
   * setting: what the settings setup returns; comfy: the ComfyUI client; mod: the exports of comfy.mjs;
   * runners: { image, video, voice, film, ... } (validate, run, summary).
   */
  constructor({ setting, comfy, mod, runners, db = null }) {
    this.setting = setting;
    // Local database (lib/database.mjs): the list, pages and averages come from queries; without it, from memory.
    this.db = db;
    this.averageCache = null;
    this.comfy = comfy;
    this.mod = mod;
    this.runners = runners;
    this.jobs = new Map();
    this.logs = new Map();
    this.active = null;
    this.version = 1;
    this.closed = false;
    this.wake = null;
    this.comfyStartup = 0;
    this.lastRecord = new Map();
    // Closing an idle ComfyUI: a function that gives the minutes (the server binds it to the settings; without it, off).
    this.idleCloseMin = null;
    this.idleTimer = null;
    this.comfyIdleClosed = null;
  }

  /**
   * Should a request to the text model from outside (a bot, /llm/v1, the Text page, the chat) wait: yes while the
   * running job gives the GPU to ComfyUI or to training. A job that uses the text model itself (data collection, image
   * description: textModelShares) shares it, otherwise the nedese bot waited 330 s and fell back to DeepSeek; a job
   * without the GPU (page video, video edit: gpuNotNeeded) leaves it free, otherwise the Text page recorded in a page
   * video never got its answer. With the gpuShare fine setting off (a big card: both fit) nothing waits.
   */
  externalRequestShouldWait() {
    if (!this.active || !fineSetting('gpuShare')) return false;
    const runner = this.runners?.[this.active.job.type];
    return !(runner?.textModelShares || runner?.gpuNotNeeded);
  }

  /* ── Records ───────────────────────────────────────────────────────── */

  /**
   * For a job entering the queue: a running job that yields (a long data collection) leaves the queue and goes on where
   * it left off once the queue is empty. That is when the new job does not yield, or the running one is unbounded and
   * the new one has an end. A job being cancelled, already paused or in its last pass (noYield) does not leave.
   * add() and tryAgain() call it.
   */
  yieldFor(fresh) {
    const running = this.active?.job;
    if (!running || running === fresh || running.status !== 'running' || this.active.pause || this.active.cancel || this.active.control.signal.aborted || running.noYield) return;
    const runningC = this.runners[running.type];
    const newC = this.runners[fresh.type];
    if (!runningC?.yields || !newC) return;
    if (newC.yields && !(runningC.isLong?.(running.input) && !newC.isLong?.(fresh.input))) return;
    running.yielded = true;
    this.log(running.id, `Yielding the queue to a new job (${newC.name}); resumes where it left off once the queue is empty.`);
    this.pause(running.id);
  }

  /**
   * A job that was running when the panel closed: "interrupted". A job that yields (a long data collection) goes on by
   * itself once the queue is empty instead (an unbounded crawl is not cut off by a panel restart).
   */
  partialRemained(job) {
    if (this.runners[job.type]?.yields) {
      job.status = 'paused';
      job.yielded = true;
      job.error = null;
      job.progress = { ...job.progress, stage: 'Panel reopened; resumes once the queue is empty', detail: '' };
      return;
    }
    job.status = 'interrupted';
    job.error = 'The job was running when the panel closed. "Retry" continues where it left off.';
    job.progress = { ...job.progress, stage: 'Interrupted' };
  }

  load() {
    mkdirSync(this.setting.outputRoot, { recursive: true });
    // With a filled database the folders are not scanned (a fast start with thousands of jobs).
    if (this.db && this.db.jobCount() > 0) {
      for (const job of this.db.jobs()) {
        if (job.status === 'running') {
          this.partialRemained(job);
          this.jobs.set(job.id, job);
          this.save(job, true);
          continue;
        }
        this.jobs.set(job.id, job);
      }
      return;
    }
    for (const d of readdirSync(this.setting.outputRoot)) {
      if (!ID.test(d)) continue;
      const path = join(this.setting.outputRoot, d, 'job.json');
      if (!existsSync(path)) continue;
      try {
        const job = JSON.parse(readFileSync(path, 'utf8'));
        if (job.panel !== 1 || job.id !== d) continue;
        if (job.status === 'running') {
          this.partialRemained(job);
          this.jobs.set(d, job);
          this.save(job, true);
          continue;
        }
        this.jobs.set(d, job);
      } catch {
        /* a broken job.json: left alone */
      }
    }
    // First start (or the database was deleted): built from the folders, the measurements carried over too.
    if (this.db) {
      const ordered = [...this.jobs.values()].sort((a, b) => a.creation.localeCompare(b.creation));
      for (const job of ordered) {
        this.db.writeJob(job);
        for (const [key, value] of Object.entries(job.measurements ?? {})) this.db.writeMeasurement(key, value, job.id);
      }
    }
  }

  folder(id) {
    return join(this.setting.outputRoot, id);
  }

  save(job, immediately = true) {
    const now = Date.now();
    if (!immediately && now - (this.lastRecord.get(job.id) ?? 0) < 4000) return;
    this.lastRecord.set(job.id, now);
    const path = join(this.folder(job.id), 'job.json');
    const temp = `${path}.writing`;
    // The folder may have been deleted by hand or while the panel was closed: made again (the write error stopped the queue loop)
    mkdirSync(this.folder(job.id), { recursive: true });
    writeFileSync(temp, JSON.stringify(job, null, 1), 'utf8');
    renameSync(temp, path);
    this.db?.writeJob(job);
  }

  changed() {
    this.version += 1;
  }

  log(id, text) {
    const line = `${new Date().toLocaleTimeString('tr-TR', { hour12: false })} ${text}`;
    const list = this.logs.get(id) ?? [];
    list.push(line);
    if (list.length > 300) list.splice(0, list.length - 300);
    this.logs.set(id, list);
    try {
      appendFileSync(join(this.folder(id), 'log.txt'), `${new Date().toISOString()} ${text}\n`, 'utf8');
    } catch {
      /* the folder may have been deleted */
    }
  }

  lastLog(id, count = 40) {
    let list = this.logs.get(id);
    if (!list) {
      try {
        list = readFileSync(join(this.folder(id), 'log.txt'), 'utf8').trim().split(/\r?\n/).slice(-count)
          .map((s) => s.replace(/^(\d{4}-\d\d-\d\dT)(\d\d:\d\d:\d\d)\.\d+Z /, (_, __, hour) => `${hour} `));
      } catch {
        list = [];
      }
    }
    return list.slice(-count);
  }

  /* ── Public ────────────────────────────────────────────────────────── */

  newId(type, now) {
    const two = (n) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
    let id;
    do id = `${stamp}-${type}-${randomBytes(2).toString('hex')}`;
    while (this.jobs.has(id));
    return id;
  }

  /**
   * A finished job for a picture that came from elsewhere (one the assistant fetched from the web): no runner, done at
   * once, in the gallery like any other (user request 08.10.2026: what a chat produced stays in the gallery unless it is
   * deleted with the chat).
   */
  addFinished(type, { name, data, summary = {}, input = {} }) {
    if (!Object.hasOwn(this.runners, type)) throw new UserError(`Unknown job type: ${type}`);
    const now = new Date();
    const id = this.newId(type, now);
    mkdirSync(this.folder(id), { recursive: true });
    const file = basename(String(name)).replace(/[^\w.-]/g, '_');
    writeFileSync(join(this.folder(id), file), data);
    const size = imageSize(join(this.folder(id), file));
    const time = now.toISOString();
    const job = { panel: 1, id, type, status: 'done', creation: time, start: time, end: time, duration: 0, machine: this.setting.machine, input, summary, progress: { percent: 100, stage: 'Done' }, outputs: [{ file, type: 'image', ...(size ?? {}) }], measurements: {} };
    this.jobs.set(id, job);
    this.save(job);
    this.log(id, `Added from elsewhere: ${input.from ?? file}`);
    this.changed();
    return job;
  }

  add(type, input) {
    const c = Object.hasOwn(this.runners, type) ? this.runners[type] : undefined; // inherited names such as "constructor" are not job types
    if (!c) throw new UserError(`Unknown job type: ${type}`);
    const clean = c.validate(input ?? {}, { mod: this.mod, setting: this.setting });
    const now = new Date();
    const id = this.newId(type, now);
    mkdirSync(this.folder(id), { recursive: true });
    const job = {
      panel: 1,
      id,
      type,
      status: 'waiting',
      creation: now.toISOString(),
      machine: this.setting.machine,
      input: clean,
      summary: c.summary?.(clean) ?? {},
      progress: { percent: 0, stage: 'Queued' },
      outputs: [],
      measurements: {},
    };
    this.jobs.set(id, job);
    this.save(job);
    this.log(id, `Added to queue: ${c.name}`);
    this.yieldFor(job);
    this.changed();
    this.wake?.();
    return job;
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) throw new UserError('Job not found.');
    if (job.status === 'waiting') {
      job.status = 'cancelled';
      job.end = new Date().toISOString();
      job.progress = { ...job.progress, stage: 'Cancelled' };
      this.save(job);
      this.log(id, 'Cancelled while queued.');
      this.changed();
      return job;
    }
    if (job.status === 'paused') {
      job.status = 'cancelled';
      job.yielded = false;
      job.end = new Date().toISOString();
      job.progress = { ...job.progress, stage: 'Cancelled', detail: '' };
      this.save(job);
      this.log(id, 'Cancelled while paused.');
      this.changed();
      return job;
    }
    if (job.status === 'running' && this.active?.job.id === id) {
      // A cancelled job does not come back by yielding or at shutdown
      job.yielded = false;
      this.active.cancel = true;
      this.log(id, 'Cancel requested; stopping the running step.');
      job.progress = { ...job.progress, detail: 'Cancelling…' };
      this.active.control.abort();
      this.changed();
      return job;
    }
    throw new UserError('This job has already finished.');
  }

  /**
   * Pauses the running job: the process stops, the graphics card and RAM are freed. Only for job types that keep a
   * checkpoint (runner.pausable): "Resume" (tryAgain) goes on from the last checkpoint.
   */
  pause(id) {
    const job = this.jobs.get(id);
    if (!job) throw new UserError('Job not found.');
    if (!this.runners[job.type]?.pausable) throw new UserError('This job type cannot be paused; you can cancel and try again.');
    if (job.status !== 'running' || this.active?.job.id !== id) throw new UserError('Only a running job can be paused.');
    this.active.pause = true;
    this.log(id, 'Pause requested; stopping the process (last checkpoint is kept).');
    job.progress = { ...job.progress, detail: 'Pausing…' };
    this.active.control.abort();
    this.changed();
    return job;
  }

  tryAgain(id) {
    const job = this.jobs.get(id);
    if (!job) throw new UserError('Job not found.');
    if (!['error', 'cancelled', 'interrupted', 'paused'].includes(job.status)) throw new UserError('Only a failed, cancelled, interrupted or paused job can be retried.');
    const proceed = job.status === 'paused';
    job.yielded = false;
    job.status = 'waiting';
    job.error = null;
    job.errorDetail = null;
    job.againTrial = (job.againTrial ?? 0) + 1;
    job.creationPosition = new Date().toISOString();
    job.progress = { percent: 0, stage: proceed ? 'Queued (resume)' : 'Queued (retry)' };
    this.save(job);
    this.log(id, proceed ? 'Queued to resume where it left off.' : 'Queued for retry.');
    // a job coming back with "Resume / Retry" does not wait behind a running unbounded collection either
    this.yieldFor(job);
    this.changed();
    this.wake?.();
    return job;
  }

  /** A new name for the job's cards (gallery, recent, chat); the input, the outputs and their files stay as they were. */
  rename(id, title) {
    const job = this.jobs.get(id);
    if (!job) throw new UserError('Job not found.');
    job.summary = { ...(job.summary ?? {}), title };
    this.save(job);
    this.log(id, `Renamed: ${title}`);
    this.changed();
    return job;
  }

  async remove(id) {
    const job = this.jobs.get(id);
    if (!job) throw new UserError('Job not found.');
    if (job.status === 'running') throw new UserError('A running job cannot be deleted; cancel it first.');
    const folder = resolve(this.folder(id));
    if (!folder.startsWith(resolve(this.setting.outputRoot) + sep) || !ID.test(id)) throw new UserError('Invalid job.');
    // A job whose folder is already gone: only its record goes
    if (existsSync(join(folder, 'job.json'))) {
      // Only a folder the panel made: its job.json carries the panel mark.
      const record = JSON.parse(readFileSync(join(folder, 'job.json'), 'utf8'));
      if (record.panel !== 1 || record.id !== id) throw new UserError('This folder does not belong to the panel; not deleted.');
      if (this.setting.deletionMethod === 'permanent') rmSync(folder, { recursive: true, force: true });
      else await moveToRecycleBin(folder);
    }
    this.jobs.delete(id);
    this.logs.delete(id);
    this.db?.deleteJob(id);
    this.averageCache = null;
    this.changed();
  }

  /** Waiting jobs: the ones with an end first (in the order they came), unbounded yielding jobs (long data collection) last. */
  pending() {
    const long = (job) => (this.runners[job.type]?.yields && this.runners[job.type]?.isLong?.(job.input) ? 1 : 0);
    return [...this.jobs.values()]
      .filter((job) => job.status === 'waiting')
      .sort((a, b) => long(a) - long(b) || (a.creationPosition ?? a.creation).localeCompare(b.creationPosition ?? b.creation));
  }

  list({ type, status, limit = 500 } = {}) {
    if (this.db) return this.page({ type, statuses: status ? [status] : null, limit }).jobs;
    return [...this.jobs.values()]
      .filter((job) => (!type || job.type === type) && (!status || job.status === status))
      .sort((a, b) => b.creation.localeCompare(a.creation))
      .slice(0, limit);
  }

  /** A filtered page (from the database): { jobs, total }. Read-aloud jobs only when asked for by type (not in the gallery). */
  page({ type, statuses, limit = 24, skip = 0 } = {}) {
    const exclude = type ? [] : HIDDEN_TYPES;
    if (!this.db) {
      const all = [...this.jobs.values()].filter((job) => (type ? job.type === type : !exclude.includes(job.type)) && (!statuses || statuses.includes(job.status))).sort((a, b) => b.creation.localeCompare(a.creation));
      return { jobs: all.slice(skip, skip + limit), total: all.length };
    }
    const { ids, total } = this.db.jobQuery({ type, statuses, limit, skip, exclude });
    return { jobs: ids.map((id) => this.jobs.get(id)).filter(Boolean), total };
  }

  /** Durations measured on this machine (the median of the last 8): the interface shows estimates. */
  averages() {
    if (this.db) return (this.averageCache ??= this.db.averages());
    const batch = {};
    const ordered = [...this.jobs.values()].filter((job) => job.measurements).sort((a, b) => a.creation.localeCompare(b.creation));
    for (const job of ordered) {
      for (const [key, value] of Object.entries(job.measurements)) {
        (batch[key] ??= []).push(value);
      }
    }
    const result = {};
    for (const [key, list] of Object.entries(batch)) {
      const last = list.slice(-8).sort((a, b) => a - b);
      result[key] = Math.round(last[Math.floor(last.length / 2)] * 10) / 10;
    }
    return result;
  }

  /* ── Starting ComfyUI ──────────────────────────────────────────────── */

  startComfy() {
    if (Date.now() - this.comfyStartup < this.setting.comfyReadyWait) return false;
    this.comfyStartup = Date.now();
    if (this.setting.startComfy) {
      this.setting.startComfy();
      return true;
    }
    if (!existsSync(this.setting.comfyLauncher)) throw new UserError(`ComfyUI launcher missing: ${this.setting.comfyLauncher}`);
    // the lip sync patch loads as fp16 (comfyPatch in comfy-process.mjs; left alone if the block changed)
    if (this.comfy?.comfyFolder && comfyPatch(this.comfy.comfyFolder) === 'applied') console.log('ComfyUI: InfiniteTalk patch will load as fp16 (dtype added to nodes_model_patch.py).');
    if (this.comfy?.comfyFolder && comfyPaths(this.comfy.comfyFolder) === 'applied') console.log('ComfyUI: lip sync folders added to extra_model_paths.yaml (audio_encoders, model_patches).');
    // Default: no window, output to <ai>\logs\comfyui.log (opened from the tray icon; at 20 MB the old one becomes .1).
    // setting.comfyWindow: in its own minimised window.
    let command = `start "ComfyUI" /min "${this.setting.comfyLauncher}"`;
    if (!this.setting.comfyWindow) {
      const logFolder = this.setting.logRoot ?? join(this.setting.aiRoot, 'logs');
      const logPath = join(logFolder, 'comfyui.log');
      mkdirSync(logFolder, { recursive: true });
      try {
        if (statSync(logPath).size > 20 * 2 ** 20) renameSync(logPath, `${logPath}.1`);
      } catch {
        /* no log yet, or in use */
      }
      command = `""${this.setting.comfyLauncher}" >> "${logPath}" 2>&1"`;
    }
    // NOT detached without a window: a detached process opens a new console and the default terminal of Windows 11
    // (Windows Terminal) ignores windowsHide and shows a window. It shares the panel's (hidden) console.
    // Memory flags from Settings > Fine settings (the ComfyUI launcher reads AI_COMFY_MEMORY; "none": no flags)
    const c = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', command], {
      cwd: this.setting.aiRoot,
      env: { ...process.env, AI_COMFY_MEMORY: comfyFlags() || 'none' },
      detached: Boolean(this.setting.comfyWindow),
      stdio: 'ignore',
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
    // Without a window cmd lives as long as ComfyUI: when it ends (a crash) the start lock goes; a waiting job does not
    // wait 240 s for a dead ComfyUI, the next job can start it again. (With a window "start" returns at once.)
    if (!this.setting.comfyWindow) {
      const startup = this.comfyStartup;
      c.on('exit', () => {
        if (this.comfyStartup === startup) {
          this.comfyStartup = 0;
          this.comfyCrash = Date.now();
        }
      });
    }
    c.unref();
    return true;
  }

  comfyStarting() {
    return Date.now() - this.comfyStartup < this.setting.comfyReadyWait;
  }

  /* ── Running ───────────────────────────────────────────────────────── */

  start() {
    this.loop().catch((e) => console.error('Queue loop stopped:', e));
  }

  async stop() {
    this.closed = true;
    this.wake?.();
    if (this.active) {
      const { job, control } = this.active;
      this.log(job.id, 'Panel closing: stopping the job.');
      control.abort();
    }
  }

  async loop() {
    while (!this.closed) {
      const next = this.pending()[0];
      if (!next) {
        // Jobs that yielded: the one with an end first (a collection cut off midway), unbounded last; the older first on a tie
        const long = (job) => (this.runners[job.type]?.isLong?.(job.input) ? 1 : 0);
        const yielder = [...this.jobs.values()]
          .filter((job) => job.status === 'paused' && job.yielded)
          .sort((a, b) => long(a) - long(b) || (a.creation ?? '').localeCompare(b.creation ?? ''))[0];
        if (yielder) {
          try {
            this.log(yielder.id, 'Queue is empty; resuming where it left off.');
            this.tryAgain(yielder.id);
          } catch (e) {
            // the record could not be written (disk full, permissions): the job fails, the queue does not stop
            console.error('Queue: yielded job could not be resumed:', e);
            yielder.yielded = false;
            yielder.status = 'error';
            yielder.error = `Could not resume: ${e.message}`;
            this.changed();
          }
          continue;
        }
        this.idleSchedule();
        await new Promise((ok) => {
          this.wake = ok;
        });
        this.wake = null;
        clearTimeout(this.idleTimer);
        continue;
      }
      try {
        await this.runJob(next);
      } catch (e) {
        // runJob handles its own errors; what falls through here (e.g. disk full, the record could not be written)
        // fails the job and the loop goes on: otherwise the same job was picked every round and locked the queue.
        console.error('Queue: job could not be run:', e);
        this.active = null;
        next.status = 'error';
        next.error = `Job could not be started: ${e.message}`;
        try {
          this.save(next);
        } catch {
          this.db?.writeJob(next);
        }
        this.changed();
      }
    }
  }

  /**
   * Closes ComfyUI N minutes after the queue empties: an idle ComfyUI holds 4-5 GB of RAM (a risk of freezing on a
   * 16 GB machine). When a job comes, ComfyUI starts by itself anyway.
   * With jobs in ComfyUI's own queue (used from outside the panel) it does not close and waits again.
   */
  idleSchedule() {
    clearTimeout(this.idleTimer);
    const min = Number(this.idleCloseMin?.() ?? 0);
    if (!(min > 0)) return;
    this.idleTimer = setTimeout(() => {
      this.closeIdle().catch((e) => console.error('Idle ComfyUI shutdown:', e.message));
    }, min * 60000);
    this.idleTimer.unref?.();
  }

  async closeIdle() {
    if (this.closed || this.active || this.pending().length) return;
    if (!(await this.comfy.isReady())) {
      this.idleSchedule(); // off now; if it is opened by hand later, it closes again when idle
      return;
    }
    const q = await this.comfy.queue().catch(() => null);
    if (!q || q.running.length || q.pending.length) {
      this.idleSchedule();
      return;
    }
    if (this.active || this.pending().length) return;
    const pids = await (this.setting.closeComfy ?? closeComfy)();
    this.comfyStartup = 0;
    if (pids.length) {
      this.comfyIdleClosed = new Date().toISOString();
      console.log(`ComfyUI was shut down because it was idle (${pids.length} processes); it reopens when a job arrives.`);
      this.changed();
    }
  }

  /**
   * While the graphics card is used outside the panel (another AI program, a game) the job waits before it starts:
   * two big models do not fit in VRAM/RAM together. The panel's and ComfyUI's own processes do not count.
   * Tests do not look at the real nvidia-smi (off with a fake gpuStatus; setting.gpuWatchdog can give one).
   */
  async waitGpuPosition(job, ctx, signal) {
    const watchdog = this.setting.gpuWatchdog !== undefined ? this.setting.gpuWatchdog : this.setting.gpuStatus ? null : isGpuBusy;
    if (!watchdog || !fineSetting('foreignGpu')) return;
    let warned = false;
    for (;;) {
      if (signal.aborted) throw new CancelError();
      let status = null;
      try {
        const comfyOpen = await this.comfy.isReady().catch(() => false);
        const ourPids = comfyOpen ? (await comfyProcesses()).map((s) => s.pid) : [];
        status = await watchdog({ ourPids, comfyOpen, measureGpu });
      } catch {
        return; // no waiting when it cannot be measured
      }
      if (!status) {
        if (warned) this.log(job.id, 'The graphics card is free; the job is starting.');
        return;
      }
      if (!warned) this.log(job.id, status.reason);
      warned = true;
      ctx.progress({ percent: 0, stage: 'Waiting for the graphics card', detail: status.reason });
      await WAIT(10000, signal);
    }
  }

  /**
   * With little free RAM (a 16 GB machine with a crowded Chrome) the model spills into RAM and the same job takes 3
   * times as long: the user is warned, it waits at most setting.ramWait ms, then starts anyway (the queue never jams).
   * Off in tests (with a fake gpuStatus); setting.ramWatchdog can give one.
   */
  async waitRam(job, ctx, signal) {
    const measure = this.setting.ramWatchdog !== undefined ? this.setting.ramWatchdog : this.setting.gpuStatus ? null : () => freemem() / 2 ** 30;
    if (!measure || !fineSetting('waitRam')) return;
    const threshold = this.setting.ramThresholdGb ?? 4;
    const last = Date.now() + (this.setting.ramWait ?? 60000);
    let free = measure();
    if (free >= threshold) return;
    const reason = `Low free RAM (${free.toFixed(1)} GB, recommended ${threshold} GB): close programs such as browser tabs and games, or the job may be very slow.`;
    this.log(job.id, reason);
    while (free < threshold && Date.now() < last) {
      if (signal.aborted) throw new CancelError();
      ctx.progress({ percent: 0, stage: 'Waiting for RAM', detail: reason });
      await WAIT(5000, signal);
      free = measure();
    }
    this.log(job.id, free >= threshold ? `Enough RAM (${free.toFixed(1)} GB); job starting.` : `RAM still low (${free.toFixed(1)} GB); starting the job anyway.`);
  }

  async runJob(job) {
    const c = this.runners[job.type];
    const control = new AbortController();
    this.active = { job, control };
    job.status = 'running';
    job.start = new Date().toISOString();
    job.end = null;
    job.error = null;
    job.outputs = [];
    job.progress = { percent: 0, stage: 'Starting' };
    this.save(job);
    this.changed();
    this.log(job.id, `Started (${this.setting.machine})`);
    const ctx = this.context(job, control.signal);
    try {
      if (!c.gpuNotNeeded) {
        // An idle text model (e.g. the last query of a yielding collection) does not hold RAM and VRAM: released before
        // the checks. Otherwise the RAM watchdog waited for nothing with "close the browsers" (05.10.2026: Gemma 11 GB
        // VRAM + ~5 GB RAM). With the gpuShare fine setting off (a big card) the text model stays on the card.
        if (fineSetting('gpuShare')) {
          // a chat answer being written finishes first (its next step waits for this job): the job says why it waits
          const told = this.llm?.ongoing > 0;
          if (told) ctx.progress({ detail: 'The text model is finishing an answer; then the job starts' });
          await this.llm?.releaseGpu?.();
          if (told) ctx.progress({ detail: '' });
        }
        await this.waitGpuPosition(job, ctx, control.signal);
        await this.waitRam(job, ctx, control.signal);
      }
      await c.run(ctx);
      if (control.signal.aborted) throw new CancelError();
      job.status = 'done';
      job.progress = { percent: 100, stage: 'Done' };
    } catch (e) {
      if ((e instanceof CancelError || control.signal.aborted) && this.active?.pause && !this.closed) {
        job.status = 'paused';
        job.progress = { ...job.progress, stage: job.yielded ? 'Yielded the queue (resumes once the queue is empty)' : 'Paused', detail: '' };
        this.log(job.id, job.yielded ? 'Yielded the queue to another job; resumes automatically when it finishes.' : 'Paused. "Resume" continues from the last checkpoint.');
      } else if ((e instanceof CancelError || control.signal.aborted) && this.closed && c.yields && !this.active?.cancel) {
        // a clean shutdown (Ctrl+C, the window): a yielding job goes on by itself when the panel opens
        job.status = 'paused';
        job.yielded = true;
        job.progress = { ...job.progress, stage: 'Panel closed; resumes when it opens', detail: '' };
        this.log(job.id, 'Stopped while the panel was closing; resumes where it left off when it opens.');
      } else if (e instanceof CancelError || control.signal.aborted) {
        job.status = this.closed ? 'interrupted' : 'cancelled';
        job.progress = { ...job.progress, stage: this.closed ? 'Interrupted' : 'Cancelled', detail: '' };
        if (this.closed) job.error = 'Stopped when the panel closed. "Retry" continues where it left off.';
        this.log(job.id, this.closed ? 'Stopped when the panel closed.' : 'Cancelled.');
      } else {
        const { message, detail } = friendlyError(e);
        job.status = 'error';
        job.error = message;
        job.errorDetail = detail?.slice(0, 8000) ?? null;
        job.progress = { ...job.progress, detail: '' };
        this.log(job.id, `ERROR: ${message}`);
        if (detail) this.log(job.id, `Details: ${detail.slice(0, 4000)}`);
      }
    } finally {
      // the job is over (an error too): workers left behind get the abort signal and make no new model call / crawl
      if (!control.signal.aborted) control.abort();
      this.cleanComfy(job.id);
      job.end = new Date().toISOString();
      job.duration = Math.round((Date.parse(job.end) - Date.parse(job.start)) / 100) / 10;
      this.active = null;
      try {
        this.save(job);
      } catch {
        /* the folder was deleted */
      }
      this.changed();
      this.log(job.id, `Status: ${job.status} (${job.duration} s)`);
    }
  }

  /**
   * Traces left on the ComfyUI side: the output\panel\<id> folder left EMPTY once the outputs are moved, and the
   * inputs this job uploaded (input\panel_<id>_*). A folder that is not empty is left alone (rmdir needs it empty).
   */
  cleanComfy(id) {
    const root = this.comfy?.comfyFolder;
    if (!root) return;
    try {
      rmdirSync(join(root, 'output', 'panel', id));
    } catch {
      /* missing or not empty */
    }
    try {
      for (const d of readdirSync(join(root, 'input'))) if (d.startsWith(`panel_${id}_`)) unlinkSync(join(root, 'input', d));
    } catch {
      /* */
    }
  }

  /** The context given to a runner. */
  context(job, signal) {
    const queue = this;
    const ctx = {
      job,
      folder: this.folder(job.id),
      setting: this.setting,
      // The local text model (sorting collected data): a call from inside a job does not wait for the GPU.
      llm: this.llm ?? null,
      // An upload (a video source, an image to edit, a song's audio) comes before runComfy: when ComfyUI closed while
      // idle it opens it first, otherwise the job failed at once with "could not connect".
      comfy: Object.assign(Object.create(this.comfy), {
        load: async (path, name = basename(path), subFolder = '') => {
          await ctx.prepareComfy();
          // an old upload or a JPEG from the API with an EXIF orientation: ComfyUI reads a mirrored one the wrong way.
          const direction = exifOrientation(path);
          if (direction !== 1 && this.setting.ffmpeg) {
            const flat = join(ctx.folder, `yon-${basename(path, extname(path))}.png`);
            try {
              if (!existsSync(flat)) await fixOrientation(this.setting.ffmpeg, path, flat, direction, { signal });
              return this.comfy.load(flat, `${basename(name, extname(name))}.png`, subFolder);
            } catch (e) {
              if (signal?.aborted) throw e;
              ctx.log(`Image orientation could not be fixed, sending as is: ${e.message}`);
            }
          }
          return this.comfy.load(path, name, subFolder);
        },
      }),
      mod: this.mod,
      signal,
      log: (m) => this.log(job.id, m),
      save: () => this.save(job),
      progress: (d) => {
        job.progress = { ...job.progress, ...d, percent: Math.max(0, Math.min(100, Math.round((d.percent ?? job.progress?.percent ?? 0) * 10) / 10)) };
        if (d.stage && d.stage !== job.progress.lastStage) {
          job.progress.lastStage = d.stage;
          queue.log(job.id, `Stage: ${d.stage}`);
        }
        queue.changed();
        queue.save(job, false);
      },
      addOutput: (c) => {
        job.outputs.push(c);
        queue.save(job);
        queue.changed();
      },
      // model training put a new gguf among the text models: the list in Settings > Text model is refreshed (the choice stays).
      refreshTextModels: () => {
        if (!this.llm?.info?.bin) return;
        const fresh = findLlm(this.setting.aiRoot, this.llm.info.file);
        if (fresh) this.llm.info = { ...this.llm.info, models: fresh.models };
      },
      // many outputs (hundreds of scene clips) are added with one write.
      addOutputs: (list) => {
        job.outputs.push(...list);
        queue.save(job);
        queue.changed();
      },
      measure: (key, value) => {
        if (Number.isFinite(value) && value > 0) {
          job.measurements[key] = Math.round(value * 10) / 10;
          this.db?.writeMeasurement(key, job.measurements[key], job.id);
          this.averageCache = null;
        }
      },
      // When ComfyUI is off it opens in the background without waiting (film: ready while the voice-over runs).
      // Measured 07.10.2026: the 42 s start was waited for at the start of the image stage. If it fails, prepareComfy tries again.
      comfyBeforehand: async () => {
        try {
          if (await this.comfy.isReady()) return;
          if (this.startComfy()) this.log(job.id, 'ComfyUI is starting in the background (to be ready while the voice-over runs).');
        } catch (e) {
          this.log(job.id, `ComfyUI could not be started early: ${e.message}`);
        }
      },
      prepareComfy: async () => {
        // a text model on the graphics card closes first (both do not fit; it stays with the gpuShare fine setting off).
        if (fineSetting('gpuShare')) await this.llm?.releaseGpu();
        if (await this.comfy.isReady()) return;
        ctx.progress({ detail: 'ComfyUI is off, starting…' });
        this.log(job.id, this.comfyStarting() ? 'ComfyUI is starting; waiting until it is ready.' : 'ComfyUI was off; started.');
        this.startComfy();
        const startedAt = Date.now();
        while (Date.now() - startedAt < this.setting.comfyReadyWait) {
          await WAIT(2000, signal);
          // the launcher process ended (ComfyUI crashed while starting): fail without waiting 240 s; the next job starts it again
          if (this.comfyCrash > startedAt && !(await this.comfy.isReady())) throw new Error('ComfyUI closed while starting (it may have crashed); details in logs\\comfyui.log. "Retry" restarts it.');
          if (await this.comfy.isReady()) {
            this.log(job.id, `ComfyUI ready (${Math.round((Date.now() - startedAt) / 1000)} s).`);
            return;
          }
          ctx.progress({ detail: `ComfyUI starting… ${Math.round((Date.now() - startedAt) / 1000)} s` });
        }
        throw new Error(`ComfyUI did not start within ${Math.round(this.setting.comfyReadyWait / 1000)} s (ECONNREFUSED). Check the errors in the ComfyUI window.`);
      },
      /**
       * Runs the graph in ComfyUI; the progress is placed inside 'range' (percent).
       * Nodes that report step progress (KSampler, RIFE) get equal shares.
       */
      runComfy: async (graph, option) => {
        // When GPU memory runs out, ComfyUI's memory is freed and the same request is sent once more. 07.10.2026: an
        // 11 minute film failed on one momentary VRAM error (10 GB free on the card, a 1.4 GB request refused).
        try {
          return await ctx.comfyRequest(graph, option);
        } catch (e) {
          if (signal?.aborted || !isOutOfVram(e)) throw e;
          this.log(job.id, `Not enough GPU memory${e.info?.node_type ? ` (${e.info.node_type})` : ''}; freeing ComfyUI memory and retrying the same step once.`);
          await this.llm?.releaseGpu();
          try {
            await this.comfy.flush();
          } catch (b) {
            this.log(job.id, `ComfyUI memory could not be freed: ${b.message}`);
          }
          await WAIT(3000, signal);
          return ctx.comfyRequest(graph, option);
        }
      },
      comfyRequest: async (graph, { stage, range = [0, 100] }) => {
        await ctx.prepareComfy();
        const cls = classes(graph);
        const stepped = Object.keys(graph).filter((id) => /^KSampler(Advanced)?$|^RIFE VFI$|^SamplerCustomAdvanced$|^TrainLoraNode$/.test(cls[id]));
        const shares = new Map(stepped.map((id) => [id, 0]));
        const [a, b] = range;
        const percent = () => a + ((b - a) * [...shares.values()].reduce((t, x) => t + x, 0)) / Math.max(1, shares.size);
        ctx.progress({ percent: a, stage, detail: 'Sending to ComfyUI' });
        const id = await this.comfy.send(graph);
        this.log(job.id, `ComfyUI request ${id}: ${Object.keys(graph).length} nodes`);
        job.comfyRequest = id;
        let current = null;
        let stepText = '';
        const startedAt = Date.now();
        // node times: a node lasts until the next one starts (or the request ends).
        const durations = [];
        let nodeStart = null;
        const closeNode = () => {
          if (nodeStart) durations.push({ id: nodeStart.id, sec: (Date.now() - nodeStart.t) / 1000 });
          nodeStart = null;
        };
        const result = await this.comfy.wait(id, {
          signal,
          progress: (o) => {
            if (o.type === 'position') ctx.progress({ stage, detail: o.inFront > 0 ? `Waiting in the ComfyUI queue (${o.inFront} jobs ahead)` : 'In the ComfyUI queue' });
            if (o.type === 'started') ctx.progress({ stage, detail: 'Started' });
            if (o.type === 'done') closeNode();
            if (o.type === 'node') {
              closeNode();
              nodeStart = { id: o.node, t: Date.now() };
              // the previous stepped node is over: its share counts in full.
              if (current && shares.has(current) && current !== o.node) shares.set(current, 1);
              current = o.node;
              stepText = '';
              ctx.progress({ percent: percent(), stage, detail: nodeName(cls[o.node]) });
            }
            if (o.type === 'step') {
              const d = o.node ?? current;
              if (d && shares.has(d) && o.max > 0) shares.set(d, Math.min(1, o.value / o.max));
              const position = stepped.length > 1 && d ? ` ${stepped.indexOf(d) + 1}/${stepped.length}` : '';
              stepText = `${nodeName(cls[d] ?? 'KSampler')}${position} · ${o.value}/${o.max}`;
              ctx.progress({ percent: percent(), stage, detail: stepText });
            }
          },
        });
        closeNode();
        this.log(job.id, `ComfyUI finished: ${Math.round((Date.now() - startedAt) / 1000)} s`);
        const durationSummary = nodeDurationSummary(durations, cls);
        if (durationSummary) this.log(job.id, `Node times (s): ${durationSummary}`);
        ctx.progress({ percent: b, stage, detail: 'Fetching outputs' });
        return result;
      },
      /**
       * Before a voice-over: wait for any other job in ComfyUI to finish, then free VRAM with /free and measure that it
       * was freed (two models do not fit on the graphics card at once).
       */
      flushVoiceForGpu: async () => {
        // with the flushGpu fine setting off (a big card) ComfyUI and the text model stay in memory
        if (!fineSetting('flushGpu')) {
          this.log(job.id, 'Fine setting: the graphics card was not freed (ComfyUI and the text model stay in memory).');
          return;
        }
        await this.llm?.releaseGpu();
        if (!(await this.comfy.isReady())) {
          this.log(job.id, 'ComfyUI is off: VRAM is already free.');
          return;
        }
        let warned = false;
        for (;;) {
          let q;
          try {
            q = await this.comfy.queue();
          } catch {
            break;
          }
          if (!q.running.length && !q.pending.length) break;
          if (!warned) this.log(job.id, `ComfyUI has ${q.running.length + q.pending.length} jobs; waiting for them to finish.`);
          warned = true;
          ctx.progress({ detail: 'Voice-over will start once the job in ComfyUI finishes' });
          await WAIT(3000, signal);
        }
        const measure = this.setting.gpuStatus ?? measureGpu;
        const once = await measure();
        await this.comfy.flush().catch(() => false);
        ctx.progress({ detail: 'Freeing ComfyUI memory (/free)' });
        let after = once;
        let previous = null;
        for (let i = 0; i < 20; i++) {
          await WAIT(1000, signal);
          after = await measure();
          if (!after || !once) break;
          if (previous && Math.abs(previous.memoryUsedMb - after.memoryUsedMb) < 64 && after.memoryUsedMb < once.memoryUsedMb - 64) break;
          if (previous && i >= 3 && Math.abs(previous.memoryUsedMb - after.memoryUsedMb) < 64) break;
          previous = after;
        }
        if (once && after) this.log(job.id, `VRAM ComfyUI /free: ${once.memoryUsedMb} → ${after.memoryUsedMb} MB`);
        else this.log(job.id, 'Sent ComfyUI /free (no nvidia-smi, VRAM not measured).');
      },
    };
    return ctx;
  }

  /** The job summary for the interface. At most OUTPUT_LIMIT outputs (thousands of scene clips would bloat the polling). */
  summary(job, { log = false } = {}) {
    const all = job.outputs ?? [];
    const o = {
      id: job.id,
      type: job.type,
      // the shown name comes from the server: an interface that does not know a new job type does not write "undefined".
      typeName: this.runners[job.type]?.name ?? job.type,
      // paused only to let other jobs run first: it goes on by itself
      ...(job.yielded ? { yielded: true } : {}),
      pausable: Boolean(this.runners[job.type]?.pausable),
      status: job.status,
      creation: job.creation,
      start: job.start ?? null,
      end: job.end ?? null,
      duration: job.duration ?? null,
      summary: job.summary ?? {},
      progress: job.progress ?? {},
      error: job.error ?? null,
      voiceName: job.voiceName ?? null,
      modelFiles: job.modelFiles ?? [],
      outputCount: all.length,
      outputs: all.slice(0, OUTPUT_LIMIT).map((c) => ({
        ...c,
        url: `/file/job/${job.id}/${c.file}`,
        previewUrl: c.preview ? `/file/job/${job.id}/${c.preview}` : null,
        source: `job/${job.id}/${c.file}`,
      })),
    };
    if (log) {
      o.log = this.lastLog(job.id, 60);
      o.input = job.input;
      o.errorDetail = job.errorDetail ?? null;
      o.stages = job.stages ?? null;
    }
    return o;
  }
}
