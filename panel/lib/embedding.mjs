/**
 * Text embeddings on the CPU for Knowledge (user request 08.10.2026: document search by meaning, without the GPU): a
 * small multilingual GGUF embedding model in <ai>\llm\embed, served by a llama-server of its own (--embedding) on its
 * own port, every layer on the CPU (-ngl 0, and CUDA_VISIBLE_DEVICES=-1 so the CUDA build sees no card at all: the
 * text, image and video models keep the whole GPU). Started on the first request, closed after idleMs without one.
 * Nothing is downloaded: without a model file Knowledge searches by words alone (BM25).
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { killTree } from './process.mjs';

const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
const freePort = () => new Promise((ok, fail) => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => ok(p));
  });
  s.on('error', fail);
});

/**
 * What a model wants before a query and before a passage (its model card says so; without them the vectors of a
 * question and of its answer lie further apart). Matched on the file name; a model not listed gets none.
 */
const PREFIXES = [
  [/e5/i, { query: 'query: ', passage: 'passage: ' }],
  [/embeddinggemma/i, { query: 'task: search result | query: ', passage: 'title: none | text: ' }],
  [/nomic/i, { query: 'search_query: ', passage: 'search_document: ' }],
  [/qwen3.*embed/i, { query: 'Instruct: Given a search query, retrieve relevant passages that answer the query\nQuery: ', passage: '' }],
];

export function embedPrefixes(file) {
  return PREFIXES.find(([pattern]) => pattern.test(String(file ?? '')))?.[1] ?? { query: '', passage: '' };
}

/** The embedding model file: the first *.gguf in <ai>\llm\embed (by name), or null. */
export function findEmbedModel(aiRoot) {
  const folder = join(aiRoot, 'llm', 'embed');
  if (!existsSync(folder)) return null;
  const file = readdirSync(folder).filter((f) => f.toLowerCase().endsWith('.gguf')).sort()[0];
  if (!file) return null;
  return { file, path: join(folder, file), name: file.replace(/\.gguf$/i, ''), mb: Math.round(statSync(join(folder, file)).size / 2 ** 20) };
}

/** Unit length (cosine is then a dot product). */
export function normalize(v) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return Float32Array.from(v, (x) => x / n);
}

export class EmbedServer {
  /**
   * setting: aiRoot (the model and llama-server), embedCommand(port, model) -> { command, args, env } (tests: a fake
   * server). model: { file, path, name } or null (found in <ai>\llm\embed).
   */
  constructor({ setting, model = undefined, idleMs = 120000, readySec = 90, log = () => {} }) {
    Object.assign(this, { setting, idleMs, readySec, log });
    this.fixed = model; // undefined: the folder is looked at (again after LOOK_MS: a model put there later is used)
    this.found = null;
    this.lookedAt = 0;
    this.proc = null;
    this.port = null;
    this.startup = null;
    this.timer = null;
    this.busy = 0;
  }

  get model() {
    if (this.fixed !== undefined) return this.fixed;
    // none yet: looked for at every use (a missing folder costs one check); one found: again after 30 s
    if (!this.found || Date.now() - this.lookedAt > 30000) {
      this.lookedAt = Date.now();
      const m = findEmbedModel(this.setting.aiRoot);
      // another model file: the running server has the old one
      if (this.found && m?.path !== this.found.path && !this.busy) this.close();
      this.found = m;
    }
    return this.found;
  }

  get available() {
    return Boolean(this.model && (this.setting.embedCommand || existsSync(this.bin())));
  }

  bin() {
    return join(this.setting.aiRoot, 'llm', 'bin', process.platform === 'win32' ? 'llama-server.exe' : 'llama-server');
  }

  command(port) {
    if (this.setting.embedCommand) return this.setting.embedCommand(port, this.model);
    return {
      command: this.bin(),
      // one input at a time, each whole in one batch (an encoder must see all of its tokens at once)
      args: ['-m', this.model.path, '--embedding', '-ngl', '0', '-c', '2048', '-b', '2048', '-ub', '2048', '--parallel', '1', '--host', '127.0.0.1', '--port', String(port)],
      env: { ...process.env, CUDA_VISIBLE_DEVICES: '-1' },
    };
  }

  async healthy() {
    if (!this.port) return false;
    try {
      return (await fetch(`http://127.0.0.1:${this.port}/health`, { signal: AbortSignal.timeout(2000) })).ok;
    } catch {
      return false;
    }
  }

  async start() {
    if (this.proc && (await this.healthy())) return;
    this.startup ??= (async () => {
      if (this.proc) this.close();
      const port = await freePort();
      const { command, args, env } = this.command(port);
      const startedAt = Date.now();
      this.log(`Embedding model starting on the CPU: ${this.model.name}`);
      const proc = spawn(command, args, { windowsHide: true, stdio: 'ignore', env: env ?? process.env });
      this.proc = proc;
      this.port = port;
      proc.on('exit', () => {
        if (this.proc === proc) this.proc = null;
      });
      proc.on('error', () => {
        if (this.proc === proc) this.proc = null;
      });
      while (Date.now() - startedAt < this.readySec * 1000) {
        if (!this.proc) throw new Error('The embedding model could not start (llama-server closed).');
        if (await this.healthy()) {
          this.log(`Embedding model ready (${Math.round((Date.now() - startedAt) / 1000)} s).`);
          return;
        }
        await wait(300);
      }
      this.close();
      throw new Error(`The embedding model did not open within ${this.readySec} s.`);
    })().finally(() => {
      this.startup = null;
    });
    return this.startup;
  }

  /** Vectors (unit length) of the texts, in their order. kind: 'query' | 'passage' (the model's prefix). */
  async embed(texts, { kind = 'passage', signal = null } = {}) {
    if (!this.available) throw new Error('No embedding model (<ai>\\llm\\embed\\*.gguf).');
    clearTimeout(this.timer);
    this.busy += 1;
    try {
      await this.start();
      const prefix = embedPrefixes(this.model.file)[kind] ?? '';
      const r = await fetch(`http://127.0.0.1:${this.port}/v1/embeddings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: texts.map((t) => prefix + t), encoding_format: 'float' }), signal: signal ?? AbortSignal.timeout(300000) });
      if (!r.ok) throw new Error(`Embedding failed: HTTP ${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`);
      const j = await r.json();
      const rows = [...(j.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      if (rows.length !== texts.length) throw new Error(`Embedding failed: ${rows.length} vectors for ${texts.length} texts.`);
      return rows.map((d) => normalize(d.embedding));
    } finally {
      this.busy -= 1;
      if (!this.busy) {
        this.timer = setTimeout(() => this.close(), this.idleMs);
        this.timer.unref?.();
      }
    }
  }

  close() {
    clearTimeout(this.timer);
    const proc = this.proc;
    this.proc = null;
    this.port = null;
    if (proc && proc.exitCode === null) {
      killTree(proc.pid);
      this.log('Embedding model closed.');
    }
  }
}
