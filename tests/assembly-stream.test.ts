import assert from 'node:assert/strict';
import test from 'node:test';
import { readAssemblyResponse, type AssemblyProgress } from '../shared/assembly-stream.ts';
import { projectile } from './fixtures.ts';

const decision = () => ({ kind: 'scene', summary: 'A falling sphere.', assumptions: ['Earth gravity, no air resistance.'], question: null, reason: null, scene: projectile() });
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
  assert.deepEqual(result.scene, decision().scene);
  assert.equal(result.approximation, null);
  const invalid = decision();
  invalid.scene.bodies[0].mass = null;
  await assert.rejects(readAssemblyResponse(stream([JSON.stringify({ type: 'decision', decision: invalid })]), () => {}));
});

test('a disconnected or failed stream never becomes a successful model', async () => {
  const progress = JSON.stringify({ type: 'progress', stage: 'generating', message: 'Designing.' }) + '\n';
  await assert.rejects(readAssemblyResponse(stream([progress]), () => {}), /before a complete model decision/);
  await assert.rejects(readAssemblyResponse(stream([progress, JSON.stringify({ type: 'error', error: { code: 'provider_rate_limited', message: 'Provider quota reached.' } })]), () => {}), /Provider quota reached/);
  await assert.rejects(readAssemblyResponse(stream([progress, '{"type":"decision"']), () => {}), SyntaxError);
});

test('unknown stages, duplicate terminal data and oversized responses are rejected', async () => {
  await assert.rejects(readAssemblyResponse(stream([JSON.stringify({ type: 'progress', stage: 'imagined', message: 'Fake progress.' })]), () => {}));
  const final = JSON.stringify({ type: 'decision', decision: decision() }) + '\n';
  await assert.rejects(readAssemblyResponse(stream([final, final]), () => {}), /after its completed decision/);
  await assert.rejects(readAssemblyResponse(stream([' '.repeat(1024 * 1024 + 1)]), () => {}), /size limit/);
});

test('normal JSON clients retain validated decisions and safe service errors', async () => {
  const response = Response.json(decision());
  assert.deepEqual((await readAssemblyResponse(response, () => {})).scene, decision().scene);
  await assert.rejects(readAssemblyResponse(Response.json({ error: { code: 'missing_credentials', message: 'No configured provider.' } }, { status: 503 }), () => {}), /No configured provider/);
});
