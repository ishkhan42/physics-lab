import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assemble,
  extractAnthropicText,
  extractOpenAIText,
  extractOpenRouterText,
  parseDecisionText,
  ProviderError,
} from '../server/providers.ts';
import type { AssemblyProgressEvent } from '../server/providers.ts';
import { AssemblyRequestSchema, validateScene } from '../shared/scene.ts';
import type { Decision, Scene } from '../shared/scene.ts';
import { atwood } from './fixtures.ts';

const validClarification = {
  kind: 'clarify',
  summary: 'The launch speed changes the requested trajectory.',
  assumptions: [],
  question: 'What is the initial speed?',
  reason: null,
  approximation: null,
  scene: null,
};

type JsonSchema = Record<string, unknown>;
function asSchema(value: unknown): JsonSchema {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value));
  return value as JsonSchema;
}


function tuplesAsObjects(value: unknown): unknown {
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every(item => typeof item === 'number')) {
      return Object.fromEntries(value.map((item, index) => [String(index), item]));
    }
    return value.map(tuplesAsObjects);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, tuplesAsObjects(item)]));
  }
  return value;
}



function providerScene(): Scene {
  const original = atwood();
  return validateScene({
    ...original,
    bodies: [...original.bodies, {
      id: 'ramp', label: 'Infinite support plane', parentId: null, position: [0, 0, -5],
      orientation: [1, 0, 0, 0], shape: { kind: 'plane', size: [8, 4] }, mass: null,
      motion: { kind: 'fixed' }, restitution: 1,
      friction: { sliding: 0.2, torsional: 0, rolling: 0, static: 0.4 }, color: '#bacbd1',
    }],
    loads: [{ kind: 'force', bodyId: 'light', vector: [1.25, -2.5, 0.5], point: null }],
  });
}

test('one local validation repair stays on the selected model and preserves every scene value', async () => {
  const scene = providerScene();
  const request = AssemblyRequestSchema.parse({
    provider: 'anthropic', model: 'claude-sonnet-4-6', description: 'Two masses on an ideal cable.',
  });
  const decision: Decision = {
    kind: 'scene', summary: 'Your two-mass cable setup.', assumptions: [], question: null, reason: null,
    approximation: null, scene, alternative: null,
  };
  const rejected: Decision = {
    ...decision,
    scene: { ...scene, bodies: scene.bodies.map(body => body.id === 'beam' ? { ...body, id: '1beam' } : body) },
  };
  const corrected: Decision = {
    ...decision,
    scene: { ...scene, bodies: scene.bodies.map(body => body.id === 'beam' ? { ...body, id: 'beam' } : body) },
  };
  const completions = [rejected, corrected].map(output => JSON.stringify({ decision: tuplesAsObjects(output) }));
  const requests: JsonSchema[] = [];
  const progress: AssemblyProgressEvent[] = [];
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  globalThis.fetch = async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)) as JsonSchema);
    const content = completions.shift();
    assert.ok(typeof content === 'string');
    return new Response(JSON.stringify({
      stop_reason: 'end_turn', content: [{ type: 'text', text: content }],
    }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    assert.deepEqual(await assemble(request, event => progress.push(event)), corrected);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests.map(body => body.model), ['claude-sonnet-4-6', 'claude-sonnet-4-6']);
    assert.deepEqual(progress.map(event => event.stage), ['generating', 'validating', 'repairing', 'validating']);
    assert.ok(progress.every(event => !event.message.includes('1beam')));
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
  }
});

test('temporary provider recovery shares a two-call budget with validation repair and never retries quota failures', async t => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'isolated-test-credential';
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
  });
  const request = AssemblyRequestSchema.parse({ provider: 'openrouter', model: 'example/model:free', description: 'Apply a force to a block.' });
  for (const outcome of ['recovered', 'invalid-second', 'quota'] as const) {
    let calls = 0;
    const stages: string[] = [];
    globalThis.fetch = async input => {
      if (String(input).endsWith('/models')) return Response.json({ data: [] });
      calls++;
      if (outcome === 'quota') return new Response('', { status: 429 });
      if (calls === 1) return new Response('', { status: 503 });
      return Response.json({ choices: [{ finish_reason: 'stop', message: {
        content: JSON.stringify({ decision: outcome === 'invalid-second' ? { ...validClarification, question: null } : validClarification }),
      } }] });
    };
    const result = assemble(request, event => stages.push(event.stage)).then(value => ({ value, error: null }), error => ({ value: null, error }));
    await new Promise<void>(resolve => setImmediate(resolve));
    t.mock.timers.tick(1000);
    const settled = await result;
    if (outcome === 'recovered') {
      assert.equal(settled.value?.kind, 'clarify');
      assert.deepEqual(stages, ['generating', 'retrying', 'validating']);
    } else {
      assert.ok(settled.error instanceof ProviderError);
      assert.equal(settled.error.code, outcome === 'quota' ? 'provider_rate_limited' : 'invalid_model_response');
      assert.ok(!stages.includes('repairing'));
    }
    assert.equal(calls, outcome === 'quota' ? 1 : 2);
  }
});

