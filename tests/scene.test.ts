import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { hasGroundPlane, physicalScene, validateDecision, validateScene } from '../shared/scene.ts';
import { HarnessRequestSchema } from '../shared/harness.ts';
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

test('point particles cannot silently ignore restitution or friction', () => {
  for (const material of [{ restitution: 1 }, { friction: { sliding: 0.3, static: 0.5 } }]) {
    const scene = projectile();
    scene.bodies[0].shape = { kind: 'point' };
    scene.bodies[0].motion = { kind: 'particle', linearVelocity: [0, 0, 0] };
    rejected({ ...scene, bodies: [{ ...scene.bodies[0], ...material }] });
  }
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
  assert.throws(() => HarnessRequestSchema.parse({
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

test('omitted optional decision metadata does not invent a proposal or approximation', () => {
  for (const decision of [
    { kind: 'scene', summary: 'A projectile setup.', assumptions: [], question: null, reason: null, scene: projectile() },
    { kind: 'clarify', summary: 'Your launch speed is missing.', assumptions: [], question: 'What is the initial speed?', reason: null, scene: null },
    { kind: 'unsupported', summary: 'Your requested law is unavailable.', assumptions: [], question: null, reason: 'This law is not in the supported model.', scene: null },
  ]) {
    assert.equal(validateDecision(decision).alternative, null);
    assert.equal(validateDecision(decision).approximation, null);
  }
});

test('questions and supported alternatives may accompany explanations, never a ready scene', () => {
  const alternative = { label: 'Rigid-body impact', description: 'Model a 1 kg rigid sphere hitting a fixed support; omit the requested permanent dent and disclose restitution 0.2.' };
  for (const kind of ['clarify', 'unsupported']) {
    const decision = validateDecision({
      kind, summary: 'Permanent dents need a deformation model.', assumptions: [],
      question: 'Would a rigid-body impact comparison help?',
      reason: 'The current solver does not model permanent material deformation.', scene: null, alternative,
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

test('an explicitly approximate preview retains physical validation and cannot authorize an unresolved decision', () => {
  const approximation = 'Rigid-body motion only; permanent deformation is not modeled.';
  const input = {
    kind: 'scene', summary: 'A rigid-body impact approximation.', assumptions: [],
    question: null, reason: null, scene: projectile(), approximation,
  };
  const decision = validateDecision(input);
  assert.equal(decision.approximation, approximation);
  assert.deepEqual(decision.scene, input.scene);
  const invalidScene = projectile();
  invalidScene.bodies[0].mass = null;
  assert.throws(() => validateDecision({ ...input, scene: invalidScene }), z.ZodError);
  for (const kind of ['clarify', 'unsupported']) {
    assert.throws(() => validateDecision({
      ...input, kind, scene: null,
      question: kind === 'clarify' ? 'Which impact geometry?' : null,
      reason: kind === 'unsupported' ? 'No meaningful mechanical model.' : null,
    }), z.ZodError);
  }
  assert.throws(() => validateDecision({ ...input, approximation: ' ' }), z.ZodError);
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

test('material schemas default coefficients and enforce physical ranges', () => {
  const scene = validateScene({ ...projectile(), ground: undefined });
  assert.deepEqual(scene.ground, {
    height: 0, restitution: 1,
    friction: { sliding: 0, torsional: 0, rolling: 0, static: null },
  });
  assert.equal(scene.bodies[0].restitution, 0);
  assert.deepEqual(scene.bodies[0].friction, { sliding: 0, torsional: 0, rolling: 0, static: null });

  const boundary = structuredClone(scene);
  boundary.bodies[0].restitution = 1;
  boundary.bodies[0].friction = { sliding: 0.4, static: 0.4, torsional: 0, rolling: 0 };
  boundary.ground!.restitution = 0;
  boundary.ground!.friction = { sliding: 0.4, static: null, torsional: 1, rolling: 2 };
  assert.deepEqual(validateScene(boundary).bodies[0].friction, boundary.bodies[0].friction);

  const partial = validateScene({
    ...scene, bodies: [{ ...scene.bodies[0], friction: { sliding: 0.2 } }],
  });
  assert.deepEqual(partial.bodies[0].friction, { sliding: 0.2, torsional: 0, rolling: 0, static: null });

  for (const coefficient of [-0.01, 1.01]) {
    const invalidBody = structuredClone(scene);
    invalidBody.bodies[0].restitution = coefficient;
    rejected(invalidBody);
    const invalidGround = structuredClone(scene);
    invalidGround.ground!.restitution = coefficient;
    rejected(invalidGround);
  }
  for (const field of ['sliding', 'torsional', 'rolling', 'static'] as const) {
    const invalid = structuredClone(scene);
    invalid.bodies[0].friction[field] = -0.01;
    rejected(invalid);
  }
  const invalidStatic = structuredClone(scene);
  invalidStatic.bodies[0].friction.sliding = 0.5;
  invalidStatic.bodies[0].friction.static = 0.49;
  rejected(invalidStatic);
  const invalidGroundFriction = structuredClone(scene);
  invalidGroundFriction.ground!.friction.sliding = 0.5;
  invalidGroundFriction.ground!.friction.static = 0.49;
  rejected(invalidGroundFriction);
});

test('physical scenes add one canonical ground without mutating or double-expanding', () => {
  const scene = validateScene({
    ...projectile(), ground: {
      height: -0.25, restitution: 0.8,
      friction: { sliding: 0.3, static: 0.5, torsional: 0.01, rolling: 0.02 },
    },
  });
  const original = structuredClone(scene);
  const expanded = physicalScene(scene);
  assert.deepEqual(scene, original);
  assert.deepEqual(expanded.ground, null);
  assert.deepEqual(expanded.bodies.at(-1), {
    id: 'world-ground', label: 'Ground', parentId: null,
    heldBy: null,
    position: [0, 0, -0.25], orientation: [1, 0, 0, 0],
    shape: { kind: 'plane', size: [10, 10] }, mass: null,
    motion: { kind: 'fixed' }, restitution: 0.8,
    friction: { sliding: 0.3, static: 0.5, torsional: 0.01, rolling: 0.02 },
    color: '#bacbd1',
  });
  assert.equal(physicalScene(expanded), expanded);

  const noGround = projectile();
  assert.equal(physicalScene(noGround), noGround);
  assert.equal(physicalScene(noGround).bodies.length, noGround.bodies.length);
});

test('ground ID is reserved, references resolve, and the body budget includes ground', () => {
  const scene = validateScene({ ...projectile(), ground: undefined });
  scene.sites = [{ id: 'ground-site', label: 'Ground attachment', bodyId: 'world-ground', position: [0, 0, 0] }];
  scene.connections = [{ kind: 'weld', id: 'ground-weld', label: 'Ground connection', bodyA: 'ball', bodyB: 'world-ground' }];
  assert.equal(validateScene(scene).sites[0].bodyId, 'world-ground');
  assert.equal(physicalScene(scene).connections[0].bodyB, 'world-ground');

  const reservedBody = validateScene({ ...projectile(), ground: undefined });
  reservedBody.bodies[0].id = 'world-ground';
  rejected(reservedBody);
  const reservedSite = validateScene({ ...projectile(), ground: undefined });
  reservedSite.sites = [{ id: 'world-ground', label: 'Reserved', bodyId: null, position: [0, 0, 0] }];
  rejected(reservedSite);
  const allowedWithoutGround = validateScene({
    ...projectile(), ground: null, bodies: [{ ...projectile().bodies[0], id: 'world-ground' }],
  });
  assert.equal(allowedWithoutGround.bodies[0].id, 'world-ground');

  const oneBody = projectile().bodies[0];
  const atLimit = validateScene({
    ...projectile(), ground: undefined,
    bodies: Array.from({ length: 127 }, (_, i) => ({ ...oneBody, id: `body-${i}` })),
  });
  assert.equal(physicalScene(atLimit).bodies.length, 128);
  rejected({ ...atLimit, bodies: [...atLimit.bodies, { ...oneBody, id: 'body-over-limit' }] });
});


test('custom horizontal ground avoids duplicate floors while walls and ceilings do not remove the default', () => {
  assert.equal(hasGroundPlane(projectile()), false);
  assert.equal(hasGroundPlane(validateScene({ ...projectile(), ground: undefined })), true);
  const base = projectile().bodies[0];
  for (const [orientation, expected] of [
    [[1, 0, 0, 0], true],
    [[Math.SQRT1_2, 0, 0, Math.SQRT1_2], true],
    [[Math.SQRT1_2, 0, Math.SQRT1_2, 0], false],
    [[0, 1, 0, 0], false],
  ] as const) {
    const scene = validateScene({
      ...projectile(), bodies: [base, {
        ...base, id: 'support', mass: null, motion: { kind: 'fixed' },
        shape: { kind: 'plane', size: [5, 5] }, orientation,
      }],
    });
    assert.equal(hasGroundPlane(scene), expected);
  }
});
