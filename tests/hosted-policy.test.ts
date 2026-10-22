import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { createApiServer } from '../server/index.ts';
import { getProviderConfig, labModel, listOpenRouterModels, providerKey, ProviderError, resolveLabModel, streamLabModel } from '../server/providers.ts';

function publicEnvironment(t: TestContext): void {
  for (const [key, value] of Object.entries({ PUBLIC_ORIGINS: 'https://lab.example,https://alias.example', OPENROUTER_API_KEY: 'isolated-free-key', OPENAI_API_KEY: 'isolated-paid-key', PHYSICS_LAB_CONNECTED_GPT: '0' })) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
}

function readConfig(port: number, host: string, origin?: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const client = request({ hostname: '127.0.0.1', port, path: '/api/config', headers: { host, ...(origin ? { origin } : {}) } }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('error', reject);
      response.on('end', () => { try { resolve({ status: response.statusCode!, body: JSON.parse(body) }); } catch (error) { reject(error); } });
    });
    client.on('error', reject);
    client.end();
  });
}

test('hosted requests accept only configured HTTPS origins and application hosts', async t => {
  publicEnvironment(t);
  const server = createApiServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const port = (server.address() as AddressInfo).port;
  assert.equal((await readConfig(port, 'lab.example', 'https://lab.example')).status, 200);
  assert.equal((await readConfig(port, 'alias.example', 'https://alias.example')).status, 200);
  assert.equal((await readConfig(port, 'untrusted.example', 'https://lab.example')).status, 403);
  assert.equal((await readConfig(port, 'lab.example', 'https://untrusted.example')).status, 403);
  assert.equal((await readConfig(port, '127.0.0.1:3001')).status, 403);
  assert.equal((await readConfig(port, 'lab.example')).status, 200);
});

test('hosted origins cannot contain credentials, insecure schemes, paths or queries', t => {
  publicEnvironment(t);
  for (const invalid of ['http://lab.example', 'https://user:password@lab.example', 'https://lab.example/path', 'https://lab.example?target=elsewhere']) {
    process.env.PUBLIC_ORIGINS = invalid;
    assert.throws(() => createApiServer());
  }
});

test('public model policy denies paid routes before dispatch and constrains free upstream pricing', async t => {
  publicEnvironment(t);
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const outgoing: Record<string, unknown>[] = [];
  globalThis.fetch = async (input, init) => {
    const incoming = input instanceof Request ? input.clone() : new Request(input, init);
    if (incoming.url === 'https://openrouter.ai/api/v1/models') return Response.json({ data: [
      { id: 'example/hosted:free', name: 'Free vision', architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] }, supported_parameters: ['tools'], context_length: 32768 },
      { id: 'example/paid', name: 'Paid', architecture: { input_modalities: ['text'], output_modalities: ['text'] }, supported_parameters: ['tools'], context_length: 32768 },
    ] });
    outgoing.push(JSON.parse(await incoming.text()));
    return Response.json({ error: { message: 'deliberate upstream rejection', type: 'invalid_request_error' } }, { status: 400 });
  };
  assert.deepEqual(getProviderConfig().providers.map(provider => provider.id), ['openrouter']);
  assert.throws(() => labModel('openrouter', 'example/paid'), error => error instanceof ProviderError && error.code === 'hosted_free_only');
  assert.throws(() => labModel('openai', 'example/model'), ProviderError);
  await assert.rejects(providerKey('openai'), ProviderError);
  await assert.rejects(providerKey('openai-codex'), ProviderError);
  assert.ok((await listOpenRouterModels()).every(model => model.free));
  const signal = new AbortController().signal;
  const model = await resolveLabModel('openrouter', 'example/hosted:free', signal);
  assert.deepEqual(model.input, ['text', 'image']);
  await assert.rejects(resolveLabModel('openrouter', 'example/missing:free', signal), ProviderError);
  const context = normalizeContext({ messages: [{ role: 'user', content: 'A falling ball.', timestamp: 1 }] });
  await assert.rejects(streamLabModel('openrouter', { ...model, id: 'example/paid' }, context, signal, () => {}), ProviderError);
  assert.equal(outgoing.length, 0);
  await assert.rejects(streamLabModel('openrouter', model, context, signal, () => {}), ProviderError);
  assert.equal(outgoing.length, 1);
  assert.equal(outgoing[0].model, 'example/hosted:free');
  assert.deepEqual(outgoing[0].provider, { require_parameters: true, max_price: { prompt: 0, completion: 0 } });
  assert.deepEqual(outgoing[0].plugins, []);
});
