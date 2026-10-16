import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { AssemblyRequestSchema, validateDecision, validateScene } from '../shared/scene.ts';
import { atwood, projectile } from './fixtures.ts';

function rejected(scene: unknown) {
  assert.throws(() => validateScene(scene), z.ZodError);
}

test('rejects nonexistent physical references before native allocation', () => {
  const scene = atwood();
  scene.tendons[0].path[0] = { kind: 'site', siteId: 'missing' };
  rejected(scene);
  const missingBody = atwood();
  missingBody.sites[0].bodyId = 'absent';
  rejected(missingBody);
});

test('rejects cycles in the articulation tree', () => {
  const scene = atwood();
  scene.bodies[1].parentId = 'heavy';
  scene.bodies[2].parentId = 'light';
  rejected(scene);
});

test('rejects ambiguous entity identities across physical elements', () => {
  const scene = atwood();
  scene.tendons[0].id = scene.bodies[0].id;
  rejected(scene);
});

test('does not admit massless dynamic solids or nonfinite geometry', () => {
  const noMass = projectile();
  noMass.bodies[0].mass = null;
  rejected(noMass);
  const invalidRadius = projectile();
  invalidRadius.bodies[0].shape = { kind: 'sphere', radius: Infinity };
  rejected(invalidRadius);
});

test('a point particle cannot silently acquire a collision shape', () => {
  const scene = projectile();
  scene.bodies[0].motion = { kind: 'particle', linearVelocity: [0, 0, 0] };
  rejected(scene);
});

test('rejects a moving infinite plane instead of treating it as a solid', () => {
  const scene = projectile();
  scene.bodies[0].shape = { kind: 'plane', size: [5, 5] };
  rejected(scene);
});

test('orientation and joint definitions must be physically interpretable', () => {
  const invalidRotation = projectile();
  invalidRotation.bodies[0].orientation = [0, 0, 0, 0];
  rejected(invalidRotation);
  const invalidAxis = atwood();
  const motion = invalidAxis.bodies[1].motion;
  assert.equal(motion.kind, 'slide');
  if (motion.kind === 'slide') motion.axis = [0, 0, 0];
  rejected(invalidAxis);
});

test('initial scalar coordinates must lie within their limits', () => {
  const scene = atwood();
  const motion = scene.bodies[1].motion;
  if (motion.kind === 'slide') { motion.limits = [-1, 1]; motion.position = 2; }
  rejected(scene);
});

test('inverse-square attraction refuses coincident particles', () => {
  const scene = projectile();
  const first = scene.bodies[0];
  first.shape = { kind: 'point' };
  first.motion = { kind: 'particle', linearVelocity: [0, 0, 0] };
  scene.bodies.push({ ...structuredClone(first), id: 'second', label: 'Second mass' });
  scene.loads = [{ kind: 'gravity', bodyIds: ['ball', 'second'], G: 6.6743e-11 }];
  rejected(scene);
});

test('loads cannot act on a fixed support or an absent body', () => {
  const scene = atwood();
  scene.loads = [{ kind: 'force', bodyId: 'beam', vector: [1, 0, 0], point: null }];
  rejected(scene);
});

test('strict model admission rejects executable or unrestricted solver input', () => {
  rejected({ ...projectile(), xml: '<mujoco><include file="private-file"/></mujoco>' });
  assert.throws(() => AssemblyRequestSchema.parse({
    provider: 'openrouter', model: 'openrouter/free', description: 'An experiment',
    apiKey: 'not-a-real-key',
  }), z.ZodError);
});

test('a clarification or unsupported response cannot masquerade as a ready scene', () => {
  for (const kind of ['clarify', 'unsupported']) {
    assert.throws(() => validateDecision({ kind, summary: 'Interpretation', assumptions: [],
      question: kind === 'clarify' ? 'Which mass?' : null,
      reason: kind === 'unsupported' ? 'Model unavailable' : null,
      scene: projectile(),
    }), z.ZodError);
  }
});

