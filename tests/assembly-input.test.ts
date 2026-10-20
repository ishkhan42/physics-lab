import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { AssemblyDecisionSchema, bodyCapacity, parseAssemblyDecision } from '../shared/assembly-input.ts';
import { validateDecision, type Decision } from '../shared/scene.ts';

function brick(id = 'brick', overrides: Record<string, unknown> = {}) {
  return {
    id, label: 'Brick', position: [1000, -0.15, 0.05],
    orientation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2],
    shape: { kind: 'box', size: [0.2, 0.3, 0.1] }, mass: 5,
    motion: { kind: 'free' }, ...overrides,
  };
}

function sceneDecision(bodies: unknown[], sceneFields: Record<string, unknown> = {}) {
  return {
    kind: 'scene', summary: 'A wall of separate bricks.', assumptions: [],
    question: null, reason: null,
    scene: {
      category: 'mechanics', title: 'Brick wall', gravity: [0, 0, -9.81], bodies,
      ...sceneFields,
    },
  };
}

function sceneOf(decision: Decision) {
  if (decision.kind !== 'scene') throw new Error('Expected a scene decision.');
  return decision.scene;
}

test('expands a 2-by-50 wall into distinct canonical five-kilogram boxes', () => {
  const input = sceneDecision([{
    kind: 'grid', counts: [1, 2, 50], spacing: [0, 0.3, 0.1], body: brick(),
  }]);
  const before = structuredClone(input);
  const bodies = sceneOf(parseAssemblyDecision(input)).bodies;

  assert.equal(bodies.length, 100);
  assert.equal(new Set(bodies.map(body => body.id)).size, 100);
  assert.deepEqual([bodies[0].id, bodies[49].id, bodies[50].id, bodies[99].id], [
    'brick_0_0_0', 'brick_0_0_49', 'brick_0_1_0', 'brick_0_1_49',
  ]);
  assert.deepEqual([bodies[0].label, bodies[99].label], ['Brick 1', 'Brick 100']);
  assert.deepEqual([bodies[0].position, bodies[49].position, bodies[50].position, bodies[99].position], [
    [1000, -0.15, 0.05], [1000, -0.15, 0.05 + 49 * 0.1],
    [1000, -0.15 + 0.3, 0.05], [1000, -0.15 + 0.3, 0.05 + 49 * 0.1],
  ]);
  assert.ok(bodies.every(body => body.mass === 5 && body.shape.kind === 'box'
    && body.shape.size[0] === 0.2 && body.shape.size[1] === 0.3 && body.shape.size[2] === 0.1));
  assert.ok(bodies.every(body => body.orientation[0] === Math.SQRT1_2 && body.orientation[3] === Math.SQRT1_2));
  assert.notStrictEqual(bodies[0], bodies[1]);
  assert.notStrictEqual(bodies[0].position, bodies[1].position);
  assert.notStrictEqual(bodies[0].orientation, bodies[1].orientation);
  assert.notStrictEqual(bodies[0].shape, bodies[1].shape);
  assert.deepEqual(input, before);
});

test('validates grid counts and expanded capacity including automatic ground', () => {
  const gridDecision = (counts: number[], ground?: null) => sceneDecision([{
    kind: 'grid', counts, spacing: counts.map(axisCount => axisCount === 1 ? 0 : 1), body: brick(),
  }], ground === null ? { ground: null } : {});

  for (const counts of [[0, 1, 1], [1.5, 1, 1], [129, 1, 1], [128, 128, 128]]) {
    assert.throws(() => parseAssemblyDecision(gridDecision(counts)), z.ZodError);
  }
  assert.throws(() => parseAssemblyDecision(sceneDecision([{
    kind: 'grid', counts: [2, 1, 1], spacing: [0, 0, 0], body: brick(),
  }])), z.ZodError);
  assert.throws(() => parseAssemblyDecision(sceneDecision([{
    kind: 'grid', counts: [1, 1, 1], spacing: [Infinity, 0, 0], body: brick(),
  }])), z.ZodError);
  assert.equal(sceneOf(parseAssemblyDecision(gridDecision([127, 1, 1]))).bodies.length, 127);
  assert.equal(sceneOf(parseAssemblyDecision(gridDecision([128, 1, 1], null))).bodies.length, 128);
  assert.throws(() => parseAssemblyDecision(gridDecision([128, 1, 1])), z.ZodError);
});

