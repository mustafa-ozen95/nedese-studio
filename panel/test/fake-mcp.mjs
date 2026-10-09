/**
 * Sahte MCP sunucusu (stdio, JSON-RPC 2.0 satir satir): initialize, tools/list (collect), tools/call.
 * Bir satir gunluk de stdout'a yazar (istemci JSON olmayan satiri atlamali).
 * --slow adds two tools for the time limits: slow (steps progress notifications every `every` ms, then the answer)
 * and hang (never answers); a notifications/cancelled is answered with a log line on stderr.
 * --data <site> [--log <file>]: a source for the data collection job instead: search (JSON results: a short one whose
 * page is on <site>, a long record with its own text), fetch_page (a Markdown article for any address), and two tools
 * the job must never call: delete_note (by its name) and wipe (marked destructive). Every call goes into <file>.
 */
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const slowTools = process.argv.includes('--slow');
const option = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
const dataSite = option('--data');
const callLog = option('--log');
const tools = dataSite ? [] : [{ name: 'collect', description: 'Adds two numbers', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } }];
if (slowTools) tools.push({ name: 'slow', description: 'Reports progress, then answers', inputSchema: { type: 'object', properties: { steps: { type: 'number' }, every: { type: 'number' } } } }, { name: 'hang', description: 'Never answers', inputSchema: { type: 'object', properties: {} } });
if (dataSite) {
  tools.push(
    { name: 'search', description: 'Searches the cat archive', inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Search words' }, limit: { type: 'integer' } }, required: ['query'] }, annotations: { readOnlyHint: true } },
    { name: 'fetch_page', description: 'Reads a page as Markdown', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
    { name: 'delete_note', description: 'Deletes a note', inputSchema: { type: 'object', properties: { id: { type: 'number' } } } },
    { name: 'wipe', description: 'Clears the archive', inputSchema: { type: 'object', properties: {} }, annotations: { destructiveHint: true } },
  );
}
// Long texts of their own words (texts of one vocabulary count as near copies: every word carries the seed)
const WORDS = 'elma armut kiraz vişne ceviz fındık kayısı şeftali erik dut incir nar deniz dağ orman nehir göl ova bulut yağmur kar rüzgâr güneş ay yıldız köprü kale saray çarşı liman fener bahçe tarla'.split(' ');
const longText = (seed, paragraphs = 12) => Array.from({ length: paragraphs }, (_, i) => `Gezgin kedi ${Array.from({ length: 24 }, (_, k) => `${WORDS[(seed * 53 + i * 13 + k * k * 3 + k) % WORDS.length]}${seed}`).join(' ')}.`).join('\n\n');
function dataAnswer(name, args) {
  if (name === 'search') {
    const n = String(args.query ?? '').length;
    return JSON.stringify({ query: args.query, results: [
      { title: 'Gezgin kedi sayfası', url: `${dataSite}/mcp-page`, snippet: 'Kısa bir özet' },
      { title: `Gezgin kedi kaydı ${n}`, url: `${dataSite}/mcp-record-${n}`, content: longText(n) },
    ] });
  }
  if (name === 'fetch_page') return `# Gezgin kedi: ${args.url}\n\n${longText(String(args.url).length + 7)}\n\n- birinci madde gezgin kedi\n- ikinci madde gezgin kedi`;
  return `done: ${name}`;
}
const write = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
process.stdout.write('fake mcp started (log line)\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.method === 'notifications/cancelled') process.stderr.write(`cancelled ${m.params?.requestId}\n`);
  if (m.id === undefined) return; // bildirim
  if (m.method === 'initialize') return write({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', serverInfo: { name: 'fake', version: '1' }, capabilities: { tools: {} }, instructions: 'Fake server.' } });
  if (m.method === 'tools/list') return write({ jsonrpc: '2.0', id: m.id, result: { tools: tools } });
  if (m.method === 'tools/call') {
    const { a, b } = m.params?.arguments ?? {};
    if (dataSite) {
      if (callLog) appendFileSync(callLog, `${m.params?.name} ${JSON.stringify(m.params?.arguments ?? {})}\n`);
      return write({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: dataAnswer(m.params?.name, m.params?.arguments ?? {}) }] } });
    }
    if (slowTools && m.params?.name === 'slow') {
      const g = m.params.arguments ?? {};
      const steps = Number(g.steps) || 5;
      const token = m.params?._meta?.progressToken;
      let i = 0;
      const timer = setInterval(() => {
        i += 1;
        if (token !== undefined) write({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: i, total: steps, message: `step ${i} of ${steps}` } });
        if (i < steps) return;
        clearInterval(timer);
        write({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `done after ${steps} steps` }] } });
      }, Number(g.every) || 100);
      return;
    }
    if (slowTools && m.params?.name === 'hang') return;
    if (m.params?.name !== 'collect') return write({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: `no such tool: ${m.params?.name}` } });
    return write({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: String(Number(a) + Number(b)) }, { type: 'image', mimeType: 'image/png', data: Buffer.from('png').toString('base64') }] } });
  }
  write({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `no such method: ${m.method}` } });
});
