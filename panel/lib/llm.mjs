/**
 * Yerel yazi modeli: llama.cpp llama-server + <ai>\llm\modeller\*.gguf (Gemma 4 12B Q5_K_M).
 * Olculdu 04.10.2026 (RTX 5070): Turkce duzeltmede 9/9 hata, 6 dile ceviri dogal, JSON + HTML
 * korunuyor, gorev basina 11-14 sn (~58 token/sn); Qwen3.6-35B-A3B IQ3 (16 GB RAM'e sigan
 * tek niceleme) hata kacirdi, Fransizcada anlam degistirdi.
 *
 * Ekran karti ComfyUI ile paylasilir (model + 16k baglam ~10,6 GB; ikisi birlikte sigmaz):
 *  - Istek gelince: ComfyUI bostaysa bellegi bosaltilir (/free), llama-server baslar (~10 sn).
 *  - Gorsel/video/ses isi GPU'ya gecmeden once gpuBirak(): suren istekler biter, sunucu kapanir.
 *  - Dis istek (bot) bir is calisirken gelirse is bitene kadar bekler (en cok beklemeSn), sonra 503.
 *  - bostaSn boyunca istek gelmezse kapanir.
 * Botlar (DeepSeek yerine): base_url = http://<bu-bilgisayar>:1071/llm/v1, anahtar = panel API anahtari.
 */
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { killTree } from './process.mjs';
import { fineSetting } from './fine-settings.mjs';
import { CancelError } from './errors.mjs';

const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));

/**
 * llama-server'a POST, zaman siniri YOK. fetch (undici) 300 sn'de yanit basligi gelmezse "fetch failed"
 * veriyordu: tek yuvada sirada bekleyen ya da uzun dusunen istek bunu asabiliyor (04.10.2026).
 */
function localPost(port, path, body, signal = null) {
  return new Promise((ok, error) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = request({ host: '127.0.0.1', port, path: path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, (response) => {
      const parts = [];
      response.on('data', (p) => parts.push(p));
      response.on('end', () => ok({ status: response.statusCode, text: Buffer.concat(parts).toString('utf8') }));
      response.on('error', error);
    });
    req.on('error', (e) => error(signal?.aborted ? new CancelError() : e));
    // Iptal (Kuyruk'taki yan gorev): baglanti kapanir, llama-server uretimi birakir
    signal?.addEventListener('abort', () => req.destroy(), { once: true });
    req.end(data);
  });
}

/**
 * Streaming POST (stream: true): every "data:" event of the answer goes to onEvent as parsed JSON. An answer that is
 * not 200 is collected as text like localPost.
 */
function localStream(port, path, body, signal, onEvent) {
  return new Promise((ok, error) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = request({ host: '127.0.0.1', port, path: path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, Accept: 'text/event-stream' } }, (response) => {
      if (response.statusCode !== 200) {
        const parts = [];
        response.on('data', (p) => parts.push(p));
        response.on('end', () => ok({ status: response.statusCode, text: Buffer.concat(parts).toString('utf8') }));
        response.on('error', error);
        return;
      }
      response.setEncoding('utf8');
      let buffer = '';
      response.on('data', (p) => {
        buffer += p;
        let i;
        while ((i = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, i).trim();
          buffer = buffer.slice(i + 1);
          if (!line.startsWith('data:')) continue;
          const d = line.slice(5).trim();
          if (!d || d === '[DONE]') continue;
          try {
            onEvent(JSON.parse(d));
          } catch {
            /* a broken event line: skipped */
          }
        }
      });
      response.on('end', () => ok({ status: 200, text: null }));
      response.on('error', (e) => error(signal?.aborted ? new CancelError() : e));
    });
    req.on('error', (e) => error(signal?.aborted ? new CancelError() : e));
    signal?.addEventListener('abort', () => req.destroy(), { once: true });
    req.end(data);
  });
}

/**
 * Collects streamed chat.completion chunks: text, thinking (reasoning_content), tool calls (fragments by index), finish
 * reason and usage (usage chunk, or llama-server timings). onChunk gets { text } / { thinking } / { tool } as they come.
 */