test('canonical validation still rejects duplicate IDs, dangling references, and generated overflow', () => {
  assert.throws(() => parseAssemblyDecision(sceneDecision([brick('same'), brick('same')])), z.ZodError);
  assert.throws(() => parseAssemblyDecision(sceneDecision([brick('child', { parentId: 'missing' })])), z.ZodError);
  assert.throws(() => parseAssemblyDecision(sceneDecision([brick()], {
    sites: [{ id: 'anchor', label: 'Anchor', bodyId: 'missing', position: [0, 0, 0] }],
  })), z.ZodError);
  assert.throws(() => parseAssemblyDecision(sceneDecision([{
    kind: 'grid', counts: [1, 1, 1], spacing: [0, 0, 0], body: brick('i'.repeat(59)),
  }])), z.ZodError);
  assert.throws(() => parseAssemblyDecision(sceneDecision([{
    kind: 'grid', counts: [1, 1, 1], spacing: [0, 0, 0], body: brick('brick', { label: 'L'.repeat(100) }),
  }])), z.ZodError);
  assert.throws(() => parseAssemblyDecision(sceneDecision([{
    kind: 'grid', counts: [1, 1, 1], spacing: [0, 0, 0], body: brick(), executable: 'no',
  }])), z.ZodError);
});

test('ordinary scenes and non-scene decisions retain canonical validation', () => {
  const ordinary = sceneDecision([brick('ordinary')]);
  assert.deepEqual(parseAssemblyDecision(ordinary), validateDecision(ordinary));

  for (const decision of [
    {
      kind: 'clarify', summary: 'A consequential question.', assumptions: [],
      question: 'Which motion should be modeled?', reason: null, scene: null,
    },
    {
      kind: 'unsupported', summary: 'The requested law is unavailable.', assumptions: [],
      question: null, reason: 'The model does not support that law.', scene: null,
    },
  ]) {
    const parsed = parseAssemblyDecision(decision);
    assert.deepEqual(parsed, validateDecision(decision));
    assert.equal(parsed.scene, null);
  }
});
test('model decision input cannot author a host proposal or verification receipt', () => {
  const candidate = sceneDecision([brick()]);
  assert.equal(AssemblyDecisionSchema.safeParse({
    kind: 'proposal', decision: candidate, verification: { checkedThroughSeconds: 0.5 },
    concerns: [{ code: 'relationship', message: 'A concrete mismatch.' }],
  }).success, false);
  assert.equal(AssemblyDecisionSchema.safeParse({
    ...candidate, verification: { checkedThroughSeconds: 0.5 },
    concerns: [{ code: 'relationship', message: 'A concrete mismatch.' }],
  }).success, false);
  assert.throws(() => parseAssemblyDecision({ kind: 'proposal', decision: candidate, verification: { checkedThroughSeconds: 0.5 }, concerns: [] }), z.ZodError);
});

test('body capacity accounts for current bodies and its ground source', () => {
  const scene = sceneOf(parseAssemblyDecision(sceneDecision([
    brick('one'), brick('two'), brick('three'), brick('four'),
  ])));
  assert.deepEqual(bodyCapacity(scene), {
    maxBodies: 128, currentBodies: 4, automaticGroundBodies: 1,
    physicalBodies: 5, remainingBodies: 123, source: 'current-scene',
  });
  assert.deepEqual(bodyCapacity({ ...scene, ground: null }), {
    maxBodies: 128, currentBodies: 4, automaticGroundBodies: 0,
    physicalBodies: 4, remainingBodies: 124, source: 'current-scene',
  });
  assert.deepEqual(bodyCapacity(null), {
    maxBodies: 128, currentBodies: 0, automaticGroundBodies: 1,
    physicalBodies: 1, remainingBodies: 127, source: 'default-ground-reservation',
  });
});
