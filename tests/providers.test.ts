import assert from 'node:assert/strict';
import test from 'node:test';
import { zstdDecompressSync } from 'node:zlib';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { getProviderConfig, labModel, providerKey, ProviderError, resolveLabModel, streamLabModel } from '../server/providers.ts';
import { runLab } from '../server/harness.ts';
import { HarnessRequestSchema, type HarnessProgress } from '../shared/harness.ts';
import { projectile } from './fixtures.ts';

// Only the provider boundary is substituted; the broker and Pi adapter run normally.
test('provider failures never echo upstream private text and quota failures do not retry', async t => {
  const originalFetch = globalThis.fetch;
  const previousKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'isolated-credential';
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
  });
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ error: { message: 'PRIVATE_UPSTREAM_SENTINEL', code: 429 } }, { status: 429 });
  };
  const context = normalizeContext({ messages: [{ role: 'user', content: 'A falling sphere.', timestamp: Date.now() }] });
  await assert.rejects(streamLabModel('openrouter', labModel('openrouter', 'example/model'), context, new AbortController().signal, () => {}), error => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.code, 'provider_rate_limited');
    assert.ok(!error.message.includes('PRIVATE_UPSTREAM_SENTINEL'));
    assert.ok(!error.message.includes('isolated-credential'));
    return true;
  });
  assert.equal(calls, 1);
  const redirected = { ...labModel('openrouter', 'example/model'), baseUrl: 'https://untrusted.invalid' };
  await assert.rejects(streamLabModel('openrouter', redirected, context, new AbortController().signal, () => {}), ProviderError);
  assert.equal(calls, 1, 'an endpoint change must be rejected before network dispatch');
  globalThis.fetch = async () => new Response('x'.repeat(2 * 1024 * 1024 + 1));
  await assert.rejects(streamLabModel('openrouter', labModel('openrouter', 'example/model'), context, new AbortController().signal, () => {}), error => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.code, 'provider_response_too_large');
    return true;
  });
});

const reviewTool = {
  name: 'submit_review',
  description: 'Return the independent verdict.',
  parameters: { type: 'object', properties: { approved: { type: 'boolean' } }, required: ['approved'], additionalProperties: false },
};
const reviewContext = normalizeContext({ messages: [
  { role: 'system', content: 'Return exactly the independent verdict tool call.', toolsAdded: [reviewTool], timestamp: 1 },
  { role: 'user', content: 'Review the candidate.', timestamp: 2 },
] });
const reviewProviders = [
  { provider: 'openrouter', model: 'example/model', endpoint: 'https://openrouter.ai/api/v1/chat/completions', choice: { type: 'function', function: { name: 'submit_review' } } },
  { provider: 'openai', model: 'example/model', endpoint: 'https://api.openai.com/v1/responses', choice: { type: 'function', name: 'submit_review' } },
  { provider: 'anthropic', model: 'example/model', endpoint: 'https://api.anthropic.com/v1/messages?beta=true', choice: { type: 'tool', name: 'submit_review' } },
  { provider: 'openai-codex', model: 'gpt-6-luna', endpoint: 'https://chatgpt.com/backend-api/codex/responses', choice: { type: 'function', name: 'submit_review' } },
] as const;

