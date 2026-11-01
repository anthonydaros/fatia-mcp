import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'http-audit', version: '1' } } };
async function server(t, extra = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fatia-http-'));
  const socket = net.createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise(r => socket.close(r));
  const child = spawn(process.execPath, [path.join(ROOT, 'dist/index.js')], { cwd: dir,
    env: { PATH: process.env.PATH || '', MCP_TRANSPORT: 'streamable-http', MCP_HTTP_HOST: '127.0.0.1', MCP_HTTP_PORT: String(port), BAMBU_MODEL: '', TEMP_DIR: '', ...extra }, stdio: ['ignore', 'ignore', 'pipe'] });
  const closed = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await closed; await fs.rm(dir, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server startup timeout')), 10_000);
    let stderr = ''; child.stderr.on('data', data => { stderr += data; if (stderr.includes('running on http://')) { clearTimeout(timer); resolve(); } });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('server exited before listening')); });
  });
  const request = (body = init, headers = {}, method = 'POST', target = '/mcp') => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: target, method,
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers } }, res => {
      let text = ''; res.on('data', chunk => text += chunk); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.setTimeout(5000, () => req.destroy(new Error('request timeout'))); req.on('error', reject); req.end(body === null ? undefined : JSON.stringify(body));
  });
  return { child, port, request, endpoint: new URL(`http://127.0.0.1:${port}/mcp`) };
}

test('HTTP rejects foreign Host and Origin, malformed Host and null Origin, and stays alive', async t => {
  const s = await server(t);
  for (const headers of [{ host: 'attacker.invalid' }, { origin: 'http://attacker.invalid' }, { origin: 'null' }, { origin: 'not-a-url' }]) {
    assert.equal((await s.request(init, headers)).status, 403);
  }
  assert.equal((await s.request(init, { host: '[' })).status, 400);
  assert.equal((await s.request(init, {}, 'POST', '//attacker.invalid/mcp')).status, 400);
  assert.equal((await s.request()).status, 200);
  assert.equal(s.child.exitCode, null);
});

test('configured HTTP origins remain usable by native and explicitly allowed browser clients', async t => {
  const s = await server(t, { MCP_HTTP_ALLOWED_ORIGINS: 'https://trusted.example' });
  assert.equal((await s.request(init, { origin: 'https://trusted.example' })).status, 200);
  assert.equal((await s.request()).status, 200);
});

test('HTTP clients have independent sessions and deleting one preserves the other', async t => {
  const s = await server(t);
  const transports = [new StreamableHTTPClientTransport(s.endpoint), new StreamableHTTPClientTransport(s.endpoint)];
  const clients = [new Client({ name: 'first', version: '1' }), new Client({ name: 'second', version: '1' })];
  t.after(async () => { for (const client of clients) await client.close(); });
  await Promise.all(clients.map((client, i) => client.connect(transports[i])));
  assert.notEqual(transports[0].sessionId, transports[1].sessionId);
  const results = await Promise.all(clients.map(client => client.listTools()));
  assert.equal(results[0].tools.length, 32); assert.equal(results[1].tools.length, 32);
  const sid = transports[0].sessionId;
  assert.equal((await s.request(null, { 'mcp-session-id': sid }, 'DELETE')).status, 200);
  assert.equal((await s.request(null, { 'mcp-session-id': sid }, 'GET')).status, 404);
  assert.equal((await clients[1].listTools()).tools.length, 32);
  const invalid = await clients[1].callTool({ name: 'scale_stl', arguments: { stl_path: 'unused.stl', scale_x: 'oops' } });
  assert.equal(invalid.isError, true);
});

test('stateless HTTP serves initialize and subsequent tool requests on fresh transports', async t => {
  const s = await server(t, { MCP_HTTP_STATEFUL: 'false' });
  assert.equal((await s.request()).status, 200);
  const listed = await s.request({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  assert.equal(listed.status, 200);
  assert.equal(JSON.parse(listed.text).result.tools.length, 32);
});

test('raw JSON overflow numbers are rejected at the MCP argument boundary', async t => {
  const s = await server(t); const initialized = await s.request();
  const response = await fetch(s.endpoint, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': initialized.headers['mcp-session-id'] },
    body: '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"scale_stl","arguments":{"stl_path":"unused.stl","scale_x":1e400}}}' });
  const value = await response.json(); assert.equal(value.result.isError, true); assert.match(value.result.content[0].text, /finite/);
});
