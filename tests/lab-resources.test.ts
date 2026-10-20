import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import type { Context } from '@earendil-works/pi-ai';
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript';
import { Type } from 'typebox';
import { withLabResources } from '../server/lab-resources.ts';
import { HARNESS_MAX_TOOL_CALLS, HARNESS_MAX_TURNS, HARNESS_REVIEW_MAX_TURNS } from '../shared/harness.ts';
import { MAX_VISUAL_CALLS_PER_RUN, MAX_VISUAL_FRAMES_PER_RUN } from '../shared/visual-inspection.ts';

const StatusSchema = z.object({ labResourceStatus: z.object({
  modelRequests: z.object({ remainingAfterCurrentRequest: z.number(), builderRequestsBeforeReviewReserve: z.number(), reservedForFinalReview: z.number() }),
  labActions: z.object({ remaining: z.number() }),
  inspection: z.object({ toolAvailable: z.boolean(), callsRemaining: z.number(), imageAttemptsRemaining: z.number() }),
  callableTools: z.array(z.string()),
}) });

function contextForTools(...names: string[]): Context {
  return { messages: [
    { role: 'system', content: 'Lab instructions.', timestamp: 1, toolsAdded: names.map(name => ({ name, description: name, parameters: Type.Object({}) })) },
    { role: 'user', content: 'Inspect the experiment.', timestamp: 2 },
  ] };
}
function status(context: Context) {
  const message = context.messages.at(-1);
  if (message?.role !== 'system' || typeof message.content !== 'string') throw new Error('Missing resource status.');
  return StatusSchema.parse(JSON.parse(message.content)).labResourceStatus;
}
const counts = (overrides: Partial<Parameters<typeof withLabResources>[2]> = {}): Parameters<typeof withLabResources>[2] => ({
  modelRequests: 1, labActions: 0, inspectionCalls: 0, imageAttempts: 0, canInspectImages: true, ...overrides,
});

test('the current request counts against the limit while final review remains reserved', () => {
  const context = contextForTools('check_experiment');
  const before = status(withLabResources(context, 'builder', counts({ modelRequests: HARNESS_MAX_TURNS - HARNESS_REVIEW_MAX_TURNS - 1, labActions: HARNESS_MAX_TOOL_CALLS - 1 })));
  assert.equal(before.modelRequests.remainingAfterCurrentRequest, HARNESS_REVIEW_MAX_TURNS + 1);
  assert.equal(before.modelRequests.builderRequestsBeforeReviewReserve, 1);
  assert.equal(before.labActions.remaining, 1);
  const reserved = status(withLabResources(context, 'builder', counts({ modelRequests: HARNESS_MAX_TURNS - HARNESS_REVIEW_MAX_TURNS })));
  assert.equal(reserved.modelRequests.remainingAfterCurrentRequest, HARNESS_REVIEW_MAX_TURNS);
  assert.equal(reserved.modelRequests.builderRequestsBeforeReviewReserve, 0);
  const exhausted = status(withLabResources(contextForTools('submit_review'), 'reviewer', counts({ modelRequests: HARNESS_MAX_TURNS, labActions: HARNESS_MAX_TOOL_CALLS })));
  assert.equal(exhausted.modelRequests.remainingAfterCurrentRequest, 0);
  assert.equal(exhausted.modelRequests.builderRequestsBeforeReviewReserve, 0);
  assert.equal(exhausted.labActions.remaining, 0);
});

test('inspection allowance reflects remaining attempts, role scope and image capability', () => {
  const nearlyUsed = counts({ inspectionCalls: MAX_VISUAL_CALLS_PER_RUN - 1, imageAttempts: MAX_VISUAL_FRAMES_PER_RUN - 1 });
  const builder = status(withLabResources(contextForTools('inspect_scene'), 'builder', nearlyUsed));
  assert.equal(builder.inspection.callsRemaining, 1);
  assert.equal(builder.inspection.imageAttemptsRemaining, 1);
  assert.equal(builder.inspection.toolAvailable, true);
  const reviewer = status(withLabResources(contextForTools('submit_review'), 'reviewer', nearlyUsed));
  assert.equal(reviewer.inspection.toolAvailable, false);
  assert.deepEqual(reviewer.callableTools, ['submit_review']);
  const textOnly = status(withLabResources(contextForTools('check_experiment'), 'builder', counts({ canInspectImages: false })));
  assert.equal(textOnly.inspection.callsRemaining, 0);
  assert.equal(textOnly.inspection.imageAttemptsRemaining, 0);
  assert.equal(textOnly.inspection.toolAvailable, false);
  const exhausted = status(withLabResources(contextForTools('inspect_scene'), 'builder', counts({ inspectionCalls: MAX_VISUAL_CALLS_PER_RUN, imageAttempts: MAX_VISUAL_FRAMES_PER_RUN })));
  assert.equal(exhausted.inspection.callsRemaining, 0);
  assert.equal(exhausted.inspection.imageAttemptsRemaining, 0);
});

test('current status does not accumulate in history or change callable tools', () => {
  const context = contextForTools('check_experiment');
  const first = withLabResources(context, 'builder', counts({ modelRequests: 4 }));
  const next = withLabResources(context, 'builder', counts({ modelRequests: 5 }));
  assert.equal(context.messages.length, 2);
  assert.equal(first.messages.length, 3);
  assert.equal(next.messages.length, 3);
  assert.equal(status(next).modelRequests.remainingAfterCurrentRequest, status(first).modelRequests.remainingAfterCurrentRequest - 1);
  assert.deepEqual(getCurrentTools(next.messages).map(tool => tool.name), ['check_experiment']);
});
