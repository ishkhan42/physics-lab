import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { createApiServer } from '../server/index.ts';
import { getProviderConfig, labModel, providerKey, ProviderError, resolveLabModel, streamLabModel } from '../server/providers.ts';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';

function demoEnvironment(t: TestContext) {
  const deadline = Date.now() + 12 * 86_400_000;
  for (const [key, value] of Object.entries({ PUBLIC_ORIGINS: 'https://lab.example', PHYSICS_LAB_CONNECTED_GPT: '1', LAB_DEMO_EXPIRES_AT: new Date(deadline).toISOString(), CONNECTED_GPT_SECRET: 'projects/demo-lab/secrets/codex', FIRESTORE_PROJECT_ID: '' })) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  return deadline;
}

test('the public subscription demo serves anonymous visitors and validates their AI requests without a login challenge', async t => {
  demoEnvironment(t);
  const server = createApiServer({ sceneDbPath: ':memory:' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const port = (server.address() as AddressInfo).port;
  const call = (path: string, method = 'GET'): Promise<{ status: number; challenge?: string; body: string }> => new Promise((resolve, reject) => {
    const client = request({ hostname: '127.0.0.1', port, path, method, headers: { host: 'lab.example', 'content-type': 'application/json' } }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode!, challenge: response.headers['www-authenticate'], body }));
    });
    client.on('error', reject);
    client.end(method === 'POST' ? '{}' : undefined);
  });
  const app = await call('/');
  assert.equal(app.status, 200);
  assert.equal(app.challenge, undefined);
  const config = await call('/api/config');
  assert.equal(config.status, 200);
  assert.equal(JSON.parse(config.body).defaultProvider, 'openai-codex');
  assert.equal(JSON.parse(config.body).defaultModel, 'gpt-6-luna');
  assert.ok(!config.body.includes('projects/demo-lab/secrets/codex'));
  const invalid = await call('/api/lab', 'POST');
  assert.equal(invalid.status, 400);
  assert.equal(JSON.parse(invalid.body).error.code, 'invalid_request');
});

test('subscription authorization expires at the exact deadline and never permits another model or paid route', async t => {
  const deadline = demoEnvironment(t);
  const model = await resolveLabModel('openai-codex', 'gpt-6-luna', new AbortController().signal);
  assert.deepEqual(model.input, ['text', 'image']);
  assert.throws(() => labModel('openai-codex', 'another-model'), ProviderError);
  assert.throws(() => labModel('openai', 'gpt-6-luna'), ProviderError);
  assert.throws(() => labModel('openrouter', 'example/paid'), ProviderError);
  t.mock.method(Date, 'now', () => deadline);
  assert.ok(!getProviderConfig().providers.some(provider => provider.id === 'openai-codex' && provider.available));
  await assert.rejects(providerKey('openai-codex'), ProviderError);
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let dispatched = false;
  globalThis.fetch = async () => { dispatched = true; throw new Error('Expired credentials must not reach a provider.'); };
  const context = normalizeContext({ messages: [{ role: 'user', content: 'A falling ball.', timestamp: 1 }] });
  await assert.rejects(streamLabModel('openai-codex', model, context, new AbortController().signal, () => {}, 'already-resolved-token'), ProviderError);
  assert.equal(dispatched, false);
});

test('invalid subscription secret configuration fails closed', t => {
  demoEnvironment(t);
  process.env.CONNECTED_GPT_SECRET = 'https://untrusted.example/credentials';
  assert.throws(() => createApiServer({ sceneDbPath: ':memory:' }), /Hosted subscription demos require/);
});
