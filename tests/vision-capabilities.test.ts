import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { ProviderError, labModel, resolveLabModel, streamLabModel } from '../server/providers.ts';
import { validateModelContext } from '../server/harness.ts';
import { MAX_JPEG_BASE64 } from '../shared/visual-inspection.ts';
import { sandboxResourceArgs } from '../server/sandbox.ts';

const jpegData = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xd9]).toString('base64');
const jpeg = { type: 'image' as const, data: jpegData, mimeType: 'image/jpeg' as const };
const sceneTool = { name: 'inspect_scene', description: 'Inspect the actual scene renderer.', parameters: {} };
const builderTool = { name: 'inspect_catalog', description: 'Read the supported physics catalog.', parameters: {} };
const reviewTool = { name: 'submit_review', description: 'Return the independent verdict.', parameters: {} };
const userContext = (content: unknown) => ({ messages: [
  { role: 'system', content: 'Use only declared lab tools.', toolsAdded: [builderTool], timestamp: 0 },
  { role: 'user', content, timestamp: 1 },
] });

// The real Pi adapter is used; only the catalog and provider response are replaced.
test('exact OpenRouter image metadata reaches the pinned provider request', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const imageId = 'fixture/plain-id';
  const catalog = { data: [
    { id: imageId, name: 'Vision Model', architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] }, supported_parameters: ['tools'], context_length: 8192 },
    { id: 'fixture/vision-by-name', name: 'Ordinary model', architecture: { input_modalities: ['text'], output_modalities: ['text'] }, supported_parameters: ['tools'], context_length: 8192 },
  ] };
  let providerBody: unknown;
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === 'https://openrouter.ai/api/v1/models') return Response.json(catalog);
    if (url === 'https://openrouter.ai/api/v1/chat/completions') {
      const request = input instanceof Request ? input.clone() : new Request(input, init);
      providerBody = await request.json();
      return Response.json({ error: { message: 'PRIVATE_UPSTREAM_SENTINEL', code: 429 } }, { status: 429 });
    }
    throw new Error('Unexpected test request target.');
  };

  const model = await resolveLabModel('openrouter', imageId, new AbortController().signal);
  assert.deepEqual(model.input, ['text', 'image']);
  const textOnly = await resolveLabModel('openrouter', 'fixture/vision-by-name', new AbortController().signal);
  assert.deepEqual(textOnly.input, ['text']);
  const unknown = await resolveLabModel('openrouter', 'fixture/vision-unknown', new AbortController().signal);
  assert.deepEqual(unknown.input, ['text']);
  assert.deepEqual(labModel('openrouter', 'fixture/vision-unknown').input, ['text']);

  const context = normalizeContext(validateModelContext(userContext([{ type: 'text', text: 'Inspect this frame.' }, jpeg]), model, 'builder'));
  await assert.rejects(streamLabModel('openrouter', model, context, new AbortController().signal, () => {}, 'isolated-test-key'), error => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.code, 'provider_rate_limited');
    assert.ok(!error.message.includes('PRIVATE_UPSTREAM_SENTINEL'));
    return true;
  });
  assert.ok(JSON.stringify(providerBody ?? {}).includes(`data:image/jpeg;base64,${jpegData}`), 'the Pi provider adapter must serialize the admitted image into the actual model request');
});

