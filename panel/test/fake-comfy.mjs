/**
 * Sahte ComfyUI (testler icin): /prompt, /history, /queue, /interrupt, /free, /upload/image,
 * /view, /system_stats ve /ws (websocket ilerleme). Ekran karti kullanmaz.
 *
 * Kipler (sunucu.kip):
 *   'normal'     her adim kisa surer, ciktilar uretilir
 *   'yavas'      her adim 300 ms (iptal testi)
 *   'dogrulama'  POST /prompt 400 + eksik model hatasi
 *   'oom'        ilk ornekleyicide CUDA out of memory
 *   'kayip'      istek kabul edilir ama ne kuyrukta ne gecmiste gorunur (yeniden baslatma)
 */
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { makePng } from '../lib/media.mjs';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function wsFrame(text) {
  const data = Buffer.from(text, 'utf8');
  let startedAt;
  if (data.length < 126) startedAt = Buffer.from([0x81, data.length]);
  else if (data.length < 65536) {
    startedAt = Buffer.alloc(4);
    startedAt[0] = 0x81;
    startedAt[1] = 126;
    startedAt.writeUInt16BE(data.length, 2);
  } else {
    startedAt = Buffer.alloc(10);
    startedAt[0] = 0x81;
    startedAt[1] = 127;
    startedAt.writeBigUInt64BE(BigInt(data.length), 2);
  }
  return Buffer.concat([startedAt, data]);
}

function sort(graph) {
  const position = [];
  const seen = new Set();
  const visit = (id) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const v of Object.values(graph[id].inputs ?? {})) if (Array.isArray(v) && typeof v[0] === 'string' && graph[v[0]]) visit(v[0]);
    position.push(id);
  };
  Object.keys(graph).forEach(visit);
  return position;
}

/** Bir SaveImage'a ulasan kare sayisi: video grafinda length (x RIFE), gorselde 1; ImageFromBatch dilimi length kare. */
function frameCount(graph, recordId) {
  let frame = 1;
  let factor = 1;
  let slice = null;
  const look = (id, seen = new Set()) => {
    if (seen.has(id)) return;
    seen.add(id);
    const d = graph[id];
    if (!d) return;
    if (d.class_type === 'RIFE VFI') factor *= d.inputs.multiplier;
    if (d.class_type === 'ImageFromBatch') slice ??= d.inputs.length;
    if (['WanImageToVideo', 'Wan22ImageToVideoLatent', 'WanFirstLastFrameToVideo', 'WanInfiniteTalkToVideo'].includes(d.class_type)) frame = d.inputs.length;
    for (const v of Object.values(d.inputs ?? {})) if (Array.isArray(v) && typeof v[0] === 'string') look(v[0], seen);
  };
  look(recordId);
  if (slice !== null) return slice;
  return factor > 1 ? (frame - 1) * factor + 1 : frame;
}

