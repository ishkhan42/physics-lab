import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { readAssemblyResponse, type AssemblyProgress } from '../shared/assembly-stream.ts';
import { projectile } from './fixtures.ts';

const decision = () => ({ kind: 'scene', summary: 'A falling sphere.', assumptions: ['Earth gravity, no air resistance.'], question: null, reason: null, scene: projectile() });
const proposal = {
  kind: 'proposal',
  decision: decision(),
  verification: { checkedThroughSeconds: 0.5 },
  concerns: [{ code: 'relationship', message: 'A checked relationship still differs from the request.' }],
};
const encode = new TextEncoder();
function stream(parts: string[]): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encode.encode(part));
      controller.close();
    },
  }), { headers: { 'content-type': 'application/x-ndjson' } });
}

test('fragmented progress keeps correction visible and admits only a physically validated final decision', async () => {
  const records = [
    { type: 'progress', stage: 'generating', message: 'Designing your model.' },
    { type: 'progress', stage: 'validating', message: 'Checking physical definitions.' },
    { type: 'progress', stage: 'repairing', message: 'Correcting validation issues.' },
    { type: 'decision', decision: decision() },
  ];
  const text = records.map(value => JSON.stringify(value)).join('\n');
  const progress: AssemblyProgress[] = [];
  const result = await readAssemblyResponse(stream([text.slice(0, 17), text.slice(17, 91), text.slice(91)]), value => progress.push(value));
  assert.deepEqual(progress.map(value => value.stage), ['generating', 'validating', 'repairing']);
  if (result.kind !== 'scene') throw new Error('Expected a scene decision.');
  assert.deepEqual(result.scene, decision().scene);
  assert.equal(result.approximation, null);
  const invalid = decision();
  invalid.scene.bodies[0].mass = null;
  await assert.rejects(readAssemblyResponse(stream([JSON.stringify({ type: 'decision', decision: invalid })]), () => {}));
});

test('a disconnected or failed stream never becomes a successful model', async () => {
  const progress = JSON.stringify({ type: 'progress', stage: 'generating', message: 'Designing.' }) + '\n';
  await assert.rejects(readAssemblyResponse(stream([progress]), () => {}), /before a complete lab outcome/);
  await assert.rejects(readAssemblyResponse(stream([progress, JSON.stringify({ type: 'error', error: { code: 'provider_rate_limited', message: 'Provider quota reached.' } })]), () => {}), /Provider quota reached/);
  await assert.rejects(readAssemblyResponse(stream([progress, '{"type":"decision"']), () => {}), error => {
    assert.equal(Object.getOwnPropertyDescriptor(error, 'code')?.value, 'assembly_invalid_response');
    return true;
  });
});

test('new bounded activity stages cannot abort an otherwise valid experiment', async () => {
  const response = stream([
    JSON.stringify({ type: 'progress', stage: 'future_check', message: 'Checking the view.', role: 'reviewer', budget: { modelRequests: 15, modelRequestLimit: 16, toolCalls: 10, toolCallLimit: 24 } }) + '\n',
    JSON.stringify({ type: 'decision', decision: decision() }),
  ]);
  const outcome = await readAssemblyResponse(response, () => {});
  if (outcome.kind !== 'scene') throw new Error('Expected a scene decision.');
  assert.deepEqual(outcome.scene, decision().scene);
  await assert.rejects(readAssemblyResponse(stream([JSON.stringify({ type: 'progress', stage: 'future_check', message: 'x'.repeat(2001) })]), () => {}));
});

test('impossible work counters and oversized budgets cannot accompany a successful scene', async () => {
  for (const budget of [
    { modelRequests: 17, modelRequestLimit: 16, toolCalls: 10, toolCallLimit: 24 },
    { modelRequests: 4, modelRequestLimit: 16, toolCalls: 25, toolCallLimit: 24 },
    { modelRequests: 1, modelRequestLimit: 65, toolCalls: 1, toolCallLimit: 24 },
  ]) {
    await assert.rejects(readAssemblyResponse(stream([
      JSON.stringify({ type: 'progress', stage: 'reviewing', message: 'Checking.', budget }) + '\n',
      JSON.stringify({ type: 'decision', decision: decision() }),
    ]), () => {}));
  }
});

test('duplicate terminal data and oversized responses remain rejected', async () => {
  const final = JSON.stringify({ type: 'decision', decision: decision() }) + '\n';
  await assert.rejects(readAssemblyResponse(stream([final, final]), () => {}), /after its completed result/);
  await assert.rejects(readAssemblyResponse(stream([' '.repeat(1024 * 1024 + 1)]), () => {}), /size limit/);
});

test('normal JSON clients retain validated decisions and safe service errors', async () => {
  const response = Response.json(decision());
  const outcome = await readAssemblyResponse(response, () => {});
  if (outcome.kind !== 'scene') throw new Error('Expected a scene decision.');
  assert.deepEqual(outcome.scene, decision().scene);
  await assert.rejects(readAssemblyResponse(Response.json({ error: { code: 'missing_credentials', message: 'No configured provider.' } }, { status: 503 }), () => {}), /No configured provider/);
});
test('checked proposals validate their scene, native receipt and safe concerns over JSON and SSE', async () => {
  const jsonOutcome = await readAssemblyResponse(Response.json(proposal), () => {});
  assert.equal(jsonOutcome.kind, 'proposal');
  const streamOutcome = await readAssemblyResponse(stream([JSON.stringify({ type: 'proposal', proposal })]), () => {});
  assert.deepEqual(streamOutcome, jsonOutcome);

  const invalidScene = structuredClone(proposal);
  invalidScene.decision.scene.bodies[0].mass = null;
  const invalidReceipt = { ...proposal, verification: { checkedThroughSeconds: 0.1 } };
  const missingConcerns = { ...proposal, concerns: [] };
  const unsafeConcern = { ...proposal, concerns: [{ code: 'relationship', message: 'The provider authorization header was exposed.' }] };
  for (const invalid of [invalidScene, invalidReceipt, missingConcerns, unsafeConcern]) {
    await assert.rejects(readAssemblyResponse(Response.json(invalid), () => {}));
    await assert.rejects(readAssemblyResponse(stream([JSON.stringify({ type: 'proposal', proposal: invalid })]), () => {}));
  }
});

test('duplicate proposal and decision terminals remain rejected', async () => {
  const finalDecision = JSON.stringify({ type: 'decision', decision: decision() }) + '\n';
  const finalProposal = JSON.stringify({ type: 'proposal', proposal }) + '\n';
  await assert.rejects(readAssemblyResponse(stream([finalDecision, finalProposal]), () => {}), error => z.object({ code: z.literal('assembly_invalid_response') }).safeParse(error).success);
  await assert.rejects(readAssemblyResponse(stream([finalProposal, finalDecision]), () => {}), error => z.object({ code: z.literal('assembly_invalid_response') }).safeParse(error).success);
});


test('transport interruptions retain a distinct safe failure instead of looking like bad physics', async () => {
  const response = new Response(new ReadableStream({
    start(controller) { controller.error(new TypeError('PRIVATE_TRANSPORT_SENTINEL')); },
  }), { headers: { 'content-type': 'application/x-ndjson' } });
  await assert.rejects(readAssemblyResponse(response, () => {}), error => {
    assert.equal(Object.getOwnPropertyDescriptor(error, 'code')?.value, 'assembly_connection_lost');
    assert.ok(error instanceof Error && !error.message.includes('PRIVATE_TRANSPORT_SENTINEL'));
    return true;
  });
});
