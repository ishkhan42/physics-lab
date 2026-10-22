import assert from 'node:assert/strict';
import test from 'node:test';
import { listOpenRouterModels, resolveLabModel } from '../server/providers.ts';
import { HarnessRequestSchema } from '../shared/harness.ts';

test('routing aliases and unrelated malformed rows cannot disable usable models or invent image capability', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const text = { input_modalities: ['text'], output_modalities: ['text'] };
  const vision = { input_modalities: ['text', 'image'], output_modalities: ['text'] };
  globalThis.fetch = async input => {
    const url = input instanceof Request ? input.url : String(input);
    assert.equal(url, 'https://openrouter.ai/api/v1/models');
    return Response.json({ data: [
      { id: '~vendor/latest', name: 'Current route', architecture: text, supported_parameters: ['tools'], context_length: 8192 },
      { id: 'vendor/valid:free', architecture: vision, supported_parameters: ['tools'], context_length: 8192 },
      { id: 'vendor/ambiguous:free', architecture: vision, supported_parameters: ['tools'], context_length: 8192 },
      { id: 'vendor/ambiguous:free', architecture: null, supported_parameters: ['tools'] },
      { id: 'vendor/not-a-chat', architecture: null, supported_parameters: null, context_length: 0 },
      null,
    ] });
  };
  const models = await listOpenRouterModels();
  const ids = new Set(models.map(model => model.id));
  assert.ok(ids.has('~vendor/latest'));
  assert.ok(ids.has('vendor/valid:free'));
  assert.equal(ids.has('vendor/not-a-chat'), false);
  assert.equal(models.filter(model => model.id === 'vendor/ambiguous:free').length, 1);
  const signal = new AbortController().signal;
  assert.deepEqual((await resolveLabModel('openrouter', 'vendor/valid:free', signal)).input, ['text', 'image']);
  assert.deepEqual((await resolveLabModel('openrouter', 'vendor/ambiguous:free', signal)).input, ['text']);
  const alias = HarnessRequestSchema.parse({ provider: 'openrouter', model: '~vendor/latest', description: 'An ideal collision.' });
  assert.deepEqual((await resolveLabModel(alias.provider, alias.model, signal)).input, ['text']);
  assert.equal(HarnessRequestSchema.safeParse({ ...alias, model: 'vendor\nmodel' }).success, false);
});
