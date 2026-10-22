import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { labModel, streamLabModel } from '../server/providers.ts';

test('reasoning-required and non-reasoning routes both complete an enforced verdict', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input.clone() : new Request(input, init);
    const body = await request.json() as { reasoning?: { effort?: string } };
    if (body.reasoning?.effort === 'none') return Response.json({ error: { message: 'Reasoning is mandatory.', code: 400 } }, { status: 400 });
    if (body.reasoning && body.reasoning.effort !== 'low') return Response.json({ error: { message: 'The route requires bounded reasoning.', code: 400 } }, { status: 400 });
    const id = 'isolated-reasoning-verdict';
    const chunk = { id, object: 'chat.completion.chunk', created: 1, model: 'openrouter/free', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'verdict', type: 'function', function: { name: 'submit_review', arguments: JSON.stringify({ approved: true, findings: [] }) } }] }, finish_reason: null }] };
    const done = { id, object: 'chat.completion.chunk', created: 1, model: 'openrouter/free', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  };
  const context = normalizeContext({ messages: [{ role: 'system', content: 'Submit the checked verdict.', toolsAdded: [{ name: 'submit_review', description: 'Submit a verdict.', parameters: { type: 'object', properties: { approved: { type: 'boolean' }, findings: { type: 'array', items: { type: 'string' } } }, required: ['approved', 'findings'] } }], timestamp: 1 }] });
  for (const reasoning of [true, false]) {
    let verdict: unknown;
    await streamLabModel('openrouter', { ...labModel('openrouter', 'openrouter/free'), reasoning }, context, new AbortController().signal, event => {
      if (event.type === 'done') verdict = event.message.content.find(block => block.type === 'toolCall');
    }, 'isolated-test-key', 'submit_review');
    assert.ok(verdict && typeof verdict === 'object' && 'arguments' in verdict);
    assert.deepEqual(verdict.arguments, { approved: true, findings: [] });
  }
});
