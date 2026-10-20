import assert from 'node:assert/strict';
import test from 'node:test';
import { runLab } from '../server/harness.ts';
import { HarnessRequestSchema } from '../shared/harness.ts';
import { validateDecision } from '../shared/scene.ts';

function completion(tool: string, args: unknown, chunkSize: number, publicText = ''): Response {
  const serialized = JSON.stringify(args);
  const records: string[] = [];
  const push = (delta: unknown, finish_reason: string | null = null) => records.push(`data: ${JSON.stringify({ id: 'isolated-completion', object: 'chat.completion.chunk', created: 1, model: 'example/model', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  if (publicText) push({ content: publicText });
  push({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${tool}`, type: 'function', function: { name: tool, arguments: '' } }] });
  for (let at = 0; at < serialized.length; at += chunkSize) push({ tool_calls: [{ index: 0, function: { arguments: serialized.slice(at, at + chunkSize) } }] });
  push({}, 'tool_calls');
  records.push('data: [DONE]\n\n');
  let at = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = records[at++];
      if (next === undefined) controller.close();
      else controller.enqueue(new TextEncoder().encode(next));
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
}

function mockProvider(t: { after: (callback: () => void) => void }, handler: (body: { tools?: { function?: { name: string } }[] }) => Response): void {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENROUTER_API_KEY;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
  });
  process.env.OPENROUTER_API_KEY = 'isolated-transport-key';
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url === 'https://openrouter.ai/api/v1/models') return Response.json({ data: [] });
    assert.equal(request.url, 'https://openrouter.ai/api/v1/chat/completions');
    return handler(JSON.parse(await request.text()));
  };
}

const request = HarnessRequestSchema.parse({ provider: 'openrouter', model: 'example/model', description: 'Show a static display of one hundred distinct boxes, with no ground or motion.' });

test('fragmented large decisions cross the isolated broker without cumulative partial-message overflow', { timeout: 120000 }, async t => {
  const decision = validateDecision({
    kind: 'scene', summary: 'One hundred distinct static boxes.', assumptions: ['Static display with zero gravity and no ground.'], question: null, reason: null,
    scene: {
      category: 'mechanics', title: 'One hundred boxes', gravity: [0, 0, 0], ground: null,
      bodies: Array.from({ length: 100 }, (_, index) => ({ id: `box_${index}`, label: `Box ${index + 1}`.padEnd(100, 'x'), shape: { kind: 'box', size: [0.2, 0.3, 0.1] }, mass: null, position: [index * 0.4, 0, 0.05], motion: { kind: 'fixed' } })),
      sites: [], tendons: [], connections: [], loads: [], events: [],
    },
  });
  let calls = 0;
  const commentary: string[] = [];
  mockProvider(t, body => {
    calls++;
    if (body.tools?.some(tool => tool.function?.name === 'submit_review')) return completion('submit_review', { approved: true, findings: [] }, 32, 'PRIVATE_REVIEW_TEXT');
    return completion('finish_experiment', { decision }, 16);
  });
  const result = await runLab(request, () => {}, text => commentary.push(text), AbortSignal.timeout(110000));
  assert.equal(calls, 2);
  if (result.kind !== 'scene') throw new Error('Expected a checked scene decision.');
  assert.equal(result.scene.bodies.length, 100);
  assert.deepEqual(result.scene.bodies.map(body => body.position), decision.scene!.bodies.map(body => body.position));
  assert.ok(!commentary.join('').includes('PRIVATE_REVIEW_TEXT'));
});

test('coalesced Unicode commentary stays valid and bounded for the browser stream', { timeout: 60000 }, async t => {
  const text = `π${'🙂'.repeat(1500)}`;
  const pieces: string[] = [];
  mockProvider(t, () => completion('finish_experiment', {
    decision: { kind: 'clarify', summary: 'A detail needs your choice.', assumptions: [], question: 'Should these bodies move?', reason: null, scene: null },
  }, 128, text));
  const result = await runLab(request, () => {}, delta => pieces.push(delta), AbortSignal.timeout(55000));
  assert.equal(result.kind, 'clarify');
  assert.equal(pieces.join(''), text);
  assert.ok(pieces.every(piece => piece.length <= 2000));
  assert.ok(pieces.every(piece => Buffer.from(piece).toString('utf8') === piece));
});