export function streamCollector(onChunk = () => {}) {
  const acc = { content: '', reasoning: '', tools: [], finish: null, usage: null };
  return {
    event(j) {
      if (j.usage) acc.usage = j.usage;
      else if (j.timings && !acc.usage) acc.usage = { prompt_tokens: (j.timings.prompt_n ?? 0) + (j.timings.cache_n ?? 0), completion_tokens: j.timings.predicted_n ?? 0 };
      const c = j.choices?.[0];
      if (!c) return;
      const d = c.delta ?? {};
      if (d.reasoning_content) {
        acc.reasoning += d.reasoning_content;
        onChunk({ thinking: d.reasoning_content });
      }
      if (d.content) {
        acc.content += d.content;
        onChunk({ text: d.content });
      }
      for (const t of d.tool_calls ?? []) {
        const k = (acc.tools[t.index ?? 0] ??= { id: '', type: 'function', function: { name: '', arguments: '' } });
        if (t.id) k.id = t.id;
        if (t.function?.name) k.function.name += t.function.name;
        if (t.function?.arguments) k.function.arguments += t.function.arguments;
        onChunk({ tool: k.function.name });
      }
      if (c.finish_reason) acc.finish = c.finish_reason;
    },
    result() {
      const tools = acc.tools.filter(Boolean);
      return { choices: [{ index: 0, message: { role: 'assistant', content: acc.content, ...(acc.reasoning ? { reasoning_content: acc.reasoning } : {}), ...(tools.length ? { tool_calls: tools } : {}) }, finish_reason: acc.finish ?? 'stop' }], usage: acc.usage ?? undefined };
    },
  };
}

/**
 * <ai>\llm\bin\llama-server.exe ve llm\modeller\*.gguf; yoksa null. tercih: dosya adi (Ayarlar >
 * Yazi modeli); yoksa ilk dosya. modeller: secim listesi (ad, boyut GiB).
 */
export function findLlm(aiRoot, preference = '') {
  const exe = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  const mainBin = join(aiRoot, 'llm', 'bin', exe);
  // PrismML's quantizations (PQ2_0, PTQ1_0: the Bonsai models) load only in PrismML's llama.cpp build, kept apart in
  // llm\bin-prism (stock llama.cpp cannot read them; measured 08.10.2026: Bonsai 2 27B, 65 tokens/s on the 12 GB card)
  const prismBin = join(aiRoot, 'llm', 'bin-prism', exe);
  const needsPrism = (file) => /[-_.](PQ2_0|PTQ1_0)\.gguf$/i.test(file);
  const folder = join(aiRoot, 'llm', 'models');
  if ((!existsSync(mainBin) && !existsSync(prismBin)) || !existsSync(folder)) return null;
  // Models trained in the panel (Model training, "-trained-") go last: with no choice the ready model stays the default.
  const trained = (d) => (/-trained-/i.test(d) ? 1 : 0);
  const files = readdirSync(folder).filter((d) => d.toLowerCase().endsWith('.gguf') && !/^mmproj|^mtp-/i.test(d)).sort((a, b) => trained(a) - trained(b) || a.localeCompare(b));
  if (!files.length) return null;
  // Gorsel kodlayici (Model egitimi > Genel ya da elle): ayni klasorde mmproj-<model dosyasi> -> llama-server --mmproj
  const models = files.map((d) => ({ file: d, name: d.replace(/\.gguf$/i, ''), gib: Math.round((statSync(join(folder, d)).size / 2 ** 30) * 100) / 100, image: existsSync(join(folder, `mmproj-${d}`)) }));
  const selected = models.find((m) => m.file === preference) ?? models[0];
  const bin = needsPrism(selected.file) ? prismBin : mainBin;
  return { bin, folder, models, model: join(folder, selected.file), name: selected.name, file: selected.file, gib: selected.gib, mmproj: selected.image ? join(folder, `mmproj-${selected.file}`) : null, mmprojGib: selected.image ? Math.round((statSync(join(folder, `mmproj-${selected.file}`)).size / 2 ** 30) * 100) / 100 : 0 };
}

/**
 * Ekran kartina sigmayan MoE uzman katmanlari RAM'de (llama.cpp --n-cpu-moe). Olculdu 04.10.2026:
 * Gemma 4 26B-A4B IQ4_XS (12,66 GiB) 8 katmanla 11,9 GB VRAM + 16k baglam. Katman basina ~0,4 GiB.
 * Kucuk (yogun) modelde 0.
 * Baglam 32k, tek yuva (04.10.2026): dusunme (3072) + uzun yazinin tamami girdi ve cikti olunca 16k
 * asiliyordu ("Context size has been exceeded"); 4 yuva baglami paylasiyordu. 26B QAT + 32k tek yuva 10 katmanla
 * 11,75 GB: Chrome vb. de ekran kartini kullaninca Windows sistem RAM'ine tasiyor, uretim ~60'tan ~4 token/sn'ye
 * dusuyordu; 11 katman 11,34 GB, hiz ayni (63 t/s).
 * Eszamanli istekler sirayla islenir.
 */