export async function startFakeComfy({ mode = 'normal', frameSize = [64, 36], stepDuration = 5, imageData = null } = {}) {
  const status = {
    mode,
    records: [], // gelen istekler: { yol, govde }
    requests: new Map(), // id -> { graf, durum, ciktilar, mesajlar }
    queue: [],
    running: null,
    files: new Map(),
    sockets: new Set(),
    uploaded: [],
    trainings: [], // TrainLoraNode girdileri
    flushes: 0,
    cuts: 0,
    stepDuration,
  };

  const publish = (message) => {
    const c = wsFrame(JSON.stringify(message));
    for (const s of status.sockets) {
      try {
        s.write(c);
      } catch {
        /* */
      }
    }
  };

  const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));

  async function run(id) {
    const job = status.requests.get(id);
    status.running = id;
    job.status = 'running';
    publish({ type: 'execution_start', data: { prompt_id: id } });
    try {
      for (const node of sort(job.graph)) {
        if (job.cut) throw Object.assign(new Error('cut'), { cutting: true });
        const d = job.graph[node];
        publish({ type: 'executing', data: { node: node, prompt_id: id } });
        if (/^KSampler(Advanced)?$|^SamplerCustomAdvanced$/.test(d.class_type)) {
          if (status.mode === 'oom' || job.oom) {
            const error = { prompt_id: id, node_id: node, node_type: d.class_type, exception_type: 'torch.OutOfMemoryError', exception_message: 'CUDA error: out of memory', traceback: [] };
            job.messages.push(['execution_error', error]);
            publish({ type: 'execution_error', data: error });
            job.status = 'error';
            return;
          }
          const step = d.class_type === 'SamplerCustomAdvanced' ? (job.graph[d.inputs.sigmas?.[0]]?.inputs?.steps ?? 4) : d.class_type === 'KSampler' ? d.inputs.steps : (d.inputs.end_at_step > 100 ? d.inputs.steps : d.inputs.end_at_step) - d.inputs.start_at_step;
          for (let a = 1; a <= step; a++) {
            await wait(status.mode === 'slow' ? 300 : status.stepDuration);
            if (job.cut) throw Object.assign(new Error('cut'), { cutting: true });
            publish({ type: 'progress', data: { value: a, max: step, prompt_id: id, node: node } });
          }
        }
        if (d.class_type === 'TrainLoraNode') {
          for (let a = 1; a <= d.inputs.steps; a++) {
            await wait(status.mode === 'slow' ? 300 : status.stepDuration);
            if (job.cut) throw Object.assign(new Error('cut'), { cutting: true });
            publish({ type: 'progress', data: { value: a, max: d.inputs.steps, prompt_id: id, node: node } });
          }
          status.trainings.push({ ...d.inputs });
        }
        if (d.class_type === 'SaveLoRA') {
          const part = d.inputs.prefix.split('/');
          status.files.set(`${part.slice(0, -1).join('/')}/${part.at(-1)}_00001_.safetensors`, Buffer.from('sahte lora'));
        }
        if (d.class_type === 'PreviewAny') {
          const training = job.graph[d.inputs.source[0]];
          job.outputs[node] = { text: [JSON.stringify({ loss: Array.from({ length: training?.inputs?.steps ?? 1 }, (_, i) => 0.5 - i / 1000) }, null, 4)] };
        }
        if (d.class_type === 'SaveImage') {
          const n = frameCount(job.graph, node);
          const prefix = d.inputs.filename_prefix;
          const part = prefix.split('/');
          const name = part.pop();
          const sub = part.join('/');
          const pictures = [];
          for (let i = 1; i <= n; i++) {
            const file = `${name}_${String(i).padStart(5, '0')}_.png`;
            status.files.set(`${sub}/${file}`, imageData ? imageData(i, n, prefix) : makePng(frameSize[0], frameSize[1], [(i * 3) % 255, 90, 160]));
            pictures.push({ filename: file, subfolder: sub, type: 'output' });
          }
          job.outputs[node] = { images: pictures };
        }
        if (d.class_type === 'SaveLatent') {
          const part = d.inputs.filename_prefix.split('/');
          const name = `${part.pop()}_00001_.latent`;
          const sub = part.join('/');
          status.files.set(`${sub}/${name}`, Buffer.from('sahte latent'));
          job.outputs[node] = { latents: [{ filename: name, subfolder: sub, type: 'output' }] };
        }
        if (d.class_type === 'SaveAudioMP3') {
          const part = d.inputs.filename_prefix.split('/');
          const name = `${part.pop()}_00001_.mp3`;
          const sub = part.join('/');
          status.files.set(`${sub}/${name}`, Buffer.from('ID3 sahte mp3'));
          job.outputs[node] = { audio: [{ filename: name, subfolder: sub, type: 'output' }] };
        }
        if (d.class_type === 'SaveGLB') {
          const part = d.inputs.filename_prefix.split('/');
          const name = `${part.pop()}_00001_.glb`;
          const sub = part.join('/');
          status.files.set(`${sub}/${name}`, Buffer.from('glTF fake model'));
          job.outputs[node] = { '3d': [{ filename: name, subfolder: sub, type: 'output' }] };
        }
      }
      job.status = 'done';
      publish({ type: 'executing', data: { node: null, prompt_id: id } });
    } catch (e) {
      if (e.cutting) {
        job.messages.push(['execution_interrupted', { prompt_id: id }]);
        job.status = 'error';
      } else throw e;
    } finally {
      status.running = null;
    }
  }

  async function loop() {
    while (!status.closed) {
      const id = status.queue.shift();
      if (!id) {
        await wait(10);
        continue;
      }
      await run(id);
    }
  }

  const server = createServer(async (req, response) => {
    const url = new URL(req.url, 'http://x');
    const parts = [];
    for await (const p of req) parts.push(p);
    const body = Buffer.concat(parts);
    status.records.push({ method: req.method, path: url.pathname, body: body.toString('utf8').slice(0, 2000), prompt: url.pathname === '/prompt' ? body.toString('utf8') : undefined });
    const json = (code, v) => {
      response.writeHead(code, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(v));
    };
    if (url.pathname === '/system_stats') return json(200, { system: { os: 'nt' }, devices: [{ name: 'fake', vram_total: 1, vram_free: 1 }] });
    if (url.pathname === '/prompt' && req.method === 'POST') {
      const j = JSON.parse(body.toString('utf8'));
      if (status.mode === 'validation') {
        return json(400, {
          error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation', details: '', extra_info: {} },
          node_errors: { 1: { errors: [{ type: 'value_not_in_list', message: 'Value not in list', details: "unet_name: 'qwen-image-2512-Q4_K_M.gguf' not in []", extra_info: {} }], dependent_outputs: [], class_type: 'UnetLoaderGGUF' } },
        });
      }
      for (const [k, d] of Object.entries(j.prompt)) if (!d.class_type) return json(400, { error: { type: 'invalid_prompt', message: `node ${k} has no class_type` }, node_errors: {} });
      const id = randomUUID();
      status.requestCounter = (status.requestCounter ?? 0) + 1;
      // hataIstegi = N ya da [N, N+1]: o istekler ornekleyicide VRAM hatasi verir (panel bir kez yeniden dener; iki
      // ardisik hata yarida kalan uzun is testi).
      status.requests.set(id, { graph: j.prompt, status: 'waiting', outputs: {}, messages: [], client: j.client_id, oom: [status.errorRequest].flat().includes(status.requestCounter) });
      if (status.mode !== 'loss') status.queue.push(id);
      return json(200, { prompt_id: id, number: status.requests.size, node_errors: {} });
    }
    if (url.pathname.startsWith('/history/')) {
      const id = url.pathname.slice(9);
      const job = status.requests.get(id);
      if (!job || ['waiting', 'running'].includes(job.status)) return json(200, {});
      const error = job.status === 'error';
      return json(200, { [id]: { prompt: [], outputs: job.outputs, status: { status_str: error ? 'error' : 'success', completed: !error, messages: job.messages } } });
    }
    if (url.pathname === '/queue' && req.method === 'GET') {
      return json(200, {
        queue_running: status.running ? [[1, status.running, {}, {}, []]] : [],
        queue_pending: status.queue.map((id, i) => [i + 2, id, {}, {}, []]),
      });
    }
    if (url.pathname === '/queue' && req.method === 'POST') {
      const j = JSON.parse(body.toString('utf8') || '{}');
      for (const id of j.delete ?? []) {
        status.queue = status.queue.filter((x) => x !== id);
        status.requests.delete(id);
      }
      return json(200, {});
    }
    if (url.pathname === '/interrupt') {
      status.cuts += 1;
      const j = JSON.parse(body.toString('utf8') || '{}');
      const target = j.prompt_id ?? status.running;
      if (target && target === status.running) status.requests.get(target).cut = true;
      return json(200, {});
    }
    if (url.pathname === '/free') {
      status.flushes += 1;
      return json(200, {});
    }
    if (url.pathname === '/upload/image') {
      const text = body.toString('latin1');
      const name = /filename="([^"]+)"/.exec(text)?.[1] ?? 'yuklenen.png';
      const sub = /name="subfolder"\r\n\r\n([^\r]*)/.exec(text)?.[1] ?? '';
      status.uploaded.push(sub ? `${sub}/${name}` : name);
      return json(200, { name: name, subfolder: sub, type: 'input' });
    }
    if (url.pathname === '/view') {
      const key = `${url.searchParams.get('subfolder') ?? ''}/${url.searchParams.get('filename')}`;
      const b = status.files.get(key);
      if (!b) {
        response.writeHead(404);
        return response.end();
      }
      response.writeHead(200, { 'Content-Type': 'image/png' });
      return response.end(b);
    }
    response.writeHead(404);
    response.end();
  });

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    status.sockets.add(socket);
    socket.on('data', (b) => {
      // Istemciden gelen kapatma cercevesi (0x8): kapat.
      if ((b[0] & 0x0f) === 0x8) socket.end();
    });
    socket.on('close', () => status.sockets.delete(socket));
    socket.on('error', () => status.sockets.delete(socket));
    socket.write(wsFrame(JSON.stringify({ type: 'status', data: { status: { exec_info: { queue_remaining: 0 } }, sid: 'x' } })));
  });

  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  loop();
  const address = `http://127.0.0.1:${server.address().port}`;
  return {
    address,
    status,
    async close() {
      status.closed = true;
      for (const s of status.sockets) s.destroy();
      await new Promise((ok) => server.close(ok));
    },
  };
}