test('an unsupported verdict gets one same-model review and survives a failed review', async t => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'isolated-test-credential';
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
  });
  const unsupported = { ...validClarification, kind: 'unsupported', question: null, reason: 'No suitable law was chosen.' };
  const reply = (decision: unknown) => Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ decision }) } }] });
  const request = AssemblyRequestSchema.parse({ provider: 'openrouter', model: 'example/model:free', description: 'Drop two balls.' });
  for (const outcome of ['improved', 'review-unavailable'] as const) {
    const models: unknown[] = [];
    const stages: string[] = [];
    globalThis.fetch = async (input, init) => {
      if (String(input).endsWith('/models')) return Response.json({ data: [] });
      models.push(JSON.parse(String(init?.body)).model);
      if (models.length === 1) return reply(unsupported);
      return outcome === 'improved' ? reply(validClarification) : new Response('', { status: 503 });
    };
    const decision = await assemble(request, event => stages.push(event.stage));
    assert.deepEqual(models, ['example/model:free', 'example/model:free']);
    assert.equal(decision.kind, outcome === 'improved' ? 'clarify' : 'unsupported');
    assert.deepEqual(stages.slice(0, 3), ['generating', 'validating', 'reviewing']);
  }
});

test('tuple transport round-trips the complete mechanics intent before local validation', () => {
  const decision: Decision = {
    kind: 'scene',
    summary: 'Your stretchable cord is shown as an ideal cable experiment.',
    assumptions: ['The cable is massless and fixed at 6 m.'],
    question: null,
    reason: null,
    approximation: 'Your cord stretch is not modeled; the preview uses a massless fixed-length cable.',
    scene: providerScene(),
    alternative: null,
  };
  const parsed = parseDecisionText(JSON.stringify({ decision: tuplesAsObjects(decision) }));
  assert.deepEqual(parsed, decision);
  assert.deepEqual(parseDecisionText(JSON.stringify({ decision: decision })), decision);
  assert.deepEqual(parsed.kind === 'scene' ? parsed.scene?.bodies.find(body => body.id === 'ramp')?.shape : null, {
    kind: 'plane', size: [8, 4],
  });
});

test('malformed shape and motion representations remain rejected at the model boundary', () => {
  const scene = providerScene();
  const base = {
    kind: 'scene',
    summary: 'Your mechanics scene.',
    assumptions: [],
    question: null,
    reason: null,
    approximation: null,
    scene,
    alternative: null,
  };
  const malformedTuple = asSchema(tuplesAsObjects(base));
  const malformedScene = asSchema(malformedTuple.scene);
  const malformedBodies = malformedScene.bodies as unknown[];
  const ramp = asSchema(malformedBodies[3]);
  const shape = asSchema(ramp.shape);
  shape.size = { ...asSchema(shape.size), '2': 1 };
  assert.throws(() => parseDecisionText(JSON.stringify({ decision: malformedTuple })), error => {
    assert.ok(error instanceof ProviderError && error.code === 'invalid_model_response');
    return true;
  });
  const missingTuple = asSchema(tuplesAsObjects(base));
  const missingBodies = asSchema(missingTuple.scene).bodies as unknown[];
  const missingRamp = asSchema(missingBodies[3]);
  delete asSchema(asSchema(missingRamp.shape).size)['1'];
  assert.throws(() => parseDecisionText(JSON.stringify({ decision: missingTuple })), error => {
    assert.ok(error instanceof ProviderError && error.code === 'invalid_model_response');
    return true;
  });
  assert.throws(() => parseDecisionText(JSON.stringify({ decision: {
    ...base,
    scene: {
      ...scene,
      bodies: scene.bodies.map(body => body.id === 'light' ? { ...body, motion: { kind: 'glide' } } : body),
    },
  } })), error => {
    assert.ok(error instanceof ProviderError && error.code === 'invalid_model_response');
    return true;
  });
});

