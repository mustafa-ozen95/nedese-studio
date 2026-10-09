/**
 * Yerel yazi modeli: llama-server yasam dongusu (sahte sunucu), GPU paylasimi, /llm/v1 (OpenAI uyumlu).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LENGTH_NOTE, LocalLlm, ggufMetadata, llamaConfig, chatToResponses, responsesToChat } from '../lib/llm.mjs';
import { CancelError } from '../lib/errors.mjs';
import { createPanel } from './env.mjs';

const FAKE = fileURLToPath(new URL('./fake-llm.mjs', import.meta.url));
const freePort = () => new Promise((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const fakeLlm = async (options = {}) => new LocalLlm({ info: { name: 'fake-model', command: (port) => ({ command: process.execPath, args: [FAKE, String(port)] }) }, port: await freePort(), readySec: 20, ...options });

/** En kucuk GGUF: baslik + anahtar-deger (tur 4 u32, 8 metin, 9 dizi [oge turu, liste]); tensor yok. */
function ggufYaz(file, kv) {
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
  const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
  const f32 = (v) => { const b = Buffer.alloc(4); b.writeFloatLE(v); return b; };
  const str = (s) => { const b = Buffer.from(s, 'utf8'); return Buffer.concat([u64(b.length), b]); };
  const value = (type, v) => (type === 8 ? str(v) : type === 6 ? f32(v) : u32(v));
  const p = [Buffer.from('GGUF'), u32(3), u64(0), u64(Object.keys(kv).length)];
  for (const [name, [type, v]] of Object.entries(kv)) {
    p.push(str(name), u32(type));
    if (type === 9) {
      p.push(u32(v[0]), u64(v[1].length));
      for (const x of v[1]) p.push(value(v[0], x));
    } else p.push(value(type, v));
  }
  writeFileSync(file, Buffer.concat(p));
  return file;
}