test('builder and reviewer requests enforce native tool use across providers without a text fallback', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const requests: { url: string; body: { tool_choice?: unknown; tools?: { name?: string; function?: { name?: string } }[] } }[] = [];
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input.clone() : new Request(input, init);
    const wire = Buffer.from(await request.arrayBuffer());
    const bodyBytes = request.headers.get('content-encoding') === 'zstd' ? zstdDecompressSync(wire) : wire;
    const body = JSON.parse(bodyBytes.toString('utf8'));
    requests.push({ url: request.url, body });
    return Response.json({ error: { message: 'PRIVATE_UPSTREAM_SENTINEL', type: 'invalid_request_error' } }, { status: 400 });
  };
  const codexCredential = `fixture.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'isolated-account' } })).toString('base64url')}.fixture`;

  for (const item of reviewProviders) {
    for (const requirement of ['submit_review', 'any'] as const) {
      const before = requests.length;
      await assert.rejects(
        streamLabModel(item.provider, labModel(item.provider, item.model), reviewContext, new AbortController().signal, () => {}, item.provider === 'openai-codex' ? codexCredential : 'isolated-test-key', requirement),
        error => {
          assert.ok(error instanceof ProviderError);
          assert.equal(error.code, 'provider_tool_choice_rejected');
          assert.ok(!error.message.includes('PRIVATE_UPSTREAM_SENTINEL'));
          assert.equal(error.status, 502);
          return true;
        },
      );
      assert.equal(requests.length, before + 1, 'a rejected required-tool request is not retried');
      const request = requests.at(-1)!;
      assert.equal(request.url, item.endpoint);
      assert.deepEqual(request.body.tool_choice, requirement === 'any' ? item.provider === 'anthropic' ? { type: 'any' } : 'required' : item.choice);
      assert.deepEqual(request.body.tools?.map(tool => tool.function?.name ?? tool.name), ['submit_review']);
    }
  }
});

test('a required named tool absent from the active transcript is denied before provider dispatch', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({});
  };
  const context = normalizeContext({ messages: [{
    role: 'system', content: 'Use only the declared builder tool.',
    toolsAdded: [{ name: 'inspect_catalog', description: 'Read the catalog.', parameters: {} }], timestamp: 1,
  }] });
  await assert.rejects(
    streamLabModel('openrouter', labModel('openrouter', 'example/model'), context, new AbortController().signal, () => {}, 'isolated-test-key', 'submit_review'),
    error => error instanceof ProviderError && error.code === 'required_tool_unavailable',
  );
  assert.equal(calls, 0);
  await assert.rejects(
    streamLabModel('openrouter', labModel('openrouter', 'example/model'), normalizeContext({ messages: [{ role: 'user', content: 'No tools are declared.', timestamp: 1 }] }), new AbortController().signal, () => {}, 'isolated-test-key', 'any'),
    error => error instanceof ProviderError && error.code === 'required_tool_unavailable',
  );
  assert.equal(calls, 0);
});

