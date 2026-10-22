import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { TestContext } from 'node:test';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { z } from 'zod';
import { labModel } from '../server/providers.ts';
import { createWorkerGateway } from '../server/worker-gateway.ts';
import { runSandbox, SandboxError } from '../server/sandbox.ts';
import { HarnessRequestSchema } from '../shared/harness.ts';

const ModelRecordSchema = z.object({ type: z.literal('model') }).passthrough();

const SECRET = 'worker_gateway_test_token_7391_not_for_prod';
const REQUEST = HarnessRequestSchema.parse({
  provider: 'openrouter', model: 'example/model', description: 'A synthetic worker lifecycle request.',
});
const INIT = { type: 'init', request: REQUEST, model: labModel('openrouter', 'example/model') };

async function startGateway(t: TestContext) {
  const server = createWorkerGateway({ secret: SECRET });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    if (!server.listening) return;
    const closed = Promise.withResolvers<void>();
    server.close(error => error ? closed.reject(error) : closed.resolve());
    await closed.promise;
  });
  return { server, port: (server.address() as AddressInfo).port };
}

function rejectedUpgrade(port: number, token?: string, path = '/run', origin?: string): Promise<number> {
  const headers: Record<string, string> = token === undefined ? {} : { authorization: `Bearer ${token}` };
  if (origin !== undefined) headers.origin = origin;
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
  const result = Promise.withResolvers<number>();
  socket.once('unexpected-response', (_request, response) => {
    const status = response.statusCode ?? 0;
    response.resume();
    socket.terminate();
    result.resolve(status);
  });
  socket.once('open', () => {
    socket.terminate();
    result.reject(new Error('The gateway accepted an unauthorized or busy connection.'));
  });
  socket.once('error', result.reject);
  return result.promise;
}

function authorizedSocket(port: number): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}/run`, { headers: { authorization: `Bearer ${SECRET}` } });
}

test('worker gateway rejects missing and incorrect bearer authorization before WebSocket acceptance', { timeout: 15_000 }, async t => {
  const { port } = await startGateway(t);
  assert.equal(await rejectedUpgrade(port), 401);
  assert.equal(await rejectedUpgrade(port, 'wrong_worker_gateway_token_123456789'), 401);
  assert.equal(await rejectedUpgrade(port, SECRET, `/run?token=${SECRET}`), 400);
  assert.equal(await rejectedUpgrade(port, SECRET, '/run', 'https://example.invalid'), 403);
});

test('worker gateway rejects invalid init schemas and malformed JSON before spawning a worker', { timeout: 15_000 }, async t => {
  const { port } = await startGateway(t);
  const invalidInit = authorizedSocket(port);
  await once(invalidInit, 'open');
  const initClosed = once(invalidInit, 'close');
  invalidInit.send(JSON.stringify({ type: 'init', request: {}, model: {} }));
  const [initCode] = await initClosed;
  assert.equal(initCode, 1008);

  const malformedJson = authorizedSocket(port);
  await once(malformedJson, 'open');
  const jsonClosed = once(malformedJson, 'close');
  malformedJson.send('{not-json');
  const [jsonCode] = await jsonClosed;
  assert.equal(jsonCode, 1002);
});

test('an authenticated connection that never initializes cannot hold the worker indefinitely', { timeout: 5000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { port } = await startGateway(t);
  const stalled = authorizedSocket(port);
  await once(stalled, 'open');
  const stalledClosed = once(stalled, 'close');
  t.mock.timers.tick(10_000);
  const [code] = await stalledClosed;
  assert.equal(code, 1008);
  const next = authorizedSocket(port);
  await once(next, 'open');
  const nextClosed = once(next, 'close');
  next.close();
  await nextClosed;
});

test('remote sandbox reports rejected worker credentials without starting an experiment', { timeout: 5000 }, async t => {
  const { port } = await startGateway(t);
  for (const [key, value] of Object.entries({ LAB_WORKER_URL: `ws://127.0.0.1:${port}/run`, WORKER_AUTH_TOKEN: 'different_gateway_token_7391_not_for_prod' })) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  const run = runSandbox(INIT, () => assert.fail('An unauthorized worker returned a record.'), new AbortController().signal);
  await assert.rejects(run.done, error => error instanceof SandboxError && error.code === 'worker_auth_failed');
});

test('worker gateway reserves admission through real Docker cleanup on shutdown', { timeout: 60_000 }, async t => {
  const { server, port } = await startGateway(t);
  const socket = authorizedSocket(port);
  await once(socket, 'open');
  const modelRequest = Promise.withResolvers<unknown>();
  socket.on('error', modelRequest.reject);
  socket.on('message', data => {
    let value: unknown;
    try { value = JSON.parse(data.toString()); }
    catch (error) { modelRequest.reject(error); return; }
    if (ModelRecordSchema.safeParse(value).success) modelRequest.resolve(value);
  });
  socket.send(JSON.stringify(INIT));
  await modelRequest.promise;
  for (const [key, value] of Object.entries({ LAB_WORKER_URL: `ws://127.0.0.1:${port}/run`, WORKER_AUTH_TOKEN: SECRET })) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  const blocked = runSandbox(INIT, () => assert.fail('A busy worker accepted another experiment.'), new AbortController().signal);
  await assert.rejects(blocked.done, error => error instanceof SandboxError && error.code === 'worker_busy');

  const socketClosed = once(socket, 'close');
  const serverClosed = Promise.withResolvers<void>();
  server.close(error => error ? serverClosed.reject(error) : serverClosed.resolve());
  const [code, reason] = await socketClosed;
  assert.equal(code, 1012);
  assert.equal(reason.toString(), 'server shutdown');
  await serverClosed.promise;
});
