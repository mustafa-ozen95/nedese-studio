/**
 * ComfyUI API istemcisi: istek gonderme, websocket ile ilerleme, gecmisle sonuc,
 * kesme (interrupt), VRAM bosaltma (/free), girdi yukleme, cikti alma.
 *
 * Sonuc icin dogruluk kaynagi /history (araclar\comfy.mjs'teki calistir() gibi);
 * websocket yalnizca ilerleme icindir: koparsa is yine biter, yalnizca adim sayisi gorunmez.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ComfyRuntimeError, ComfyValidationError, CancelError } from './errors.mjs';

const wait = (ms, signal) =>
  new Promise((ok, red) => {
    if (signal?.aborted) {
      red(new CancelError());
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', cancel);
      ok();
    }, ms);
    const cancel = () => {
      clearTimeout(t);
      red(new CancelError());
    };
    signal?.addEventListener('abort', cancel, { once: true });
  });

export class ComfyClient {
  constructor({ address = 'http://127.0.0.1:8188', comfyFolder = null, id = `ai-panel-${randomUUID().slice(0, 8)}` } = {}) {
    this.address = address.replace(/\/$/, '');
    this.comfyFolder = comfyFolder;
    this.id = id;
    this.listeners = new Map();
    this.ws = null;
    this.wsStatus = 'closed';
  }

  async req(path, { method = 'GET', json, body, timeTimeout = 15000 } = {}) {
    const option = { method, signal: AbortSignal.timeout(timeTimeout) };
    if (json !== undefined) {
      option.headers = { 'Content-Type': 'application/json' };
      option.body = JSON.stringify(json);
    } else if (body !== undefined) {
      option.body = body;
    }
    return fetch(`${this.address}${path}`, option);
  }

  async isReady() {
    try {
      return (await this.req('/system_stats', { timeTimeout: 2500 })).ok;
    } catch {
      return false;
    }
  }

  async system() {
    const r = await this.req('/system_stats', { timeTimeout: 3000 });
    return r.json();
  }

  /** { calisan: [id], bekleyen: [id] } (bekleyen ComfyUI sira numarasina gore). */
  async queue() {
    const j = await (await this.req('/queue', { timeTimeout: 5000 })).json();
    const sort = (l) => [...(l ?? [])].sort((a, b) => a[0] - b[0]).map((x) => x[1]);
    return { running: sort(j.queue_running), pending: sort(j.queue_pending) };
  }

  /** Grafi kuyruga koyar, prompt_id doner. Dogrulama hatasi -> ComfyDogrulamaHatasi. */
  async send(job) {
    this.wsConnect();
    const r = await this.req('/prompt', { method: 'POST', json: { prompt: job, client_id: this.id }, timeTimeout: 60000 });
    let j;
    try {
      j = await r.json();
    } catch {
      j = { error: { message: `HTTP ${r.status}` } };
    }
    if (!r.ok || j.error || (j.node_errors && Object.keys(j.node_errors).length)) throw new ComfyValidationError(j);
    return j.prompt_id;
  }

  /**
   * Isin bitmesini bekler; ciktilari ({dugum: {images: [...]}}) doner.
   * progress(event): { type: 'position', inFront } | { type: 'started' } | { type: 'node', node }
   *                  | { type: 'step', node, value, max }
   */
  async wait(id, { signal, progress = () => {}, timeTimeout = 4 * 3600e3 } = {}) {
    this.listeners.set(id, progress);
    const startedAt = Date.now();
    let connectionError = 0;
    let lossCounter = 0;
    let type = 0;
    let started = false;
    try {
      while (Date.now() - startedAt < timeTimeout) {
        try {
          await wait(type === 0 ? 300 : 1500, signal);
        } catch (e) {
          await this.cut(id).catch(() => {});
          throw e;
        }
        type += 1;
        let h;
        try {
          const r = await this.req(`/history/${id}`, { timeTimeout: 10000 });
          h = (await r.json())[id];
          connectionError = 0;
        } catch (e) {
          connectionError += 1;
          // ComfyUI coktu ya da kapandi: birkac deneme sonra vazgec (yanlis alarm olmasin).
          if (connectionError >= 6) throw Object.assign(new Error('Lost connection to ComfyUI (ECONNREFUSED): it may have crashed or been closed.'), { cause: e });
          continue;
        }
        if (h) {
          const status = h.status ?? {};
          if (status.status_str === 'error') throw new ComfyRuntimeError(errorInfo(status.messages));
          if (status.completed || status.status_str === 'success') return h.outputs ?? {};
          continue;
        }
        // Gecmiste yok: kuyrukta mi? Her 3 turda bir bak (sira bilgisi + kayip tespiti).
        if (type % 3 === 1) {
          try {
            const q = await this.queue();
            const position = q.pending.indexOf(id);
            if (q.running.includes(id)) {
              lossCounter = 0;
              if (!started) {
                started = true;
                progress({ type: 'started' });
              }
            } else if (position >= 0) {
              lossCounter = 0;
              progress({ type: 'position', inFront: position + q.running.length });
            } else {
              lossCounter += 1;
              // Ne kuyrukta ne gecmiste: ComfyUI yeniden baslatilmis, is kaybolmus.
              if (lossCounter >= 3) throw Object.assign(new Error('Job not found in the ComfyUI queue (ComfyUI may have restarted).'), { lost: true });
            }
          } catch (e) {
            if (e.lost) throw e;
          }
        }
      }
      throw new Error(`ComfyUI timeout: did not finish within ${Math.round(timeTimeout / 60000)} min.`);
    } finally {
      this.listeners.delete(id);
    }
  }

  /** Kendi isimizi durdurur: calisiyorsa interrupt, sirada bekliyorsa kuyruktan siler. */
  async cut(id) {
    let q;
    try {
      q = await this.queue();
    } catch {
      return false;
    }
    if (q.running.includes(id)) {
      await this.req('/interrupt', { method: 'POST', json: { prompt_id: id } });
      return true;
    }
    if (q.pending.includes(id)) {
      await this.req('/queue', { method: 'POST', json: { delete: [id] } });
      return true;
    }
    return false;
  }

  /** Modelleri bosaltir (seslendirmeden once VRAM). */
  async flush() {
    const r = await this.req('/free', { method: 'POST', json: { unload_models: true, free_memory: true } });
    return r.ok;
  }

  /** Dosyayi ComfyUI input klasorune (altKlasor verilirse onun icine) yukler (LoadImage oradan okur). Doner: dosya adi. */
  async load(path, name = basename(path), subFolder = '') {
    const form = new FormData();
    form.append('image', new Blob([readFileSync(path)]), name);
    form.append('overwrite', 'true');
    form.append('type', 'input');
    if (subFolder) form.append('subfolder', subFolder);
    const r = await this.req('/upload/image', { method: 'POST', body: form, timeTimeout: 120000 });
    if (!r.ok) throw new Error(`ComfyUI image upload failed: HTTP ${r.status}`);
    const j = await r.json();
    return j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
  }

  /**
   * Bir ciktiyi hedefe alir. ComfyUI ayni diskteyse TASIR (output klasoru sismesin),
   * degilse /view ile indirir.
   */
  async getOutput(g, target) {
    mkdirSync(dirname(target), { recursive: true });
    if (this.comfyFolder) {
      const path = join(this.comfyFolder, g.type ?? 'output', g.subfolder ?? '', g.filename);
      if (existsSync(path)) {
        try {
          renameSync(path, target);
        } catch {
          copyFileSync(path, target);
          try {
            unlinkSync(path);
          } catch {
            /* kopya yeter */
          }
        }
        return target;
      }
    }
    const q = new URLSearchParams({ filename: g.filename, subfolder: g.subfolder ?? '', type: g.type ?? 'output' });
    const r = await this.req(`/view?${q}`, { timeTimeout: 120000 });
    if (!r.ok) throw new Error(`Could not fetch ComfyUI output: ${g.filename} (HTTP ${r.status})`);
    writeFileSync(target, Buffer.from(await r.arrayBuffer()));
    return target;
  }

  /** Websocket (ilerleme). Kopunca 3 sn sonra yeniden dener; hata isi durdurmaz. */
  wsConnect() {
    if (this.ws || typeof WebSocket === 'undefined') return;
    const url = `${this.address.replace(/^http/, 'ws')}/ws?clientId=${encodeURIComponent(this.id)}`;
    let ws;
    try {
      ws = new WebSocket(url);
    } catch {
      return;
    }
    this.ws = ws;
    this.wsStatus = 'connecting';
    ws.addEventListener('open', () => {
      this.wsStatus = 'open';
    });
    ws.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return; // ikili onizleme kareleri
      let m;
      try {
        m = JSON.parse(event.data);
      } catch {
        return;
      }
      this.wsMessage(m);
    });
    const closed = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.wsStatus = 'closed';
      if (this.listeners.size) setTimeout(() => this.wsConnect(), 3000);
    };
    ws.addEventListener('close', closed);
    ws.addEventListener('error', () => {
      try {
        ws.close();
      } catch {
        /* */
      }
      closed();
    });
  }

  wsMessage(m) {
    const data = m.data ?? {};
    const listener = this.listeners.get(data.prompt_id);
    if (!listener) return;
    try {
      switch (m.type) {
        case 'execution_start':
          listener({ type: 'started' });
          break;
        case 'executing':
          if (data.node) listener({ type: 'node', node: String(data.node) });
          else listener({ type: 'done' });
          break;
        case 'execution_success':
          listener({ type: 'done' });
          break;
        case 'progress':
          listener({ type: 'step', node: data.node != null ? String(data.node) : null, value: data.value, max: data.max });
          break;
        default:
          break;
      }
    } catch {
      /* izleyici hatasi */
    }
  }

  close() {
    const ws = this.ws;
    this.ws = null;
    this.listeners.clear();
    try {
      ws?.close();
    } catch {
      /* */
    }
  }
}

/** Gecmisteki mesajlardan hata bilgisi (execution_error / execution_interrupted). */
function errorInfo(messages = []) {
  for (const [type, data] of messages) {
    if (type === 'execution_error') return data ?? {};
    if (type === 'execution_interrupted') return { exception_type: 'interrupted', exception_message: 'Interrupted', ...(data ?? {}) };
  }
  return { exception_message: JSON.stringify(messages).slice(0, 2000) };
}

/** Ciktilardaki gorselleri dugum sirasina gore (dugum kimligi -> liste). */
export function images(outputs, node) {
  return [...(outputs?.[node]?.images ?? [])].sort((a, b) => a.filename.localeCompare(b.filename));
}

/** Dugumun ses ciktilari (SaveAudio* dugumleri "audio" anahtariyla dondurur). */
export function voiceOutputs(outputs, node) {
  return [...(outputs?.[node]?.audio ?? [])].sort((a, b) => a.filename.localeCompare(b.filename));
}
