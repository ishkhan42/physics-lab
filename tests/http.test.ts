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

test('streamed assembly reports a correction and one final decision without admitting the invalid first model', async t => {
  const port = await localPort(t);
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'isolated-test-credential';
  let calls = 0;
  globalThis.fetch = async input => {
    if (String(input).endsWith('/models')) return Response.json({ data: [] });
    calls += 1;
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ decision: {
      kind: calls === 1 ? 'scene' : 'clarify',
      summary: 'Your experiment needs a direction.',
      assumptions: [], question: calls === 1 ? null : 'Which direction is the applied force?',
      reason: null, scene: null, alternative: null, approximation: null,
    } }) } }] });
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
  });
  const result = await new Promise<{ type: string; stage?: string; decision?: { kind: string } }[]>((resolve, reject) => {
    const client = request({ hostname: '127.0.0.1', port, path: '/api/assemble', method: 'POST', headers: {
      host: '127.0.0.1:3001', 'content-type': 'application/json', accept: 'application/x-ndjson',
    } }, response => {
      assert.match(String(response.headers['content-type']), /application\/x-ndjson/);
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('error', reject);
      response.on('end', () => {
        try { resolve(text.trim().split('\n').map(line => JSON.parse(line))); }
        catch (error) { reject(error); }
      });
    });
    client.on('error', reject);
    client.end(JSON.stringify({ provider: 'openrouter', model: 'openrouter/free', description: 'Move a block with an applied force.' }));
  });
  assert.equal(calls, 2);
  assert.deepEqual(result.filter(item => item.type === 'progress' && item.stage === 'repairing').length, 1);
  assert.equal(result.at(-1)?.type, 'decision');
  assert.equal(result.at(-1)?.decision?.kind, 'clarify');
  assert.equal(result.filter(item => item.type === 'decision').length, 1);
});

test('canceling the streamed wait prevents a later automatic correction charge', { timeout: 5000 }, async t => {
  const server = createApiServer();
  const closed = Promise.withResolvers<void>();
  server.on('request', (_request, response) => response.once('close', () => closed.resolve()));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  const originalFetch = globalThis.fetch;
  const previousKey = process.env.OPENROUTER_API_KEY;
  const upstream = Promise.withResolvers<Response>();
  let modelCalls = 0;
  process.env.OPENROUTER_API_KEY = 'isolated-test-credential';
  globalThis.fetch = async input => {
    if (String(input).endsWith('/models')) return Response.json({ data: [] });
    modelCalls++;
    return upstream.promise;
  };
  t.after(async () => {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const controller = new AbortController();
  const started = Promise.withResolvers<{ stage: string }>();
  const client = request({
    hostname: '127.0.0.1', port, path: '/api/assemble', method: 'POST', signal: controller.signal,
    headers: { host: '127.0.0.1:3001', 'content-type': 'application/json', accept: 'application/x-ndjson' },
  }, response => {
    let text = '';
    response.setEncoding('utf8');
    response.on('data', chunk => {
      text += chunk;
      const newline = text.indexOf('\n');
      if (newline === -1) return;
      try { started.resolve(JSON.parse(text.slice(0, newline))); }
      catch (error) { started.reject(error); }
      controller.abort();
    });
    response.on('error', error => {
      if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') started.reject(error);
    });
  });
  client.on('error', error => { if (error.name !== 'AbortError') started.reject(error); });
  client.end(JSON.stringify({ provider: 'openrouter', model: 'openrouter/free', description: 'A falling ball.' }));
  assert.equal((await started.promise).stage, 'generating');
  await closed.promise;
  upstream.resolve(Response.json({ choices: [{ finish_reason: 'stop', message: {
    content: JSON.stringify({ decision: { kind: 'scene' } }),
  } }] }));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(modelCalls, 1);
});