test('image blocks and inspect_scene are rejected for text-only or unknown models', () => {
  const unknown = labModel('openrouter', 'fixture/vision-unknown');
  assert.throws(() => validateModelContext(userContext([{ type: 'text', text: 'Frame' }, jpeg]), unknown, 'builder'));
  assert.throws(() => validateModelContext({ messages: [{ role: 'system', content: 'Use only available tools.', toolsAdded: [sceneTool], timestamp: 1 }] }, unknown, 'builder'));
  assert.throws(() => validateModelContext({ messages: [
    { role: 'system', content: 'Use only available tools.', toolsAdded: [sceneTool], timestamp: 1 },
    { role: 'assistant', content: [{ type: 'toolCall', id: 'call_1', name: 'inspect_scene', arguments: {} }], timestamp: 2 },
  ] }, unknown, 'builder'));
  assert.throws(() => validateModelContext({ messages: [
    { role: 'system', content: 'Use only available tools.', toolsAdded: [sceneTool], timestamp: 1 },
    { role: 'toolResult', toolCallId: 'call_1', toolName: 'inspect_scene', content: [{ type: 'text', text: 'Frame' }], isError: false, timestamp: 2 },
  ] }, unknown, 'builder'));
});
test('model purpose must match the active declared tool scope', () => {
  const model = labModel('openrouter', 'fixture/model');
  const context = (toolsAdded: unknown[], toolsRemoved?: unknown[]) => ({
    messages: [
      { role: 'system', content: 'Use only declared lab tools.', toolsAdded, timestamp: 1 },
      ...(toolsRemoved ? [{ role: 'system', content: 'Update active lab tools.', toolsRemoved, timestamp: 2 }] : []),
    ],
  });
  const isScopeFailure = (error: unknown) => error instanceof ProviderError && error.code === 'lab_tool_scope';

  assert.doesNotThrow(() => validateModelContext(context([builderTool]), model, 'builder'));
  assert.doesNotThrow(() => validateModelContext(context([reviewTool]), model, 'reviewer'));
  assert.doesNotThrow(() => validateModelContext(context([reviewTool, builderTool], [builderTool]), model, 'reviewer'));
  assert.doesNotThrow(() => validateModelContext(context([reviewTool, builderTool], [{ name: reviewTool.name }]), model, 'builder'));
  assert.throws(() => validateModelContext(context([reviewTool]), model, 'builder'), isScopeFailure);
  assert.throws(() => validateModelContext(context([builderTool]), model, 'reviewer'), isScopeFailure);
  assert.throws(() => validateModelContext(context([reviewTool, builderTool]), model, 'reviewer'), isScopeFailure);
});

test('only bounded canonical inline JPEG content is admitted in user and scene-tool results', async () => {
  const model = await resolveLabModel('openai', 'gpt-4o', new AbortController().signal);
  assert.ok(model.input.includes('image'));
  assert.deepEqual((await resolveLabModel('openai', 'gpt-4o-image', new AbortController().signal)).input, ['text']);
  const sceneContext = { messages: [
    { role: 'system', content: 'Inspect only through the scene tool.', toolsAdded: [sceneTool], timestamp: 1 },
    { role: 'assistant', content: [{ type: 'toolCall', id: 'call_1', name: 'inspect_scene', arguments: {} }], timestamp: 2 },
    { role: 'toolResult', toolCallId: 'call_1', toolName: 'inspect_scene', content: [{ type: 'text', text: 'Rendered frame.' }, jpeg], isError: false, timestamp: 3 },
  ] };
  const admitted = validateModelContext(sceneContext, model, 'builder');
  assert.ok(JSON.stringify(normalizeContext(admitted)).includes(jpegData));

  for (const image of [
    { type: 'image', url: 'https://example.invalid/frame.jpg', mimeType: 'image/jpeg' },
    { type: 'image', data: `data:image/jpeg;base64,${jpegData}`, mimeType: 'image/jpeg' },
    { type: 'image', data: Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0]).toString('base64'), mimeType: 'image/jpeg' },
    { type: 'image', data: `/9j/${'A'.repeat(MAX_JPEG_BASE64)}`, mimeType: 'image/jpeg' },
  ]) assert.throws(() => validateModelContext(userContext([image]), model, 'builder'));

  assert.throws(() => validateModelContext({ messages: [{ role: 'system', content: [jpeg], timestamp: 1 }] }, model, 'builder'));
  assert.throws(() => validateModelContext({ messages: [{ role: 'assistant', content: [jpeg], timestamp: 1 }] }, model, 'builder'));
  assert.throws(() => validateModelContext({ messages: [{ role: 'toolResult', toolCallId: 'call_1', toolName: 'check_experiment', content: [jpeg], isError: false, timestamp: 1 }] }, model, 'builder'));
});
test('sandbox limits use resolved init model input, not request fields', () => {
  assert.deepEqual(sandboxResourceArgs({ model: { input: ['text', 'image'] }, request: { model: 'text-only' } }), ['--memory=1g', '--pids-limit=128', '--tmpfs', '/tmp:rw,noexec,nosuid,size=128m']);
  assert.deepEqual(sandboxResourceArgs({ model: { input: ['text'] }, request: { model: { input: ['text', 'image'] } } }), ['--memory=512m', '--pids-limit=64', '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m']);
  assert.deepEqual(sandboxResourceArgs({ request: { model: { input: ['image'] } } }), ['--memory=512m', '--pids-limit=64', '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m']);
});