/** butce: VRAM butcesi (GiB; 12 GB kartta 10,8: esik 10,5, taban 9,1 olculdu). */
export function moeLayers(gib, budget = VRAM_BUDGET) {
  return gib > budget - 0.3 ? Math.ceil((gib - (budget - 1.7)) / 0.4) : 0;
}

// GGUF deger turlerinin bayt boyu (8 metin, 9 dizi: degisken)
const GGUF_SIZE = [1, 1, 2, 2, 4, 4, 4, 1, 0, 0, 8, 8, 8];
const READ_GGUF = ['readUInt8', 'readInt8', 'readUInt16LE', 'readInt16LE', 'readUInt32LE', 'readInt32LE', 'readFloatLE', 'readUInt8', null, null, 'readBigUInt64LE', 'readBigInt64LE', 'readDoubleLE'];
const ggufCache = new Map();

/**
 * GGUF ust verisi: { mimari, katman, uzman, kvBayt (belirtec basina f16 KV bayti) }. Yalniz dosyanin basindaki
 * anahtar-deger bolumu okunur, sozluk dizileri atlanir (birkac MB). Okunamazsa null.
 */
export function ggufMetadata(file) {
  let fd = null;
  try {
    const { size, mtimeMs } = statSync(file);
    const key = `${file}|${size}|${mtimeMs}`;
    if (ggufCache.has(key)) return ggufCache.get(key);
    fd = openSync(file, 'r');
    let buffer = Buffer.alloc(0);
    let i = 0;
    let position = 0;
    const fill = (n) => {
      if (i + n <= buffer.length) return;
      const chunk = Buffer.alloc(Math.max(1 << 20, n));
      const read = readSync(fd, chunk, 0, chunk.length, position);
      position += read;
      buffer = Buffer.concat([buffer.subarray(i), chunk.subarray(0, read)]);
      i = 0;
      if (buffer.length < n) throw new Error('GGUF shorter than expected');
    };
    const skip = (n) => {
      if (i + n <= buffer.length) i += n;
      else {
        position += i + n - buffer.length;
        buffer = Buffer.alloc(0);
        i = 0;
      }
    };
    const number = (type) => {
      if (!READ_GGUF[type]) throw new Error(`GGUF type ${type}`);
      fill(GGUF_SIZE[type]);
      const v = buffer[READ_GGUF[type]](i);
      i += GGUF_SIZE[type];
      return typeof v === 'bigint' ? Number(v) : v;
    };
    const text = () => {
      const n = number(10);
      fill(n);
      const v = buffer.toString('utf8', i, i + n);
      i += n;
      return v;
    };
    fill(24);
    if (buffer.toString('latin1', 0, 4) !== 'GGUF') return null;
    i = 4;
    if (number(4) < 2) return null; // surum 1: 32 bit sayaclar
    number(10); // tensor sayisi
    const kvCount = number(10);
    const parent = {};
    for (let k = 0; k < kvCount; k++) {
      const name = text();
      const type = number(4);
      if (type === 8) parent[name] = text();
      else if (type === 9) {
        const item = number(4);
        const count = number(10);
        if (item === 8) for (let j = 0; j < count; j++) skip(number(10));
        else if (!READ_GGUF[item]) throw new Error('GGUF nested array');
        else if (count <= 4096) parent[name] = Array.from({ length: count }, () => number(item));
        else skip(count * GGUF_SIZE[item]);
      } else parent[name] = number(type);
    }
    const m = parent['general.architecture'];
    const get = (k) => parent[`${m}.${k}`];
    const layer = get('block_count');
    const headCount = [get('attention.head_count')].flat()[0];
    const kvHeads = get('attention.head_count_kv') ?? headCount;
    // A hybrid model with linear-attention layers (qwen35, Qwen3-Next): only every Nth layer is full attention and keeps
    // a KV cache, the others a small fixed state (Bonsai 2 27B: 64 layers, every 4th; 64k context with q8_0 KV fit in
    // 9.8 GB with the model, measured 08.10.2026; counting all 64 layers gave it only 16k)
    const every = Number(get('full_attention_interval')) > 1 ? Number(get('full_attention_interval')) : 1;
    // The KV heads can be a list, one per layer (hybrid architectures): summed
    const kvHeadTotal = Array.isArray(kvHeads) ? kvHeads.reduce((a, b) => a + b, 0) : kvHeads * Math.ceil(layer / every);
    const defaultHeadSize = get('embedding_length') && headCount ? get('embedding_length') / headCount : null;
    const headSize = (get('attention.key_length') ?? defaultHeadSize) + (get('attention.value_length') ?? get('attention.key_length') ?? defaultHeadSize);
    const result = { architecture: m ?? null, layer: layer ?? null, expert: get('expert_count') ?? 0, kvByte: Number.isFinite(kvHeadTotal * headSize) ? kvHeadTotal * headSize * 2 : null, contextLength: get('context_length') ?? null, slidingWindow: get('attention.sliding_window') ?? null, ...(every > 1 ? { attentionEvery: every } : {}) };
    ggufCache.set(key, result);
    return result;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * Yogun modelde llama-server'a giden model + KV + calisma payi bu butceyi (GiB) asmamali: 12 GB kartta Windows
 * ve masaustu ~0,6 GB tutar; toplam ~11,3 GB'i asinca sistem RAM'ine tasip uretim 60'tan ~4 belirtec/sn'ye dusuyordu.
 */
export const VRAM_BUDGET = 10.8;
const WORK_SHARE = 0.6;

/**
 * Ince ayar llmVram: 'oto' kartin toplam belleginden (nvidia-smi, MiB), yoksa secilen GB. Butce = bellek - 1,14 GiB
 * (12 GB kart: 12227 MiB = 11,94 GiB -> 10,8). Bellek bilinmiyorsa 12 GB kartin butcesi.
 */
export function vramBudget(choice = 'oto', totalMb = null) {
  const gib = choice === 'oto' ? (Number(totalMb) > 0 ? Number(totalMb) / 1024 : null) : Number(choice) * 0.995;
  return gib ? Math.round((gib - 1.14) * 10) / 10 : VRAM_BUDGET;
}

/**
 * llama-server ayari: { ngl, moe, baglam, kv, mmprojGpu }. MoE (ya da ust veri okunamazsa): uzman katmanlari RAM'de,
 * istenen baglam (olculdu: Gemma 26B-A4B). Yogun model (ör. panelde egitilen 14B): butceye sigan en buyuk baglam
 * (32k/16k/8k; f16 ya da q8_0 KV); model kendisi sigmazsa katmanlarin bir kismi RAM'de.
 * Ornek: Qwen3-14B Q4_K_M (8,4 GiB, belirtec basina 160 KB KV): 32k f16 ~14 GiB tasar -> 16k q8_0 (~10,3).
 * Gorsel kodlayici (mmproj): secilen ayarla birlikte butceye sigarsa ekran kartinda, yoksa CPU'da (--no-mmproj-offload).
 * Olculdu 05.10.2026, Gemma 26B + 1,19 GB kodlayici: GPU'da 3 uzman katmani daha RAM'e gidiyor, yazi 51,7 -> 43,3
 * belirtec/sn, gorselli yanit 4,4 sn; CPU'da yazi degismiyor (51,5), gorselli yanit ~18 sn. MoE'de CPU (ince ayar
 * mmprojIslemci kapaliysa ekran kartinda: kodlayici kadar uzman katmani daha RAM'e gider). butce: vramButcesi().
 */
export function llamaConfig(info, context = 32768, { budget = VRAM_BUDGET, mmprojProcessor = true } = {}) {
  const gib = info.gib ?? 0;
  const mm = info.mmprojGib ?? 0;
  const u = info.model ? ggufMetadata(info.model) : null;
  if (!u || u.expert > 0 || !u.kvByte) {
    const mmGpu = !mmprojProcessor && mm > 0;
    return { ngl: 99, moe: moeLayers(gib + (mmGpu ? mm : 0), budget), context, kv: 'f16', mmprojGpu: mmGpu };
  }
  const kvGib = (b, kv) => (u.kvByte * b * (kv === 'q8_0' ? 34 / 64 : 1)) / 2 ** 30;
  // a hybrid model's KV is small: 64k when it fits (Bonsai 2 27B wrote as fast at 64k as at 32k, 64.7 tokens/s)
  const want = u.attentionEvery > 1 ? Math.max(context, Math.min(65536, u.contextLength ?? 65536)) : context;
  const tries = [[want, 'f16'], [want, 'q8_0'], [32768, 'f16'], [32768, 'q8_0'], [16384, 'f16'], [16384, 'q8_0'], [8192, 'q8_0']];
  for (const [i, [b, kv]] of tries.entries()) {
    if (b > want || tries.findIndex(([c, k]) => c === b && k === kv) !== i) continue;
    const required = gib + kvGib(b, kv) + WORK_SHARE;
    if (required <= budget) return { ngl: 99, moe: 0, context: b, kv, mmprojGpu: mm > 0 && required + mm <= budget };
  }
  const b = Math.min(context, 16384);
  const layerGib = gib / ((u.layer ?? 40) + 1);
  return { ngl: Math.max(0, Math.floor((budget - WORK_SHARE - kvGib(b, 'q8_0')) / layerGib) - 1), moe: 0, context: b, kv: 'q8_0', mmprojGpu: false };
}

export class LlmError extends Error {
  constructor(message, code = 500) {
    super(message);
    this.code = code;
  }
}

export class LocalLlm {
  /**
   * bilgi: llmBul() sonucu ya da { komut: () => ({ komut, argumanlar }), ad } (test).
   * gpuMesgul(): panelde is calisiyor mu. gpuBosalt(): ComfyUI bellegini bosalt (bostaysa).
   * gpuToplamMb(): kartin toplam bellegi (ince ayar llmVram 'oto'; bilinmiyorsa null).
   */
  /** keepFor(): seconds idle before the model leaves memory, read on every request (setting); 0 = keep it loaded. */
  /** gpuJob(): the job holding the GPU while a request waits ({ typeName, percent }), shown in the wait (null: none). */
  constructor({ info, port = 8091, context = 32768, idleSec = 300, keepFor = null, waitSec = 330, readySec = 180, switchGraceMs = 2000, gpuBusy = () => false, gpuJob = () => null, flushGpu = async () => {}, gpuTotalMb = async () => null, log = () => {}, logFile = null }) {
    Object.assign(this, { info, port, context, idleSec, keepFor, waitSec, readySec, switchGraceMs, gpuBusy, gpuJob, flushGpu, gpuTotalMb, log, logFile });
    this.proc = null;
    this.loaded = null; // info of the model the running llama-server holds
    this.startup = null;
    this.ongoing = 0;
    this.busy = 0; // requests being served by llama-server right now
    this.servedAt = 0; // when the last served request ended
    this.claim = null; // info of the model a request is switching the server to
    this.releasing = null;
    this.lastUsage = null;
    this.timer = null;
  }

  get installed() {
    return Boolean(this.info);
  }

  /** Secili model gorsel okuyor mu (yaninda mmproj gorsel kodlayicisi var; testte bilgi.gorsel). */
  get understandsImages() {
    return Boolean(this.info?.mmproj || this.info?.image);
  }

  /** Ayarlar'dan model degisti: calisan sunucu kapanir, sonraki istek yenisini yukler. */
  async selectModel(info) {
    if (!info || info.model === this.info?.model) return;
    await this.releaseGpu();
    this.info = info;
  }

  /**
   * Info of another model file in llmmodels (a chat can use its own text model; user request 08.10.2026), the default
   * for an empty name, null if the file is missing. Test infos (with command) list their models in info.models.
   */
  modelInfo(file) {
    if (!file || file === this.info?.file) return this.info;
    if (this.info?.command) {
      const m = (this.info.models ?? []).find((x) => x.file === file);
      return m ? { ...this.info, ...m, model: m.file } : null;
    }
    if (!this.info?.folder) return null;
    const info = findLlm(dirname(dirname(this.info.folder)), file);
    return info?.file === file ? info : null;
  }

  /** The model files in llm\models now: one copied or downloaded there shows in the lists without a restart. */
  models() {
    if (this.info?.command || !this.info?.folder) return this.info?.models ?? [];
    const fresh = findLlm(dirname(dirname(this.info.folder)), this.info.file);
    if (fresh) this.info = { ...this.info, models: fresh.models };
    return this.info.models ?? [];
  }

  status() {
    return { installed: this.installed, model: this.info?.name ?? null, file: this.info?.file ?? null, models: this.models(), loaded: this.loaded?.file ?? null, running: Boolean(this.proc), loading: Boolean(this.startup), ongoing: this.ongoing, lastUsage: this.lastUsage };
  }

  command(info = this.info) {
    if (info.command) return info.command(this.port, info);
    const a = llamaConfig(info, this.context, { budget: this.budget ?? VRAM_BUDGET, mmprojProcessor: fineSetting('mmprojProcessor') });
    this.lastSetting = a;
    return {
      command: info.bin,
      args: ['-m', info.model, ...(info.mmproj ? ['--mmproj', info.mmproj, ...(a.mmprojGpu ? [] : ['--no-mmproj-offload'])] : []), '-ngl', String(a.ngl), ...(a.moe ? ['--n-cpu-moe', String(a.moe)] : []), '-c', String(a.context), ...(a.kv !== 'f16' ? ['-ctk', a.kv, '-ctv', a.kv] : []), '--parallel', '1', '-fa', 'on', '--jinja', '--reasoning-budget-message', THINKING_END, ...(this.logFile ? ['--log-file', this.logFile] : []), '--host', '127.0.0.1', '--port', String(this.port)],
    };
  }

  async healthy() {
    try {
      const r = await fetch(`http://127.0.0.1:${this.port}/health`, { signal: AbortSignal.timeout(2000) });
      return r.ok;
    } catch {
      return false;
    }
  }

  /**
   * Waits until llama-server holds the given model and takes a serving slot (busy, released by the caller). llama-server
   * keeps one model: another model is loaded only when no request is being served (they run one at a time anyway).
   * loading(): called once if the model has to be loaded first (the chat says so instead of a silent wait).
   */
  async acquire(info = this.info, signal = null, loading = null) {
    let claimed = false;
    let told = false;
    const tell = () => {
      if (!told) loading?.();
      told = true;
    };
    try {
      for (;;) {
        if (signal?.aborted) throw new CancelError();
        // Another request is loading or switching to its model: it is served first. Before, a request for the other
        // model closed it between its health check and its slot, and the two took turns closing each other's model
        // (log 08.10.2026: "Switching gemma → Bonsai", then "Loading gemma"; in the test it never ended).
        if (this.claim && !claimed && this.claim.model !== info.model) {
          await wait(300);
          continue;
        }
        if (this.startup) {
          if (this.loaded?.model === info.model) tell();
          await this.startup.catch(() => {});
          continue;
        }
        if (this.proc && this.loaded?.model !== info.model) {
          // a chat on the loaded model sends its next step right after a tool: it keeps the model (one switch per step
          // of two chats on different models would load a model at every step)
          if (this.busy > 0 || Date.now() - this.servedAt < this.switchGraceMs) {
            await wait(300);
            continue;
          }
          this.log(`Switching text model: ${this.loaded?.name ?? '?'} → ${info.name}`);
          this.claim = info;
          claimed = true;
          await this.close();
          continue;
        }
        if (this.proc && (await this.healthy())) {
          // the state may have changed while the health check waited
          if (this.proc && !this.startup && this.loaded?.model === info.model) {
            this.busy += 1;
            return;
          }
          continue;
        }
        tell();
        if (!this.claim) {
          this.claim = info;
          claimed = true;
        }
        await this.prepare(info);
      }
    } finally {
      if (claimed && this.claim === info) this.claim = null;
    }
  }

  async prepare(info = this.info) {
    if (this.proc && this.loaded?.model === info.model && (await this.healthy())) return;
    this.startup ??= (async () => {
      if (this.proc) await this.close();
      await this.flushGpu();
      // VRAM butcesi her yuklemede (ince ayar degisince sonraki acilis yeni butceyle)
      const choice = fineSetting('llmVram');
      this.budget = vramBudget(choice, choice === 'oto' ? await this.gpuTotalMb().catch(() => null) : null);
      const { command, args } = this.command(info);
      const a = info.command ? null : this.lastSetting;
      this.log(`Loading text model: ${info.name}${a ? ` (context ${a.context / 1024}k, KV ${a.kv}${a.moe ? `, ${a.moe} expert layers in RAM` : ''}${a.ngl < 99 ? `, ${a.ngl} layers on the GPU` : ''}${info.mmproj ? `, vision encoder ${a.mmprojGpu ? 'on the GPU' : 'on the CPU'}` : ''})` : ''}`);
      const startedAt = Date.now();
      const proc = spawn(command, args, { windowsHide: true, stdio: 'ignore' });
      this.proc = proc;
      this.loaded = info;
      proc.on('exit', () => {
        if (this.proc === proc) this.proc = null;
      });
      while (Date.now() - startedAt < this.readySec * 1000) {
        if (!this.proc) throw new LlmError('Text model could not start (llama-server closed; GPU memory may be insufficient).', 503);
        if (await this.healthy()) {
          this.log(`Text model ready (${Math.round((Date.now() - startedAt) / 1000)} s).`);
          return;
        }
        await wait(500);
      }
      await this.close();
      throw new LlmError(`Text model did not open within ${this.readySec} s.`, 503);
    })().finally(() => {
      this.startup = null;
    });
    return this.startup;
  }

  /**
   * llama-server'a istek. disIstek: is calisirken bekler (botlar en cok beklemeSn; sahne yazari gibi arayuz gorevleri
   * sinirsiz, sinyal ile iptal); is icinden cagri beklemez. bekliyor(true|false): ekran karti bekleme durumu.
   * onChunk: the answer is streamed (text, thinking and tool call names arrive as they are written) and returned in
   * the same shape as a normal answer. onEvent: every streamed event of llama-server as it is (the /llm/v1 relay of a
   * stream: true request); the body goes as given and a 200 answer returns { code: 200, json: null }.
   * waiting(true, job) is called again when the job holding the GPU or its percent changes; waiting(true, { loading })
   * while the model is being loaded for this request; waiting(false) when it goes on.
   */
  async req(path, body, { externalRequest = true, waitSec = this.waitSec, signal = null, waiting = null, info = null, onChunk = null, onEvent = null } = {}) {
    if (!this.installed) throw new LlmError('Text model is not installed (<ai>\\llm\\bin\\llama-server.exe and llm\\models\\*.gguf).', 503);
    if (externalRequest) {
      const last = Date.now() + waitSec * 1000;
      let notified = null;
      while (this.gpuBusy() || this.releasing) {
        if (signal?.aborted) throw new CancelError();
        if (Date.now() > last) throw new LlmError('The GPU is currently busy with an image/video job in the panel; try again later.', 503);
        const job = this.gpuJob() ?? null;
        const shown = job ? `${job.typeName}:${Math.floor(job.percent ?? 0)}` : '';
        if (notified !== shown) waiting?.(true, job);
        notified = shown;
        await wait(2000);
      }
      if (notified !== null) waiting?.(false);
    } else if (this.releasing) await this.releasing;
    if (signal?.aborted) throw new CancelError();
    this.ongoing += 1;
    clearTimeout(this.timer);
    try {
      let loading = false;
      await this.acquire(info ?? this.info, signal, () => {
        loading = true;
        waiting?.(true, { loading: (info ?? this.info).name });
      });
      if (loading) waiting?.(false);
      let response;
      const collector = onChunk ? streamCollector(onChunk) : null;
      try {
        if (onEvent) response = await localStream(this.port, path, { ...body, stream: true }, signal, onEvent);
        else response = collector ? await localStream(this.port, path, { ...body, stream: true, stream_options: { include_usage: true } }, signal, (j) => collector.event(j)) : await localPost(this.port, path, body, signal);
      } finally {
        this.busy -= 1;
        this.servedAt = Date.now();
      }
      const { status, text } = response;
      if (onEvent && status === 200) return { code: 200, json: null };
      if (collector && status === 200) return { code: 200, json: collector.result() };
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = { error: { message: text.slice(0, 500) } };
      }
      return { code: status, json };
    } finally {
      this.ongoing -= 1;
      this.lastUsage = new Date().toISOString();
      this.idleSchedule();
    }
  }

  get keepLoaded() {
    return this.keepFor ? this.keepFor() === 0 : false;
  }

  /** Loads the default model without a request (setting "keep loaded"; the panel calls it when the GPU is free). */
  async preload() {
    if (!this.installed || this.proc || this.startup || this.releasing || this.gpuBusy()) return false;
    this.ongoing += 1;
    try {
      await this.acquire(this.info);
      this.busy -= 1;
      return true;
    } finally {
      this.ongoing -= 1;
      this.idleSchedule();
    }
  }

  idleSchedule() {
    clearTimeout(this.timer);
    if (this.ongoing > 0 || !this.proc) return;
    const sec = this.keepFor ? this.keepFor() : this.idleSec;
    if (!sec) return; // keep loaded
    this.timer = setTimeout(() => {
      if (this.ongoing === 0) this.close().then(() => this.log('Text model was idle; shut down.'));
    }, sec * 1000);
    this.timer.unref?.();
  }

  /** GPU isi baslamadan once: suren istekler biter, sunucu kapanir (ekran karti bosalir). */
  async releaseGpu() {
    if (!this.proc && !this.startup) return;
    this.releasing ??= (async () => {
      while (this.ongoing > 0 || this.startup) await wait(300);
      await this.close();
      this.log('Text model shut down (GPU handed to an image/video job).');
    })().finally(() => {
      this.releasing = null;
    });
    return this.releasing;
  }

  async close() {
    clearTimeout(this.timer);
    const s = this.proc;
    this.proc = null;
    if (!s) return;
    killTree(s.pid);
    // Surec kapanip ekran karti bellegi birakilana kadar
    for (let i = 0; i < 40 && s.exitCode === null && s.signalCode === null; i++) await wait(100);
  }
}

/** Metin icerigi: string ya da [{type:'input_text'|'text'|'output_text', text}] */
function getText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('');
  return '';
}