test('the host broker reports actual builder and reviewer requests with authoritative budgets', { timeout: 60_000 }, async t => {
  const originalFetch = globalThis.fetch;
  const previousKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'isolated-broker-key';
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
  });
  const outgoing: { role: 'builder' | 'reviewer'; names: string[]; toolChoice: unknown }[] = [];
  const candidate = {
    kind: 'scene', summary: 'A horizontal projectile.', assumptions: ['No ground interaction is intended during the bounded check.'],
    question: null, reason: null, scene: projectile(), approximation: null, alternative: null,
  };
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === 'https://openrouter.ai/api/v1/models') {
      return Response.json({ data: [{
        id: 'example/model',
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        supported_parameters: ['tools'],
        context_length: 8192,
      }] });
    }
    if (url !== 'https://openrouter.ai/api/v1/chat/completions') throw new Error('Unexpected test request target.');
    const request = input instanceof Request ? input.clone() : new Request(input, init);
    const body = await request.json() as {
      tools?: { name?: string; function?: { name?: string } }[];
      tool_choice?: unknown;
    };
    const names = body.tools?.map(tool => tool.function?.name ?? tool.name).filter((name): name is string => typeof name === 'string') ?? [];
    const role = names.includes('submit_review') ? 'reviewer' : 'builder';
    outgoing.push({ role, names, toolChoice: body.tool_choice });
    const toolName = role === 'reviewer' ? 'submit_review' : 'finish_experiment';
    const args = role === 'reviewer' ? { approved: true, findings: [] } : { decision: candidate };
    const id = `chatcmpl-${outgoing.length}`;
    const message = {
      id, object: 'chat.completion.chunk', created: 1, model: 'example/model',
      choices: [{ index: 0, delta: { tool_calls: [{
        index: 0, id: `call_${outgoing.length}`, type: 'function',
        function: { name: toolName, arguments: JSON.stringify(args) },
      }] }, finish_reason: null }],
    };
    const done = { id, object: 'chat.completion.chunk', created: 1, model: 'example/model', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] };
    return new Response(`data: ${JSON.stringify(message)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  };

  const publicProgress: HarnessProgress[] = [];
  const decision = await runLab(
    HarnessRequestSchema.parse({ provider: 'openrouter', model: 'example/model', description: 'A horizontal projectile with an initial horizontal velocity.' }),
    event => publicProgress.push(event),
    () => {},
    new AbortController().signal,
  );
  assert.equal(decision.kind, 'scene');
  assert.deepEqual(outgoing.map(request => request.role), ['builder', 'reviewer']);
  assert.ok(!outgoing[0]!.names.includes('submit_review'));
  assert.equal(outgoing[0]!.toolChoice, 'required', 'a builder cannot spend a request on plain text instead of a lab action');
  assert.deepEqual(outgoing[1]!.names, ['submit_review']);
  assert.deepEqual(outgoing[1]!.toolChoice, { type: 'function', function: { name: 'submit_review' } });
  assert.equal(outgoing.length, 2, 'one builder and one reviewer API request are brokered, without fallback');

  assert.deepEqual(publicProgress.find(event => event.stage === 'starting')?.budget, {
    modelRequests: 0, modelRequestLimit: 16, toolCalls: 0, toolCallLimit: 24,
  });
  const builderProgress = publicProgress.find(event => event.role === 'builder' && event.stage === 'generating' && event.budget?.modelRequests === 1);
  const reviewerProgress = publicProgress.find(event => event.role === 'reviewer' && event.stage === 'reviewing' && event.budget?.modelRequests === 2);
  assert.ok(builderProgress);
  assert.ok(reviewerProgress);
  assert.equal(builderProgress.budget?.modelRequestLimit, 16);
  assert.equal(reviewerProgress.budget?.modelRequestLimit, 16);
  assert.equal(reviewerProgress.budget?.toolCalls, 1, 'the host retains the worker tool count before admitting the reviewer call');
  assert.equal(reviewerProgress.budget?.toolCallLimit, 24);
  const finalProgress = publicProgress.at(-1);
  assert.equal(finalProgress?.role, 'reviewer');
  assert.equal(finalProgress?.budget?.modelRequests, 2);
  assert.equal(finalProgress?.budget?.toolCalls, 2, 'the final review-tool consumption is visible before completion');
  assert.equal(finalProgress?.budget?.toolCallLimit, 24);
});
test('connected GPT cannot read OMP credentials without operator opt-in or select another model', async t => {
  const previous = process.env.PHYSICS_LAB_CONNECTED_GPT;
  process.env.PHYSICS_LAB_CONNECTED_GPT = '0';
  t.after(() => {
    if (previous === undefined) delete process.env.PHYSICS_LAB_CONNECTED_GPT;
    else process.env.PHYSICS_LAB_CONNECTED_GPT = previous;
  });
  await assert.rejects(providerKey('openai-codex'), error => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.code, 'connection_not_enabled');
    assert.equal(error.status, 403);
    return true;
  });
  await assert.rejects(resolveLabModel('openai-codex', 'gpt-6-luna', new AbortController().signal), error => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.code, 'connection_not_enabled');
    assert.equal(error.status, 403);
    return true;
  });
  assert.equal(getProviderConfig().providers.find(provider => provider.id === 'openai-codex')?.available, false);
  assert.throws(() => labModel('openai-codex', 'unapproved-model'), error => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.code, 'unsupported_model');
    return true;
  });
});

test('an overload event inside HTTP 200 is a provider outage, with no private echo or retry', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { code: 'server_is_overloaded', type: 'service_unavailable_error', message: 'PRIVATE_UPSTREAM_SENTINEL' } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  };
  const credential = `fixture.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'isolated-account' } })).toString('base64')}.fixture`;
  const context = normalizeContext({ messages: [{ role: 'user', content: 'A moving body.', timestamp: 1 }] });
  await assert.rejects(streamLabModel('openai-codex', labModel('openai-codex', 'gpt-6-luna'), context, new AbortController().signal, () => {}, credential), error => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.code, 'provider_busy');
    assert.equal(error.status, 503);
    assert.ok(!error.message.includes('PRIVATE_UPSTREAM_SENTINEL'));
    return true;
  });
  assert.equal(calls, 1);
});
