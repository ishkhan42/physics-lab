import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import {
  formatHarnessFailure,
  HARNESS_FAILURE_MAX_MODEL_TURNS,
  HARNESS_FAILURE_MAX_TOOL_CALLS,
  HarnessFailureSchema,
  makeHarnessFailure,
} from '../shared/harness-failure.ts';

test('keeps unstarted, unusable and rejected review outcomes distinct', () => {
  const reviewUnstarted = makeHarnessFailure(new Error('capacity unavailable'), {
    stage: 'reviewing', modelTurns: 14, toolCalls: 20, code: 'review_unstarted',
  });
  const reviewUnusable = makeHarnessFailure(new Error('no verdict'), {
    stage: 'reviewing', modelTurns: 16, toolCalls: 21, code: 'review_unusable',
  });
  const reviewRejected = makeHarnessFailure(new Error('repair unavailable'), {
    stage: 'reviewing', modelTurns: 15, toolCalls: 22, code: 'review_rejected',
  });
  assert.deepEqual([reviewUnstarted.code, reviewUnusable.code, reviewRejected.code], ['review_unstarted', 'review_unusable', 'review_rejected']);
  for (const failure of [reviewUnstarted, reviewUnusable, reviewRejected]) assert.equal(HarnessFailureSchema.safeParse(failure).success, true);
});

test('failure counter limits follow the shared harness budget', () => {
  assert.equal(HARNESS_FAILURE_MAX_MODEL_TURNS, 16);
  assert.equal(HARNESS_FAILURE_MAX_TOOL_CALLS, 24);
});

test('classifies malformed JSON, validation, physics and review failures separately', () => {
  const malformed = makeHarnessFailure(new SyntaxError('raw provider response must not be shown'), {
    stage: 'checking', modelTurns: 2, toolCalls: 3,
  });
  assert.equal(malformed.code, 'malformed_json');
  assert.equal(formatHarnessFailure(malformed).includes('raw provider response'), false);

  const checked = z.object({ scene: z.object({ mass: z.number().positive() }) }).safeParse({ scene: { mass: -1 } });
  assert.equal(checked.success, false);
  if (checked.success) return;
  const invalid = makeHarnessFailure(checked.error, { stage: 'planning', modelTurns: 1, toolCalls: 2 });
  assert.equal(invalid.code, 'invalid_schema');
  assert.equal(invalid.lastIssue?.path, 'scene.mass');
  assert.equal(invalid.lastIssue?.code, 'too_small');
  const formatted = formatHarnessFailure(invalid);
  assert.ok(formatted.includes('scene.mass'));
  assert.ok(formatted.includes('too_small'));
  assert.ok(formatted.length <= 640);

  const physics = makeHarnessFailure(new Error('A free carried group needs positive finite native mass.'), {
    stage: 'checking', modelTurns: 4, toolCalls: 5,
  });
  assert.equal(physics.code, 'physics_check_failed');
  assert.equal(physics.lastIssue?.code, 'native_error');

  const review = makeHarnessFailure(new Error('review internals'), {
    stage: 'reviewing', modelTurns: 5, toolCalls: 6,
  });
  assert.equal(review.code, 'review_failed');
});

test('keeps budget and protocol causes distinct while bounding counters and records', () => {
  const modelBudget = makeHarnessFailure(new Error('limit'), {
    stage: 'planning', modelTurns: 1000, toolCalls: 1000, code: 'model_budget',
  });
  assert.equal(modelBudget.code, 'model_budget');
  assert.equal(modelBudget.modelTurns, HARNESS_FAILURE_MAX_MODEL_TURNS);
  assert.equal(modelBudget.toolCalls, HARNESS_FAILURE_MAX_TOOL_CALLS);

  const toolBudget = makeHarnessFailure(new Error('limit'), {
    stage: 'finishing', modelTurns: 1, toolCalls: HARNESS_FAILURE_MAX_TOOL_CALLS, code: 'tool_budget',
  });
  assert.equal(toolBudget.code, 'tool_budget');
  const protocol = makeHarnessFailure(new Error('invalid record'), {
    stage: 'initializing', modelTurns: 0, toolCalls: 0, code: 'protocol',
  });
  assert.equal(protocol.code, 'protocol');
  assert.equal(HarnessFailureSchema.safeParse({ ...modelBudget, toolCalls: HARNESS_FAILURE_MAX_TOOL_CALLS + 1 }).success, false);
  assert.equal(HarnessFailureSchema.safeParse({
    ...modelBudget,
    lastIssue: { path: 'p'.repeat(161), code: 'native_error', message: 'safe reason' },
  }).success, false);
});

test('does not expose credentials, JWTs, paths, raw responses or unknown exception content', () => {
  const secret = 'CREDENTIAL_SENTINEL_9842';
  const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJzZW50aW5lbCJ9', 'signedSecretSentinel'].join('.');
  const filePath = '/home/private-user/project/worker.ts';
  const rawResponse = 'RAW_PROVIDER_RESPONSE_SENTINEL';
  const prompt = 'PRIVATE_PROMPT_SENTINEL_428';
  const unsafe = new Error(`api_key=${secret} ${jwt} ${filePath} raw provider response ${rawResponse} user prompt ${prompt}`);
  const unknown = makeHarnessFailure(unsafe, { stage: 'planning', modelTurns: 3, toolCalls: 4 });
  const details = `${JSON.stringify(unknown)} ${formatHarnessFailure(unknown)}`;
  assert.equal(unknown.code, 'internal');
  for (const value of [secret, jwt, filePath, rawResponse, prompt]) assert.equal(details.includes(value), false);
  assert.ok(details.length <= 1000);
  const unsafeValidation = z.string().refine(() => false, {
    message: `credential ${secret} ${jwt} ${filePath} raw provider response ${rawResponse} user prompt ${prompt}`,
  }).safeParse('value');
  assert.equal(unsafeValidation.success, false);
  if (unsafeValidation.success) return;
  const validationFailure = makeHarnessFailure(unsafeValidation.error, { stage: 'planning', modelTurns: 1, toolCalls: 1 });
  const validationDetails = `${JSON.stringify(validationFailure)} ${formatHarnessFailure(validationFailure)}`;
  for (const value of [secret, jwt, filePath, rawResponse, prompt]) assert.equal(validationDetails.includes(value), false);

  const opaque = makeHarnessFailure({ message: 'untrusted exception payload' }, {
    stage: 'finishing', modelTurns: 0, toolCalls: 0,
  });
  assert.equal(opaque.code, 'internal');
  assert.equal(opaque.lastIssue, undefined);
});