test('a model cannot mark a mixed explanation and scene payload successful', () => {
  assert.throws(() => validateDecision({ kind: 'scene', summary: 'Setup', assumptions: [],
    question: null, reason: 'Not supported', scene: projectile(),
  }), z.ZodError);
});

test('legacy decision payloads default the optional alternative to null', () => {
  for (const decision of [
    { kind: 'scene', summary: 'A projectile setup.', assumptions: [], question: null, reason: null, scene: projectile() },
    { kind: 'clarify', summary: 'Your launch speed is missing.', assumptions: [], question: 'What is the initial speed?', reason: null, scene: null },
    { kind: 'unsupported', summary: 'Your requested law is unavailable.', assumptions: [], question: null, reason: 'This law is not in the supported model.', scene: null },
  ]) {
    assert.equal(validateDecision(decision).alternative, null);
  }
});

test('questions and supported alternatives may accompany explanations, never a ready scene', () => {
  const alternative = { label: 'Compare free fall', description: 'Drop 1 kg and 2 kg balls 1 m apart from rest at 1 m; omit prescribed bounce elasticity.' };
  for (const kind of ['clarify', 'unsupported']) {
    const decision = validateDecision({
      kind, summary: 'Your requested rebound is not controllable.', assumptions: [],
      question: 'Would you like to compare motion before impact instead?',
      reason: 'The model cannot set a restitution coefficient.', scene: null, alternative,
    });
    assert.equal(decision.scene, null);
    assert.ok(decision.question);
    assert.deepEqual(decision.alternative, alternative);
  }
  assert.throws(() => validateDecision({
    kind: 'scene', summary: 'A projectile setup.', assumptions: [],
    question: null, reason: null, scene: projectile(), alternative,
  }), z.ZodError);
});

test('alternative labels and descriptions must be nonblank and within their limits', () => {
  const valid = {
    kind: 'unsupported', summary: 'Your requested law is unavailable.', assumptions: [],
    question: null, reason: 'This law is not in the supported model.', scene: null,
  };
  const atLimits = validateDecision({
    ...valid, alternative: { label: 'x'.repeat(60), description: 'x'.repeat(1600) },
  });
  assert.equal(atLimits.alternative?.label.length, 60);
  assert.equal(atLimits.alternative?.description.length, 1600);
  for (const alternative of [
    { label: ' ', description: 'A complete proposed scenario.' },
    { label: 'x'.repeat(61), description: 'A complete proposed scenario.' },
    { label: 'Supported revision', description: '\t' },
    { label: 'Supported revision', description: 'x'.repeat(1601) },
  ]) {
    assert.throws(() => validateDecision({ ...valid, alternative }), z.ZodError);
  }
});

test('decision scenes still receive semantic scene validation', () => {
  const scene = projectile();
  scene.bodies[0].mass = null;
  assert.throws(() => validateDecision({
    kind: 'scene', summary: 'A projectile setup.', assumptions: [],
    question: null, reason: null, scene,
  }), z.ZodError);
});

test('an inextensible cable cannot silently discard elastic or damping parameters', () => {
  const scene = atwood();
  scene.tendons[0].stiffness = 10;
  scene.tendons[0].damping = 1;
  rejected(scene);
});

test('a translational point model cannot silently discard rotational loads', () => {
  const model = projectile();
  model.bodies[0].shape = { kind: 'point' };
  model.bodies[0].motion = { kind: 'particle', linearVelocity: [0, 0, 0] };
  for (const load of [
    { kind: 'torque' as const, bodyId: 'ball', vector: [0, 0, 1] as [number, number, number] },
    { kind: 'impulse' as const, bodyId: 'ball', linear: [0, 0, 0] as [number, number, number], angular: [0, 0, 1] as [number, number, number] },
    { kind: 'force' as const, bodyId: 'ball', vector: [1, 0, 0] as [number, number, number], point: [0, 1, 0] as [number, number, number] },
  ]) {
    model.loads = [load];
    rejected(model);
  }
});
