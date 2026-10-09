/**
 * Fake remote MCP server (in the test process) for both HTTP transports:
 *  - streamable: POST /mcp; initialize and tools/list answer JSON, tools/call answers as an event stream (progress
 *    notifications, then the result), the session id travels in Mcp-Session-Id.
 *  - sse (the older transport): GET /sse opens the event stream, its first event "endpoint" names the POST address;
 *    POSTs answer 202 and every response comes over the stream.
 * Tools: collect (a + b), slow (steps progress notifications every `every` ms, then the answer), hang (never answers).
 * Records what it got: requests (method names), headers of the last request, cancelled request ids.
 */
import { createServer } from 'node:http';

const TOOLS = [
  { name: 'collect', description: 'Adds two numbers', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } },
  { name: 'slow', description: 'Reports progress, then answers', inputSchema: { type: 'object', properties: { steps: { type: 'number' }, every: { type: 'number' } } } },
  { name: 'hang', description: 'Never answers', inputSchema: { type: 'object', properties: {} } },
];

export async function startFakeMcpHttp({ transport = 'streamable', instructions = 'Fake HTTP server.' } = {}) {
  const seen = { methods: [], headers: null, cancelled: [], urls: [] };
  const streams = new Map(); // sse session -> response
  let sessions = 0;
  const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));

  /** Runs one JSON-RPC message; send(m) delivers a message to the client, end() closes the answer. */
  async function handle(m, send) {
    if (m.method === 'notifications/cancelled') seen.cancelled.push(m.params?.requestId);
    if (m.id === undefined) return;
    if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', serverInfo: { name: 'fake-http', version: '1' }, capabilities: { tools: {} }, instructions } });
    if (m.method === 'tools/list') return send({ jsonrpc: '2.0', id: m.id, result: { tools: TOOLS } });
    if (m.method === 'tools/call') {
      const g = m.params?.arguments ?? {};
      if (m.params?.name === 'collect') return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: String(Number(g.a) + Number(g.b)) }] } });
      if (m.params?.name === 'slow') {
        const token = m.params?._meta?.progressToken;
        const steps = Number(g.steps) || 5;
        for (let i = 1; i <= steps; i++) {
          await wait(Number(g.every) || 100);
          if (token !== undefined) send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: i, total: steps, message: `step ${i} of ${steps}` } });
        }
        return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `done after ${steps} steps` }] } });
      }
      if (m.params?.name === 'hang') return new Promise(() => {});
      return send({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: `no such tool: ${m.params?.name}` } });
    }
    return send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `no such method: ${m.method}` } });
  }

  const server = createServer(async (req, res) => {
    seen.urls.push(`${req.method} ${req.url}`);
    seen.headers = req.headers;
    const url = new URL(req.url, 'http://x');
    if (transport === 'sse' && req.method === 'GET' && url.pathname === '/sse') {
      sessions += 1;
      const id = `s${sessions}`;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(`event: endpoint\ndata: /messages?session=${id}\n\n`);
      streams.set(id, res);
      req.on('close', () => streams.delete(id));
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405);
      return res.end();
    }
    let body = '';
    for await (const p of req) body += p;
    const m = JSON.parse(body);
    seen.methods.push(m.method);
    if (transport === 'sse') {
      const stream = streams.get(url.searchParams.get('session'));
      if (url.pathname !== '/messages' || !stream) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(202);
      res.end('Accepted');
      handle(m, (x) => stream.write(`event: message\ndata: ${JSON.stringify(x)}\n\n`));
      return;
    }
    // streamable HTTP
    if (m.id === undefined) {
      await handle(m, () => {});
      res.writeHead(202);
      return res.end();
    }
    const headers = { 'Mcp-Session-Id': 'fake-session' };
    if (m.method === 'tools/call') {
      res.writeHead(200, { ...headers, 'Content-Type': 'text/event-stream' });
      await handle(m, (x) => res.write(`event: message\ndata: ${JSON.stringify(x)}\n\n`));
      return res.end();
    }
    await handle(m, (x) => {
      res.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(x));
    });
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    url: transport === 'sse' ? `${base}/sse` : `${base}/mcp`,
    seen,
    close: () => new Promise((ok) => {
      for (const s of streams.values()) s.end();
      server.closeAllConnections?.();
      server.close(ok);
    }),
  };
}
