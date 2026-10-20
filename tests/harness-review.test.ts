import assert from 'node:assert/strict';
import test from 'node:test';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, JsonObject } from '@earendil-works/pi-ai';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { reviewExperiment, ReviewUnusableError } from '../server/harness-review.ts';
import { labModel } from '../server/providers.ts';
import { validateModelContext } from '../server/harness.ts';
import { HARNESS_REVIEW_MAX_TURNS, HarnessRequestSchema } from '../shared/harness.ts';
import { validateDecision } from '../shared/scene.ts';
import { projectile } from './fixtures.ts';
import type { VisualFrame } from '../shared/visual-inspection.ts';

const model = labModel('openrouter', 'example/model');
const request = HarnessRequestSchema.parse({ provider: 'openrouter', model: model.id, description: 'A moving body.' });
const candidate = validateDecision({ kind: 'scene', summary: 'A moving body.', assumptions: [], question: null, reason: null, approximation: null, alternative: null, scene: projectile() });
function reply(review: JsonObject | null, plainText = false): StreamFn {
  let calls = 0;
  return () => {
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: 'assistant', api: model.api, provider: model.provider, model: model.id,
      content: plainText ? [{ type: 'text', text: 'Approved. Everything is fine.' }] : [{ type: 'toolCall', id: `review_${++calls}`, name: 'submit_review', arguments: review ?? {} }],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: plainText ? 'stop' : 'toolUse', timestamp: Date.now(),
    };
    stream.push({ type: 'done', reason: plainText ? 'stop' : 'toolUse', message });
    return stream;
  };
}

function replies(...streams: StreamFn[]): StreamFn {
  let request = 0;
  return (requestModel, context, options) => streams[request++]!(requestModel, context, options);
}

test('a contradictory or malformed independent verdict cannot approve a scene', async () => {
  const invalidReviews: JsonObject[] = [
    { approved: true, findings: [{ severity: 'error', code: 'relationship', message: 'The mechanism is not connected.' }] },
    { approved: false, findings: [] },
    { approved: true, findings: [], injectedPermission: 'shell' },
  ];
  for (const review of invalidReviews) {
    await assert.rejects(reviewExperiment(model, reply(review), request, candidate, {}, () => true), Error);
  }
});

test('plain model reassurance is not an approval, and exhausted tool budget cannot be bypassed', async () => {
  await assert.rejects(reviewExperiment(model, reply(null, true), request, candidate, {}, () => true), Error);
  await assert.rejects(reviewExperiment(model, reply({ approved: true, findings: [] }), request, candidate, {}, () => false), Error);
});

test('a malformed or plaintext reviewer can correct its verdict once', async () => {
  for (const first of [reply({ approved: false, findings: [] }), reply(null, true)]) {
    let requests = 0;
    const scripted = replies(first, reply({ approved: true, findings: [] }));
    const stream: StreamFn = (requestModel, context, options) => {
      requests++;
      return scripted(requestModel, context, options);
    };
    const review = await reviewExperiment(model, stream, request, candidate, {}, () => true);
    assert.equal(review.approved, true);
    assert.equal(requests, HARNESS_REVIEW_MAX_TURNS);
  }
});

test('two unusable reviewer requests terminate without yielding a verdict', async () => {
  let requests = 0;
  const stream: StreamFn = (requestModel, context, options) => {
    requests++;
    return reply(null, true)(requestModel, context, options);
  };
  await assert.rejects(reviewExperiment(model, stream, request, candidate, {}, () => true), ReviewUnusableError);
  assert.equal(requests, HARNESS_REVIEW_MAX_TURNS);
});

test('a text-only reviewer cannot forward scene images to its model', async () => {
  let requests = 0;
  const blocked: StreamFn = () => { requests++; throw new Error('Unexpected model request.'); };
  const frame: VisualFrame = {
    requestedAt: 0, simulatedAt: 0, view: 'overview', focusedId: null, width: 960, height: 640, notes: [],
    image: { type: 'image', data: '/9j/AA==', mimeType: 'image/jpeg' },
  };
  await assert.rejects(reviewExperiment(model, blocked, request, candidate, {}, () => true, [frame]), Error);
  assert.equal(requests, 0);
});

test('a valid large-scene follow-up reaches independent review without a text-block overflow', async () => {
  const reference = projectile();
  const crowded = validateDecision({
    ...candidate,
    scene: { ...reference, ground: null, bodies: Array.from({ length: 127 }, (_, index) => ({
      ...reference.bodies[0], id: `body_${index}`, label: `Measured body ${index} with a separately retained physical definition`,
      position: [index * 2, 0, 20],
    })) },
  });
  const historyText = 'Compare the measured motion with the stated initial conditions; preserve the objects, their materials and every scheduled action. '.repeat(130).slice(0, 16000);
  const followUp = HarnessRequestSchema.parse({
    ...request, currentScene: crowded.scene, description: historyText, sourcePrompt: historyText,
    history: Array.from({ length: 24 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: historyText })),
  });
  let requests = 0;
  const stream: StreamFn = (requestModel, context, options) => {
    validateModelContext(context, requestModel, 'reviewer');
    requests++;
    return reply({ approved: true, findings: [] })(requestModel, context, options);
  };
  const review = await reviewExperiment(model, stream, followUp, crowded, {}, () => true);
  assert.equal(review.approved, true);
  assert.equal(requests, 1);
});
