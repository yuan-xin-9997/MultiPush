import { preview } from 'vite';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const directory = await mkdtemp(join(tmpdir(), 'turbopush-web-'));
process.env.TURBOPUSH_DATA_DIR = directory;
process.env.TURBOPUSH_PORT = '34081';
const server = await preview({ root: resolve('apps/desktop'), configFile: resolve('apps/desktop/vite.config.ts') });
const base = 'http://127.0.0.1:34081';
try {
  assert.equal((await fetch(base)).status, 200);
  const headers = { Origin: base, 'Content-Type': 'application/json' };
  const response = await fetch(`${base}/__rpc`, { method: 'POST', headers, body: JSON.stringify({ id: 'web-test', method: 'snapshot' }) });
  assert.equal(response.status, 200);
  assert.ok((await response.json()).result);
  assert.equal((await fetch(`${base}/__rpc`, { method: 'POST', headers: { ...headers, Origin: 'http://evil.example' }, body: '{}' })).status, 403);
  const uploadHeaders = { Origin: base, 'Content-Type': 'application/octet-stream' };
  const invalid = await fetch(`${base}/__upload`, { method: 'POST', headers: uploadHeaders, body: 'invalid' });
  assert.equal(invalid.status, 400);
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+3MxZ5wAAAABJRU5ErkJggg==', 'base64');
  const uploaded = await fetch(`${base}/__upload`, { method: 'POST', headers: uploadHeaders, body: image });
  assert.equal(uploaded.status, 200);
  assert.ok((await uploaded.json()).result.startsWith(directory));
  console.log('Web smoke passed: static page, configured port, RPC, origin rejection, image upload.');
} finally {
  await new Promise<void>((done, reject) => server.httpServer.close(error => error ? reject(error) : done()));
  // Service shutdown is asynchronous on HTTP close.
  await new Promise(done => setTimeout(done, 200));
  await rm(directory, { recursive: true, force: true });
}