test('text model settings from GGUF metadata: dense 14B 16k q8_0 KV, MoE as before, what does not fit goes partly to RAM', () => {
  const k = mkdtempSync(join(tmpdir(), 'gguf-'));
  // Sozluk dizileri 1 MB'lik okuma parcalarini asar: atlama sinirlarda da dogru olmali
  const dictionary = { 'tokenizer.ggml.tokens': [9, [8, Array.from({ length: 70000 }, (_, i) => `belirtec-${i}-xxxxx`)]], 'tokenizer.ggml.scores': [9, [6, Array.from({ length: 300000 }, () => 0.5)]] };
  const dense = (name, layer, kvBas) => ggufYaz(join(k, name), { 'general.architecture': [8, 'qwen3'], ...dictionary, 'qwen3.block_count': [4, layer], 'qwen3.attention.head_count': [4, 40], 'qwen3.attention.head_count_kv': [4, kvBas], 'qwen3.attention.key_length': [4, 128], 'qwen3.attention.value_length': [4, 128], 'qwen3.embedding_length': [4, 5120] });
  const q14 = dense('q14.gguf', 40, 8);
  assert.deepEqual(ggufMetadata(q14), { architecture: 'qwen3', layer: 40, expert: 0, kvByte: 163840, contextLength: null, slidingWindow: null });
  assert.deepEqual(llamaConfig({ model: q14, gib: 8.4 }), { ngl: 99, moe: 0, context: 16384, kv: 'q8_0', mmprojGpu: false }, '14B Q4_K_M: 32k f16 KV (~5 GiB) does not fit');
  assert.deepEqual(llamaConfig({ model: dense('q8.gguf', 36, 8), gib: 4.7 }), { ngl: 99, moe: 0, context: 32768, kv: 'f16', mmprojGpu: false }, '8B: 32k fits');
  // Gorsel kodlayici: secilen ayarla butceye sigarsa ekran kartinda; 14B'de sigmaz -> CPU (baglam kuculmez)
  assert.equal(llamaConfig({ model: dense('q8b.gguf', 36, 8), gib: 4.7, mmprojGib: 0.63 }).mmprojGpu, true);
  assert.deepEqual(llamaConfig({ model: q14, gib: 8.4, mmprojGib: 0.6 }), { ngl: 99, moe: 0, context: 16384, kv: 'q8_0', mmprojGpu: false });
  const tooLarge = llamaConfig({ model: q14, gib: 14.6 });
  assert.equal(tooLarge.context, 16384);
  assert.ok(tooLarge.ngl > 0 && tooLarge.ngl < 40, `14B Q8_0: some layers in RAM (${tooLarge.ngl})`);
  const moe = ggufYaz(join(k, 'moe.gguf'), { 'general.architecture': [8, 'gemma4'], 'gemma4.block_count': [4, 30], 'gemma4.expert_count': [4, 128], 'gemma4.attention.head_count': [4, 16], 'gemma4.attention.head_count_kv': [4, 8], 'gemma4.embedding_length': [4, 2816] });
  assert.deepEqual(llamaConfig({ model: moe, gib: 13.45 }), { ngl: 99, moe: 11, context: 32768, kv: 'f16', mmprojGpu: false }, 'MoE: uzmanlar RAM\'de, 32k');
  // MoE + gorsel kodlayici: kodlayici CPU'da, uzman katmani artmaz (olculdu: yazi hizi degismiyor)
  assert.deepEqual(llamaConfig({ model: moe, gib: 13.45, mmprojGib: 1.11 }), { ngl: 99, moe: 11, context: 32768, kv: 'f16', mmprojGpu: false });
  // Katman basina KV basi dizisi (karma mimari) toplanir
  const hybrid = ggufYaz(join(k, 'karma.gguf'), { 'general.architecture': [8, 'x'], 'x.block_count': [4, 4], 'x.attention.head_count': [4, 8], 'x.attention.head_count_kv': [9, [4, [8, 0, 8, 0]]], 'x.attention.key_length': [4, 64] });
  assert.equal(ggufMetadata(hybrid).kvByte, 16 * 128 * 2);
  // Linear-attention hybrid (qwen35, Bonsai 2 27B): only every 4th of 64 layers keeps KV, so 64k q8_0 fits with the
  // vision encoder on the card (measured 9.8 GB)
  const bonsai = ggufYaz(join(k, 'bonsai.gguf'), { 'general.architecture': [8, 'qwen35'], 'qwen35.block_count': [4, 64], 'qwen35.full_attention_interval': [4, 4], 'qwen35.context_length': [4, 262144], 'qwen35.attention.head_count': [4, 24], 'qwen35.attention.head_count_kv': [4, 4], 'qwen35.attention.key_length': [4, 256], 'qwen35.attention.value_length': [4, 256] });
  assert.deepEqual(ggufMetadata(bonsai), { architecture: 'qwen35', layer: 64, expert: 0, kvByte: 65536, contextLength: 262144, slidingWindow: null, attentionEvery: 4 });
  assert.deepEqual(llamaConfig({ model: bonsai, gib: 6.71, mmprojGib: 0.87 }), { ngl: 99, moe: 0, context: 65536, kv: 'q8_0', mmprojGpu: true });
  assert.deepEqual(llamaConfig({ model: bonsai, gib: 8.5 }), { ngl: 99, moe: 0, context: 32768, kv: 'q8_0', mmprojGpu: false }, 'a larger hybrid steps down to 32k');
  // GGUF degilse eski davranis
  writeFileSync(join(k, 'bozuk.gguf'), 'merhaba');
  assert.equal(ggufMetadata(join(k, 'bozuk.gguf')), null);
  assert.deepEqual(llamaConfig({ model: join(k, 'bozuk.gguf'), gib: 13.45 }), { ngl: 99, moe: 11, context: 32768, kv: 'f16', mmprojGpu: false });
});

