import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { labModel, ProviderError, streamLabModel } from '../server/providers.ts';

const context = normalizeContext({ messages: [{ role: 'system', content: 'Submit a verdict.', toolsAdded: [{ name: 'submit_review', description: 'Submit a verdict.', parameters: { type: 'object', properties: { approved: { type: 'boolean' }, findings: { type: 'array', items: { type: 'string' } } }, required: ['approved', 'findings'] } }], timestamp: 1 }] });
function providerStream(chunks: number): Response {
  const encoder = new TextEncoder();
  const envelope = { id: 'wire-overhead', object: 'chat.completion.chunk', created: 1, model: 'example/model', system_fingerprint: 'metadata'.repeat(512) };
  const delta = encoder.encode(`data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta: { content: '.' }, finish_reason: null }] })}\n\n`);
  const verdict = encoder.encode(`data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'verdict', type: 'function', function: { name: 'submit_review', arguments: JSON.stringify({ approved: true, findings: [] }) } }] }, finish_reason: null }] })}\n\n`);
  const done = encoder.encode(`data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
  let index = 0;
  return new Response(new ReadableStream({ pull(controller) { if (index < chunks) controller.enqueue(delta); else if (index === chunks) controller.enqueue(verdict); else if (index === chunks + 1) controller.enqueue(done); else controller.close(); index++; } }), { headers: { 'content-type': 'text/event-stream' } });
}

test('valid streamed tool output is not rejected because of repeated provider envelope metadata', async t => {
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  globalThis.fetch = async () => providerStream(1024);
  let verdict: unknown;
  await streamLabModel('openrouter', labModel('openrouter', 'example/model'), context, new AbortController().signal, event => { if (event.type === 'done') verdict = event.message.content.find(block => block.type === 'toolCall'); }, 'isolated-test-key', 'submit_review');
  assert.ok(verdict && typeof verdict === 'object' && 'arguments' in verdict);
  assert.deepEqual(verdict.arguments, { approved: true, findings: [] });
});

test('stream envelope overhead still has a hard wire-size bound', async t => {
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  globalThis.fetch = async () => providerStream(8192);
  await assert.rejects(streamLabModel('openrouter', labModel('openrouter', 'example/model'), context, new AbortController().signal, () => {}, 'isolated-test-key', 'submit_review'), error => error instanceof ProviderError && error.code === 'provider_response_too_large');
});