/** Dusunme butcesi (token) — Responses `reasoning.effort` karsiligi. Varsayilan orta: dusunmeden Gemma
 * JSON'un ilk anahtarini gerekcesiz secip yanlis karar veriyor (ör. bolum yazicida hep already_covered=true)
 * ve istenen anahtarlari atliyordu (denetcide reason); 3072 ile ikisi de DeepSeek gibi (04.10.2026 kiyas). */
export const THINKING_BUDGET = { none: 0, minimal: 0, low: 1024, medium: 3072, high: 8192 };
/** Butce dolunca dusunceye eklenen kapanis; model yaniti yazmaya gecer. */
const THINKING_END = 'Enough thinking; writing the final answer now.';
/**
 * Sicaklik tavani. Dusunerek 0.7'de uzun yaziyi kopyalarken kelime bozuyordu ("Konfor" -> "Konfer", "ibaret" ->
 * "ibret", "doğrudur" -> "doğrud습니다"; 7 denemenin 4'unde); 0.3'te 6 denemede hic, kararlar ayni (04.10.2026).
 */
export const TEMPERATURE_CAP = 0.3;
/**
 * Sistem istemine eklenen not. Gemma uzunluk/adet talimatini alt sinirin altinda tutuyordu (bolum yazici
 * "2 bolum, 3-4 paragraf" icin ~260 kelime, bir kez 49; DeepSeek ~550); notla ~350-390 (04.10.2026).
 */