test('sectioned article helpers: single heading, repetition ratio', async () => {
  const { editSection, repeatRatio } = await import('../lib/article.mjs');
  assert.equal(editSection('<h2>Eski</h2><p>a</p><h2>Başka</h2><p>b</p>', 'Yeni'), '<h2>Yeni</h2><p>a</p>');
  assert.equal(editSection('<p>başlıksız</p>', 'Yeni'), '<h2>Yeni</h2><p>başlıksız</p>');
  assert.equal(repeatRatio('bir iki üç dört', ['bir iki üç dört beş']), 1);
  assert.equal(repeatRatio('çiftlik haritası nehir deltası', ['çok oyunculu mod sekiz oyuncu']), 0);
});

test('Responses <-> chat/completions conversion (DeepSeekClient format, JSON enforced)', () => {
  const c = responsesToChat({ model: 'deepseek-v4-flash', instructions: 'Sistem', input: 'Merhaba', text: { format: { type: 'json_object' } }, temperature: 0.7, max_output_tokens: 65536 });
  assert.deepEqual(c.messages, [{ role: 'system', content: `Sistem

${LENGTH_NOTE}` }, { role: 'user', content: 'Merhaba' }]);
  assert.deepEqual(c.response_format, { type: 'json_object' });
  // Varsayilan orta dusunme: butce max_tokens'a eklenir; reasoning.effort none kapatir.
  assert.equal(c.chat_template_kwargs.enable_thinking, true);
  assert.equal(c.thinking_budget_tokens, 3072);
  assert.equal(c.max_tokens, 65536 + 3072);
  assert.equal(c.temperature, 0.3, 'temperature cap');
  const closed = responsesToChat({ input: 'x', reasoning: { effort: 'none' }, max_output_tokens: 100 });
  assert.equal(closed.chat_template_kwargs.enable_thinking, false);
  assert.equal(closed.thinking_budget_tokens, undefined);
  assert.equal(closed.max_tokens, 100);
  const array = responsesToChat({ input: [{ role: 'developer', content: [{ type: 'input_text', text: 'k' }] }, { role: 'user', content: 'u' }] });
  assert.deepEqual(array.messages, [{ role: 'system', content: 'k' }, { role: 'user', content: 'u' }]);
  const y = chatToResponses({ choices: [{ message: { content: '{"a":1}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }, 'gemma');
  assert.equal(y.status, 'completed');
  const message = y.output.find((o) => o.type === 'message');
  assert.equal(message.content.find((c2) => c2.type === 'output_text').text, '{"a":1}');
  assert.deepEqual(y.usage, { input_tokens: 3, output_tokens: 4, total_tokens: 7 });
  assert.equal(chatToResponses({ choices: [{ message: { content: '{' }, finish_reason: 'length' }] }).status, 'incomplete');
});

test('text model list: models trained in the panel come last, the ready-made model is default when nothing is selected', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { findLlm } = await import('../lib/llm.mjs');
  const root = mkdtempSync(join(tmpdir(), 'llm-liste-'));
  mkdirSync(join(root, 'llm', 'bin'), { recursive: true });
  mkdirSync(join(root, 'llm', 'models'));
  writeFileSync(join(root, 'llm', 'bin', process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'), '');
  for (const d of ['adim-trained-20261005-022841-q8_0.gguf', 'gemma-4-26B-qat-q4_0.gguf', 'mmproj-x.gguf', 'mmproj-adim-trained-20261005-022841-q8_0.gguf']) writeFileSync(join(root, 'llm', 'models', d), 'x');
  const b = findLlm(root, '');
  assert.deepEqual(b.models.map((m) => [m.file, m.image]), [['gemma-4-26B-qat-q4_0.gguf', false], ['adim-trained-20261005-022841-q8_0.gguf', true]]);
  assert.equal(b.file, 'gemma-4-26B-qat-q4_0.gguf');
  assert.equal(b.mmproj, null);
  const g = findLlm(root, 'adim-trained-20261005-022841-q8_0.gguf');
  assert.equal(g.file, 'adim-trained-20261005-022841-q8_0.gguf', 'explicit selection applies');
  // Gorsel kodlayici (Model egitimi > Genel): llama-server --mmproj ile acilir
  const { LocalLlm } = await import('../lib/llm.mjs');
  const a = new LocalLlm({ info: g }).command().args;
  assert.equal(a[a.indexOf('--mmproj') + 1], join(root, 'llm', 'models', 'mmproj-adim-trained-20261005-022841-q8_0.gguf'));
  assert.ok(a.includes('--no-mmproj-offload'), 'encoder on the CPU for a model whose metadata cannot be read');
  assert.ok(!new LocalLlm({ info: b }).command().args.includes('--mmproj'));
  // A PrismML quantization (Bonsai PQ2_0) runs on PrismML's server in llm\bin-prism; the others stay on llm\bin
  const exe = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  mkdirSync(join(root, 'llm', 'bin-prism'));
  writeFileSync(join(root, 'llm', 'bin-prism', exe), '');
  const running = new LocalLlm({ info: b });
  writeFileSync(join(root, 'llm', 'models', 'Ternary-Bonsai-2-27B-PQ2_0.gguf'), 'x');
  assert.ok(running.status().models.some((m) => m.file === 'Ternary-Bonsai-2-27B-PQ2_0.gguf'), 'a model copied in later is listed without a restart');
  assert.equal(running.status().file, 'gemma-4-26B-qat-q4_0.gguf', 'the selection stays');
  assert.equal(findLlm(root, 'Ternary-Bonsai-2-27B-PQ2_0.gguf').bin, join(root, 'llm', 'bin-prism', exe));
  assert.equal(new LocalLlm({ info: findLlm(root, 'Ternary-Bonsai-2-27B-PQ2_0.gguf') }).command().command, join(root, 'llm', 'bin-prism', exe));
  assert.equal(findLlm(root, 'gemma-4-26B-qat-q4_0.gguf').bin, join(root, 'llm', 'bin', exe));
});

test('/llm/v1 + model trained in the panel: the guide becomes a short marker, no length note and no sectioned flow', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const llm = await fakeLlm();
  const p = await createPanel({ server: true, llm });
  try {
    const GUIDE = '# Nedese yazım kılavuzu\nÇok uzun ve sabit kurallar metni.';
    const gguf = 'yazar-trained-20261005-120000-q4_k_m.gguf';
    const folder = join(p.root, 'training', 'models', 'yazar-20261005-120000');
    mkdirSync(join(folder, 'adaptor'), { recursive: true });
    writeFileSync(join(folder, 'adaptor', 'adapter_config.json'), '{}');
    writeFileSync(join(folder, 'abbreviations.json'), JSON.stringify({ '[[kilavuz:yazim]]': GUIDE }));
    writeFileSync(join(p.root, 'training', 'models', 'registry.json'), JSON.stringify([{ id: 'yazar-20261005-120000', name: 'Yazar', method: 'fine', gguf }]));
    const req = (body) => fetch(`${p.address}/llm/v1/responses`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.settingFile.apiKey}` }, body: JSON.stringify(body) }).then((r) => r.json());
    const system = async (options = {}) => JSON.parse((await req({ instructions: `Görev.\n\n${GUIDE}\n\nKaynak bilgileri`, input: 'Haber', text: { format: { type: 'json_object' } }, ...options })).output.find((o) => o.type === 'message').content[0].text).system;
    // Hazir model: kilavuz oldugu gibi + uzunluk notu
    assert.ok((await system()).includes(GUIDE));
    // Egitilmis model etkin
    llm.info = { ...llm.info, file: gguf };
    const s = await system({ metadata: { sectioned: true } });
    assert.equal(s, 'Görev.\n\n[[kilavuz:yazim]]\n\nKaynak bilgileri', 'shortened, no length note, not sectioned (single call)');
    // Gorselli icerik (OpenAI dizi bicimi): yalniz metin parcasi kisaltilir, gorsel parcasi oldugu gibi gider
    const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } };
    const r = await fetch(`${p.address}/llm/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.settingFile.apiKey}` }, body: JSON.stringify({ messages: [{ role: 'user', content: [{ type: 'text', text: GUIDE }, image] }], response_format: { type: 'json_object' } }) }).then((x) => x.json());
    assert.deepEqual(JSON.parse(r.choices[0].message.content).prompt, [{ type: 'text', text: '[[kilavuz:yazim]]' }, image]);
  } finally {
    await llm.close();
    await p.close();
  }
});

test('foreign script leaking into the output: drift is caught in a copy, translation into that language and script present in the input do not count', async () => {
  const { foreignScript } = await import('../lib/llm.mjs');
  const tr = 'Bu metin benim haritam değil diye okumak daha doğrudur. '.repeat(20);
  assert.equal(foreignScript(tr, tr.replace('doğrudur', 'doğrud습니다')), 'Hangul');
  assert.equal(foreignScript(tr, tr), null);
  assert.equal(foreignScript(tr, '이것은 한국어 번역입니다 '.repeat(30)), null);
  assert.equal(foreignScript(`ar: عطارد ${tr}`, `${tr} عطارد`), null);
});

test('local model: started on request, released when a GPU job starts, external requests wait while a job runs, closes when idle', async () => {
  let busy = false;
  let flush = 0;
  const llm = await fakeLlm({ idleSec: 1, gpuBusy: () => busy, flushGpu: async () => { flush += 1; } });
  try {
    const r = await llm.req('/v1/chat/completions', { messages: [{ role: 'user', content: 'selam' }] });
    assert.equal(r.code, 200);
    assert.equal(r.json.choices[0].message.content, 'EN: selam');
    assert.ok(llm.proc, 'server is up');
    assert.equal(flush, 1, 'ComfyUI memory was freed before loading');
    // GPU isi: sunucu kapanir
    await llm.releaseGpu();
    assert.equal(llm.proc, null);
    // Is surerken dis istek bekler, is bitince calisir (yeniden yuklenir)
    busy = true;
    const startedAt = Date.now();
    const pending = llm.req('/v1/chat/completions', { messages: [{ role: 'user', content: 'bot' }] });
    setTimeout(() => { busy = false; }, 2500);
    assert.equal((await pending).json.choices[0].message.content, 'EN: bot');
    assert.ok(Date.now() - startedAt >= 2000, 'waited until the job finished');
    // Is icinden (ceviri) cagri beklemez
    busy = true;
    assert.equal((await llm.req('/v1/chat/completions', { messages: [{ role: 'user', content: 'ic' }] }, { externalRequest: false })).code, 200);
    busy = false;
    // Bosta kapanir
    await new Promise((ok) => setTimeout(ok, 1800));
    assert.equal(llm.proc, null, 'closed when idle');
  } finally {
    await llm.close();
  }
});

// Sahne yazari (07.10.2026 yerel modele gecti): film surerken ekran karti bosalana kadar bekler; botlar gibi 330 sn'de
// dusmez, bekleme Kuyruk'ta gorunur (bekliyor), Iptal beklerken de keser.
test('local model: UI tasks wait indefinitely, the wait is reported, can be cancelled while waiting; bots get 503 after the timeout', async () => {
  let busy = true;
  let percent = 10;
  const llm = await fakeLlm({ waitSec: 1, gpuBusy: () => busy, gpuJob: () => (busy ? { typeName: 'Image', percent } : null) });
  try {
    await assert.rejects(llm.req('/v1/chat/completions', { messages: [{ role: 'user', content: 'bot' }] }), /GPU is currently busy/);
    const statuses = [];
    const pending = llm.req('/v1/chat/completions', { messages: [{ role: 'user', content: 'scene' }] }, { waitSec: Infinity, waiting: (b, x) => statuses.push(!b ? 'go' : x?.loading ? `loading ${x.loading}` : `${x.typeName} ${x.percent}%`) });
    setTimeout(() => {
      percent = 55.4;
    }, 1000);
    setTimeout(() => {
      busy = false;
    }, 4500);
    assert.equal((await pending).json.choices[0].message.content, 'EN: scene', 'waitSec (1 s) exceeded but the indefinite task continued');
    // the job holding the GPU and its percent (again when it changes), then the model loading for this request
    assert.deepEqual(statuses, ['Image 10%', 'Image 55.4%', 'go', 'loading fake-model', 'go'], 'start, progress and end of the wait were reported');
    busy = true;
    const d = new AbortController();
    const cancel = llm.req('/v1/chat/completions', { messages: [{ role: 'user', content: 'x' }] }, { waitSec: Infinity, signal: d.signal });
    setTimeout(() => d.abort(), 300);
    await assert.rejects(cancel, (e) => e instanceof CancelError);
  } finally {
    busy = false;
    await llm.close();
  }
});

// A job started while a chat answer is being written waits for it (the text model leaves the GPU after it): it said
// only "Starting", now it says why
test('a GPU job waiting for a chat answer to finish says so, then starts once the text model has left the GPU', async () => {
  const llm = await fakeLlm({ idleSec: 600 });
  const p = await createPanel({ llm });
  try {
    assert.equal((await llm.req('/v1/chat/completions', { messages: [{ role: 'user', content: 'selam' }] })).code, 200);
    llm.ongoing += 1; // an answer being written
    const job = p.queue.add('image', { prompt: 'a cat', model: 'qwen', translate: false });
    await p.waitForState(() => /finishing an answer/.test(p.queue.jobs.get(job.id).progress?.detail ?? ''));
    assert.ok(llm.proc, 'the text model stays until the answer ends');
    llm.ongoing -= 1;
    await p.waitForState(() => p.queue.jobs.get(job.id).status === 'done', 30000);
    assert.equal(llm.proc, null, 'then it left the GPU');
  } finally {
    llm.ongoing = 0; // a failed step must not leave the job waiting (the panel would not close)
    await llm.close();
    await p.close();
  }
});

// Two chats on different models (log 08.10.2026: "Switching gemma → Bonsai", then "Loading gemma"): the request that
// began a switch is served first, and a chat's next step right after its last one keeps the loaded model.
test('local model: a switch to another model is not undone by a request for the old one; a quick next step keeps the model', async () => {
  const logs = [];
  const llm = new LocalLlm({ info: { name: 'a', file: 'a.gguf', models: [{ file: 'a.gguf', name: 'a' }, { file: 'b.gguf', name: 'b' }], command: (port, i) => ({ command: process.execPath, args: [FAKE, String(port), i?.file ?? 'a.gguf'] }) }, port: await freePort(), readySec: 20, switchGraceMs: 1500, log: (m) => logs.push(m) });
  const ask = (file) => llm.req('/v1/chat/completions', { messages: [{ role: 'system', content: 'You are the assistant and agent of Nedese Studio.' }, { role: 'user', content: 'which model' }] }, { info: llm.modelInfo(file) }).then((r) => r.json.choices[0].message.content);
  try {
    assert.equal(await ask('a.gguf'), 'Model: a.gguf');
    // b comes within the grace after a's answer, a's next step 300 ms later: a is served without a switch, then b
    const order = [];
    const b = ask('b.gguf').then((t) => order.push(t));
    await new Promise((ok) => setTimeout(ok, 300));
    const a2 = ask('a.gguf').then((t) => order.push(t));
    await Promise.all([b, a2]);
    assert.deepEqual(order, ['Model: a.gguf', 'Model: b.gguf'], "a's quick next step kept the loaded model");
    // b is loaded and idle past the grace: a asks (switch begins), b asks right after: a is served first, b is not
    // loaded again in between
    await new Promise((ok) => setTimeout(ok, 1600));
    logs.length = 0;
    order.length = 0;
    const a3 = ask('a.gguf').then((t) => order.push(t));
    const b2 = ask('b.gguf').then((t) => order.push(t));
    await Promise.all([a3, b2]);
    assert.deepEqual(order, ['Model: a.gguf', 'Model: b.gguf'], 'the request that began the switch went first');
    const loads = logs.filter((m) => /^(Switching|Loading)/.test(m)).map((m) => m.replace(/ \(.*$/, ''));
    assert.deepEqual(loads, ['Switching text model: b → a', 'Loading text model: a', 'Switching text model: a → b', 'Loading text model: b'], 'no reload of b between');
    // nothing loaded, both at once: the first load is served before the other model replaces it
    await llm.close();
    await new Promise((ok) => setTimeout(ok, 1600));
    logs.length = 0;
    order.length = 0;
    await Promise.all([ask('a.gguf').then((t) => order.push(t)), ask('b.gguf').then((t) => order.push(t))]);
    assert.deepEqual(order, ['Model: a.gguf', 'Model: b.gguf']);
    assert.deepEqual(logs.filter((m) => /^(Switching|Loading)/.test(m)), ['Loading text model: a', 'Switching text model: a → b', 'Loading text model: b']);
  } finally {
    await llm.close();
  }
});

test('/llm/v1: key required; responses in DeepSeek format and JSON; chat/completions; models', async () => {
  const llm = await fakeLlm();
  const p = await createPanel({ server: true, llm });
  try {
    const key = p.settingFile.apiKey;
    const req = (path, body, a = key) => fetch(`${p.address}/llm/v1${path}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(a ? { Authorization: `Bearer ${a}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    assert.equal((await req('/models', null, null)).status, 401);
    assert.equal((await req('/models', null, 'falseItem')).status, 401);
    const models = (await (await req('/models')).json()).data;
    assert.deepEqual([models[0].id, typeof models[0].image], ['fake-model', 'boolean'], 'does it read images (Data Panel asks before captioning)');
    const r = await req('/responses', { model: 'deepseek-v4-flash', instructions: 'Yanıt JSON', input: 'Merhaba dünya', text: { format: { type: 'json_object' } }, max_output_tokens: 100 });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.status, 'completed');
    const text = j.output.find((o) => o.type === 'message').content.find((c) => c.type === 'output_text').text;
    const raw = JSON.parse(text);
    assert.equal(raw.prompt, 'Merhaba dünya', 'Turkish text passes through raw, untranslated');
    assert.ok(raw.system.startsWith('Yanıt JSON'), 'sistem istemi korunur (sonuna uzunluk notu eklenir)');
    const s = await req('/chat/completions', { messages: [{ role: 'user', content: 'Off' }] });
    assert.equal((await s.json()).choices[0].message.content, 'EN: Off', 'panel dictionary does not touch model output');
    assert.equal((await req('/none', {})).status, 404);
    // Bolumlu ozgun yazi: plan + 5 bolum, tek JSON (botun bekledigi alanlar), bolum basina tek <h2>
    const b = await req('/responses', { model: 'deepseek-v4-flash', instructions: 'Kılavuz', input: 'Kaynak haber', text: { format: { type: 'json_object' } }, temperature: 0.7, metadata: { sectioned: true } });
    assert.equal(b.status, 200);
    const bj = await b.json();
    const article = JSON.parse(bj.output.find((o) => o.type === 'message').content.find((c) => c.type === 'output_text').text);
    assert.deepEqual(Object.keys(article).sort(), ['category_name', 'content', 'excerpt', 'meta_description', 'meta_keywords', 'meta_title', 'tag_keywords_en', 'title']);
    assert.equal((article.content.match(/<h2>/g) ?? []).length, 5, 'one heading per section');
    assert.ok(!article.content.includes('Fazla'), 'second heading was dropped');
    assert.ok(article.content.startsWith('<p>Giriş paragrafı.</p><h2>Bölüm 1</h2>'));
  } finally {
    await llm.close();
    await p.close();
  }
});
