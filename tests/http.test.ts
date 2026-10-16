import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApiServer } from '../server/index.ts';

async function localPort(t: TestContext): Promise<number> {
  const server = createApiServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    const closed = Promise.withResolvers<void>();
    server.close(error => error ? closed.reject(error) : closed.resolve());
    await closed.promise;
  });
  return (server.address() as AddressInfo).port;
}

function send(port: number, body: string | Buffer, headers: Record<string, string> = {}, leaveUploadOpen = false): Promise<{ status: number; code: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number; code: string }>();
  const client = request({ hostname: '127.0.0.1', port, method: 'POST', path: '/api/assemble', headers: {
    host: '127.0.0.1:3001', 'content-type': 'application/json', ...headers,
  } }, response => {
    let received = '';
    response.setEncoding('utf8');
    response.on('data', chunk => { received += chunk; });
    response.on('error', reject);
    response.on('end', () => {
      client.end();
      try { resolve({ status: response.statusCode!, code: JSON.parse(received).error.code }); }
      catch (error) { reject(error); }
    });
  });
  client.on('error', reject);
  if (leaveUploadOpen) client.write(body);
  else client.end(body);
  return promise;
}

test('valid JSON reaches schema admission instead of being mislabeled malformed', async t => {
  const port = await localPort(t);
  // Incomplete API fields prevent this isolated parser check from calling a real provider.
  assert.deepEqual(await send(port, JSON.stringify({ description: 'A falling ball' })), { status: 400, code: 'invalid_request' });
  assert.deepEqual(await send(port, '{'), { status: 400, code: 'invalid_json' });
});

test('an oversized chunked upload is rejected before the client ends it', { timeout: 5000 }, async t => {
  const port = await localPort(t);
  assert.deepEqual(await send(port, Buffer.alloc(65537, 32), { 'transfer-encoding': 'chunked' }, true), { status: 413, code: 'payload_too_large' });
});

test('the funded local API rejects foreign origins and rebound hosts', async t => {
  const port = await localPort(t);
  assert.deepEqual(await send(port, '{}', { origin: 'https://untrusted.invalid' }), { status: 403, code: 'forbidden_origin' });
  assert.deepEqual(await send(port, '{}', { host: 'untrusted.invalid' }), { status: 403, code: 'forbidden_host' });
});

test('non-JSON requests cannot cross the assembly boundary', async t => {
  const port = await localPort(t);
  assert.deepEqual(await send(port, '{}', { 'content-type': 'text/plain' }), { status: 415, code: 'unsupported_media_type' });
});