export const LENGTH_NOTE = 'Follow length and count instructions (section, paragraph, sentence, word counts) exactly; if a range is requested, do not stay at its lower bound or cut it short.';

/** OpenAI Responses istegi -> chat/completions (JSON bicimi response_format ile ZORLANIR). */
export function responsesToChat(g = {}) {
  const messages = [];
  if (g.instructions) messages.push({ role: 'system', content: `${g.instructions}\n\n${LENGTH_NOTE}` });
  if (typeof g.input === 'string') messages.push({ role: 'user', content: g.input });
  else if (Array.isArray(g.input)) for (const m of g.input) messages.push({ role: m.role === 'developer' ? 'system' : m.role ?? 'user', content: getText(m.content) });
  const format = g.text?.format?.type;
  const budget = THINKING_BUDGET[g.reasoning?.effort] ?? THINKING_BUDGET.medium;
  const body = { messages: messages, chat_template_kwargs: { enable_thinking: budget > 0 } };
  if (budget > 0) body.thinking_budget_tokens = budget;
  body.temperature = Math.min(g.temperature ?? TEMPERATURE_CAP, TEMPERATURE_CAP);
  if (g.top_p !== undefined) body.top_p = g.top_p;
  // Dusunce de max_tokens'tan yer; istenen cikti siniri dusunceden sonra kalsin.
  if (g.max_output_tokens) body.max_tokens = g.max_output_tokens + budget;
  if (format === 'json_object') body.response_format = { type: 'json_object' };
  if (format === 'json_schema') body.response_format = { type: 'json_schema', json_schema: { name: g.text.format.name ?? 'response', schema: g.text.format.schema, strict: g.text.format.strict } };
  return body;
}

