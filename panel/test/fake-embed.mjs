/**
 * A fake embedding server in place of llama-server --embedding (Knowledge tests): GET /health, POST /v1/embeddings
 * ({ input: [..] } -> { data: [{ index, embedding }] }). A text's vector is its words hashed into 64 dimensions, with a
 * few words of the same meaning on one dimension (car, automobile, araba, otomobil...), so a search by meaning finds a
 * passage that shares no word with the query. The prefixes of e5 ("query: ", "passage: ") are left out of the words.
 * FAKE_EMBED_LOG: every request's inputs are appended to that file (one JSON line).
 *   node fake-embed.mjs <port> [model]
 */
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';

const port = Number(process.argv[2]);
const SAME = { automobile: 'car', araba: 'car', otomobil: 'car', vehicle: 'car', arac: 'car', revenue: 'income', gelir: 'income', gelirler: 'income', earnings: 'income', kazanc: 'income' };
const DIM = 64;

function vector(text) {
  const v = new Array(DIM).fill(0);
  const words = String(text).replace(/^(query|passage): /, '').toLocaleLowerCase('tr').replace(/ı/g, 'i').normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter(Boolean);
  for (const w of words) {
    const key = SAME[w] ?? SAME[w.replace(/s$/, '')] ?? w;
    let h = 0;
    for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    v[h % DIM] += 1;
  }
  return v;
}

createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"status":"ok"}');
  }
  if (req.method === 'POST' && req.url === '/v1/embeddings') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { input } = JSON.parse(body);
      const list = Array.isArray(input) ? input : [input];
      if (process.env.FAKE_EMBED_LOG) appendFileSync(process.env.FAKE_EMBED_LOG, `${JSON.stringify(list)}\n`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: list.map((t, index) => ({ object: 'embedding', index, embedding: vector(t) })) }));
    });
    return;
  }
  res.writeHead(404);
  res.end();
}).listen(port, '127.0.0.1');