test('invalid model diagnostics expose only bounded schema paths and issue codes', () => {
  const sentinel = 'SENSITIVE_PROMPT_SENTINEL';
  const malformed = {
    ...validClarification,
    question: 42,
    summary: sentinel,
    private_prompt_field: sentinel,
  };
  assert.throws(() => parseDecisionText(JSON.stringify({ decision: malformed })), error => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.code, 'invalid_model_response');
    assert.ok(!error.message.includes(sentinel));
    assert.ok(!error.message.includes('private_prompt_field'));
    assert.ok(error.message.length < 1024);
    return true;
  });
});

test('a physics-rule rejection tells the correction call which rule failed without echoing model values', () => {
  const scene = providerScene();
  const sentinel = 'SENSITIVE_PROMPT_SENTINEL';
  assert.throws(() => parseDecisionText(JSON.stringify({ decision: {
    kind: 'scene', summary: sentinel, assumptions: [], question: null, reason: null, approximation: null, alternative: null,
    scene: { ...scene, bodies: scene.bodies.map(body => body.id === 'light' ? { ...body, mass: null } : body) },
  } })), error => {
    assert.ok(error instanceof ProviderError && error.code === 'invalid_model_response');
    assert.match(error.repairHint ?? '', /bodies\.1\.mass: A moving body needs a positive mass/);
    assert.ok(!error.message.includes('positive mass'));
    assert.ok(!`${error.message}${error.repairHint}`.includes(sentinel));
    return true;
  });
});


function assertProviderError(action: () => unknown, code: string): void {
  assert.throws(action, error => error instanceof ProviderError && error.code === code);
}

test('OpenAI extracts only completed assistant output_text blocks', () => {
  const text = JSON.stringify(validClarification);
  assert.equal(extractOpenAIText({
    status: 'completed',
    output: [
      { type: 'reasoning', summary: [] },
      { type: 'message', role: 'assistant', status: 'completed', content: [
        { type: 'output_text', text: text.slice(0, 20) },
        { type: 'output_text', text: text.slice(20) },
      ] },
    ],
  }), text);
});

test('OpenAI rejects incomplete responses and refusal blocks', () => {
  assertProviderError(() => extractOpenAIText({
    status: 'incomplete',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{}' }] }],
  }), 'invalid_provider_response');
  assertProviderError(() => extractOpenAIText({
    status: 'completed',
    output: [{ type: 'message', role: 'assistant', status: 'incomplete', content: [{ type: 'output_text', text: '{}' }] }],
  }), 'invalid_provider_response');
  assertProviderError(() => extractOpenAIText({
    status: 'completed',
    output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: 'Cannot help.' }] }],
  }), 'model_refusal');
});

test('Anthropic accepts end_turn text and rejects refusal, tool use and token truncation', () => {
  const text = JSON.stringify(validClarification);
  assert.equal(extractAnthropicText({
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: text.slice(0, 30) }, { type: 'text', text: text.slice(30) }],
  }), text);
  assertProviderError(() => extractAnthropicText({ stop_reason: 'refusal', content: [{ type: 'text', text: 'No.' }] }), 'model_refusal');
  assertProviderError(() => extractAnthropicText({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'x' }] }), 'invalid_provider_response');
  assertProviderError(() => extractAnthropicText({ stop_reason: 'max_tokens', content: [{ type: 'text', text }] }), 'invalid_provider_response');
});

test('OpenRouter requires a completed text choice and rejects refusal or truncation', () => {
  const content = JSON.stringify(validClarification);
  assertProviderError(() => extractOpenRouterText({
    choices: [{ finish_reason: 'stop', message: { content: [{ type: 'text', text: content }] } }],
  }), 'invalid_provider_response');
  assertProviderError(() => extractOpenRouterText({
    choices: [{ finish_reason: 'length', message: { content } }],
  }), 'invalid_provider_response');
  assertProviderError(() => extractOpenRouterText({
    choices: [{ finish_reason: 'stop', message: { refusal: 'Cannot help.', content: null } }],
  }), 'model_refusal');
});

test('model JSON must be complete and pass the semantic decision contract', () => {
  assertProviderError(() => parseDecisionText('{"kind":"clarify"'), 'invalid_model_response');
  assertProviderError(() => parseDecisionText(JSON.stringify({ decision: { ...validClarification, question: null } })), 'invalid_model_response');
  assertProviderError(() => parseDecisionText(JSON.stringify({ decision: { ...validClarification, extra: true } })), 'invalid_model_response');
  assert.equal(parseDecisionText(JSON.stringify({ decision: { ...validClarification, approximation: undefined } })).approximation, null);
});