const TEXTS = ['Latin', 'Cyrillic', 'Greek', 'Arabic', 'Hebrew', 'Hangul', 'Han', 'Hiragana', 'Katakana', 'Thai', 'Devanagari', 'Georgian', 'Armenian'].map((name) => [name, new RegExp(`\\p{Script=${name}}`, 'u')]);

/**
 * Ciktiya karisan yabanci yazi: girdide hic olmayan bir yazi ciktidaki harflerin %0-2'si ise adi, yoksa null.
 * Gemma uzun metni kopyalarken arada baska dile kayabiliyor ("doğrudur" -> "doğrud습니다", 04.10.2026);
 * o dile ceviri ise ciktinin cogu o yazidir, sayilmaz.
 */
export function foreignScript(input, output) {
  const exists = new Set(TEXTS.filter(([, d]) => d.test(input)).map(([name]) => name));
  const letters = String(output).match(/\p{L}/gu) ?? [];
  const number = {};
  for (const h of letters) {
    const text = TEXTS.find(([, d]) => d.test(h))?.[0];
    if (text && !exists.has(text)) number[text] = (number[text] ?? 0) + 1;
  }
  return Object.keys(number).find((name) => number[name] / letters.length < 0.02) ?? null;
}

/** chat/completions yaniti -> OpenAI Responses yaniti (DeepSeekClient'in okudugu bicim). */
export function chatToResponses(j, model) {
  const choice = j.choices?.[0] ?? {};
  const text = choice.message?.content ?? '';
  return {
    id: j.id ?? `resp_${Date.now().toString(36)}`,
    object: 'response',
    created_at: j.created ?? Math.floor(Date.now() / 1000),
    model: model ?? j.model,
    status: choice.finish_reason === 'length' ? 'incomplete' : 'completed',
    ...(choice.finish_reason === 'length' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
    output: [{ type: 'message', id: `msg_${Date.now().toString(36)}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: text, annotations: [] }] }],
    usage: { input_tokens: j.usage?.prompt_tokens ?? 0, output_tokens: j.usage?.completion_tokens ?? 0, total_tokens: j.usage?.total_tokens ?? 0 },
  };
}
