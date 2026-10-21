import assert from 'node:assert/strict';
import test from 'node:test';
import { validateDecision, validateScene } from '../shared/scene.ts';
import { makeHarnessFailure } from '../shared/harness-failure.ts';
import { createRuntime } from '../src/physics/mujoco.ts';
import { advanceNativeCheckTo, NATIVE_CHECK_WALL_BUDGET_MS } from '../src/physics/native-check.ts';
import type { InspectionSnapshot, MechanicsRuntime } from '../src/physics/types.ts';
import { atwood, changingWrap, projectile } from './fixtures.ts';

function vectorValue(snapshot: InspectionSnapshot, entityId: string, label: string): number[] {
  const entity = snapshot.entities.find(item => item.id === entityId);
  assert.ok(entity, `missing entity ${entityId}`);
  const property = entity.properties.find(item => item.label === label);
  assert.ok(property, `missing ${label} for ${entityId}`);
  assert.ok(Array.isArray(property.value), `${label} must be a vector`);
  return property.value;
}

function scalarValue(snapshot: InspectionSnapshot, entityId: string, label: string): number {
  const entity = snapshot.entities.find(item => item.id === entityId);
  assert.ok(entity, `missing entity ${entityId}`);
  const property = entity.properties.find(item => item.label === label);
  assert.ok(property, `missing ${label} for ${entityId}`);
  assert.equal(typeof property.value, 'number');
  return property.value as number;
}

function simulate(runtime: MechanicsRuntime, simulatedSeconds: number, speed: number): void {
  const target = runtime.time + simulatedSeconds;
  while (runtime.time < target - 1e-10) {
    const wallSeconds = Math.min(0.25, 0.5 / speed, (target - runtime.time) / speed);
    const result = runtime.advance(wallSeconds, speed);
    assert.equal(result.pauseReason, null);
    assert.ok(result.steps > 0);
  }
}

function freeSphereScene(title: string, velocity: number[] = [0, 0, 0], loads: unknown[] = [], position: number[] = [0, 0, 0], mass = 2) {
  return validateScene({
    category: 'mechanics', title, gravity: [0, 0, 0], ground: null,
    bodies: [{ id: 'body', label: 'Test body', parentId: null, position, shape: { kind: 'sphere', radius: 0.1 }, mass,
      motion: { kind: 'free', linearVelocity: velocity, angularVelocity: [0, 0, 0] }, color: '#67d9ce' }],
    sites: [], tendons: [], connections: [], loads,
  });
}

test('free projectile matches analytical horizontal launch', async () => {
  const runtime = await createRuntime(projectile());
  try {
    simulate(runtime, 1, 1);
    const position = vectorValue(runtime.snapshot(), 'ball', 'Position');
    assert.ok(Math.abs(position[0] - 5) < 1e-8);
    assert.ok(Math.abs(position[1]) < 1e-8);
    assert.ok(Math.abs(position[2] - 15.095) < 0.006);
  } finally {
    runtime.dispose();
  }
});

test('a browser work budget defers fixed steps but never skips them', async () => {
  const budgeted = await createRuntime(projectile());
  const reference = await createRuntime(projectile());
  try {
    assert.equal(budgeted.advance(0.1, 1, 0).steps, 1);
    let total = 1;
    for (let call = 0; call < 200; call++) {
      const result = budgeted.advance(0, 1, 0);
      assert.equal(result.pauseReason, null);
      total += result.steps;
      if (result.steps === 0) break;
    }
    assert.equal(total, 100);
    reference.advance(0.1, 1);
    assert.deepEqual(vectorValue(budgeted.snapshot(), 'ball', 'Position'), vectorValue(reference.snapshot(), 'ball', 'Position'));
  } finally {
    budgeted.dispose();
    reference.dispose();
  }
});

test('budgeted native substeps resume, reset, and apply scheduled events once', async () => {
  const scene = validateScene({
    category: 'mechanics', title: 'Paused native substeps', gravity: [0, 0, 0], ground: null,
    bodies: [
      { id: 'body', label: 'Moving body', position: [0, 0, 0], shape: { kind: 'box', size: [0.2, 0.2, 0.2] }, mass: 1,
        friction: { sliding: 0.3 }, motion: { kind: 'free', linearVelocity: [0, 0, 0], angularVelocity: [0, 0, 0] } },
      { id: 'support', label: 'Remote support', position: [3, 0, 0], shape: { kind: 'box', size: [0.2, 0.2, 0.2] }, mass: null,
        motion: { kind: 'fixed' } },
    ],
    events: [
      { id: 'push', label: 'Initial push', at: 0,
        action: { kind: 'impulse', bodyId: 'body', linear: [1, 0, 0], angular: [0, 0, 0] } },
      { id: 'stop', label: 'Boundary impulse', at: 0.0005,
        action: { kind: 'impulse', bodyId: 'body', linear: [-1, 0, 0], angular: [0, 0, 0] } },
    ],
  });
  const budgeted = await createRuntime(scene);
  const reference = await createRuntime(scene);
  try {
    const idle = budgeted.advance(0, 1, 0);
    assert.equal(idle.steps, 0);
    assert.equal(budgeted.time, 0);
    assert.equal(budgeted.snapshot().events?.[0].status, 'pending');
    const partial = budgeted.advance(0.001, 1, 0);
    assert.equal(partial.pauseReason, null);
    assert.equal(partial.steps, 0);
    assert.equal(budgeted.time, 0.001 / 16);
    assert.ok(Math.abs(budgeted.frame().find(item => item.id === 'body')!.position[0] - budgeted.time) < 1e-12);
    const partialSnapshot = budgeted.snapshot();
    assert.equal(partialSnapshot.time, budgeted.time);
    assert.equal(partialSnapshot.events?.[0].firedAt, 0);
    assert.deepEqual(vectorValue(partialSnapshot, 'body', 'Contact force'), [0, 0, 0]);
    const pausedAt = budgeted.time;
    const longGap = budgeted.advance(0.251, 1, 0);
    assert.notEqual(longGap.pauseReason, null);
    assert.equal(longGap.steps, 0);
    assert.equal(budgeted.time, pausedAt);
    const afterGap = budgeted.snapshot();
    assert.equal(afterGap.time, pausedAt);
    assert.deepEqual(vectorValue(afterGap, 'body', 'Velocity'), [1, 0, 0]);

    budgeted.reset();
    assert.equal(budgeted.time, 0);
    assert.equal(budgeted.snapshot().events?.[0].status, 'pending');
    const replay = budgeted.advance(0.001, 1, 0);
    assert.equal(replay.steps, 0);
    assert.equal(budgeted.snapshot().events?.[0].firedAt, 0);

    let nativeSubsteps = 1;
    let completedSteps = replay.steps;
    while (completedSteps === 0) {
      const previousTime = budgeted.time;
      const result = budgeted.advance(0, 1, 0);
      assert.equal(result.pauseReason, null);
      assert.ok(Math.abs(budgeted.time - previousTime - 0.001 / 16) < 1e-15);
      nativeSubsteps++;
      completedSteps += result.steps;
      if (nativeSubsteps === 8) {
        const boundary = budgeted.snapshot();
        assert.equal(boundary.time, 0.0005);
        assert.equal(boundary.events?.[1].firedAt, 0.0005);
        assert.equal(vectorValue(boundary, 'body', 'Velocity')[0], 0);
      }
      if (nativeSubsteps === 9) assert.equal(budgeted.snapshot().events?.[1].firedAt, 0.0005);
      assert.ok(nativeSubsteps <= 16);
    }
    assert.equal(nativeSubsteps, 16);
    assert.equal(completedSteps, 1);
    assert.ok(Math.abs(budgeted.time - 0.001) < 1e-15);

    reference.advance(0.001, 1);
    const actual = budgeted.snapshot();
    const expected = reference.snapshot();
    assert.deepEqual(vectorValue(actual, 'body', 'Position'), vectorValue(expected, 'body', 'Position'));
    assert.deepEqual(vectorValue(actual, 'body', 'Velocity'), vectorValue(expected, 'body', 'Velocity'));
    assert.equal(actual.events?.[0].firedAt, 0);
    assert.equal(actual.events?.[1].firedAt, 0.0005);
    assert.equal(actual.events?.[0].status, 'completed');
  } finally {
    budgeted.dispose();
    reference.dispose();
  }
});


test('native check reaches its exact sample target and stops when its deadline expires', async () => {
  const runtime = await createRuntime(projectile());
  try {
    let samples = 0;
    const bodyCount = runtime.scene.bodies.length;
    await advanceNativeCheckTo(runtime, 0.026, performance.now() + NATIVE_CHECK_WALL_BUDGET_MS, bodyCount,
      () => samples++, () => {});
    assert.ok(Math.abs(runtime.time - 0.026) < 1e-12);
    assert.equal(samples, 2);
    const reachedTime = runtime.time;
    await assert.rejects(advanceNativeCheckTo(runtime, 0.05, performance.now() - 1, bodyCount,
      () => samples++, () => {}), error => {
      const diagnostic = makeHarnessFailure(error, { stage: 'checking', modelTurns: 1, toolCalls: 1 });
      assert.equal(diagnostic.code, 'physics_check_failed');
      assert.equal(diagnostic.lastIssue?.code, 'native_error');
      return true;
    });
    assert.equal(runtime.time, reachedTime);
  } finally {
    runtime.dispose();
  }
});

test('native checks accept physical progress within an unfinished millisecond', async () => {
  const runtime = await createRuntime(validateScene({ ...projectile(), ground: undefined }));
  const advance = runtime.advance.bind(runtime);
  runtime.advance = (seconds, speed) => advance(seconds, speed, 0);
  const progress: number[] = [];
  try {
    await advanceNativeCheckTo(runtime, 0.002, performance.now() + NATIVE_CHECK_WALL_BUDGET_MS,
      runtime.scene.bodies.length, () => {}, time => progress.push(time));
    assert.ok(progress.some(time => time > 0 && time < 0.001));
    assert.ok(Math.abs(runtime.time - 0.002) < 1e-12);
    const state = runtime.snapshot();
    assert.ok(Math.abs(vectorValue(state, 'ball', 'Position')[0] - 0.01) < 1e-12);
    assert.ok(Math.abs(vectorValue(state, 'ball', 'Velocity')[2] + 9.81 * 0.002) < 1e-12);
  } finally {
    runtime.dispose();
  }
});

test('generated initial world poses use zero joint coordinates without applying the displacement twice', async () => {
  const decision = validateDecision({
    kind: 'scene', summary: 'A guided sphere pulled toward its spring equilibrium.', assumptions: [],
    question: null, reason: null, scene: {
      category: 'mechanics', title: 'Initial-pose spring', gravity: [0, 0, 0],
      bodies: [{
        id: 'sphere', label: 'Guided sphere', position: [2, 0, 1],
        shape: { kind: 'sphere', radius: 0.05 }, mass: 1,
        motion: { kind: 'slide', axis: [1, 0, 0], anchor: [0, 0, 1], stiffness: 10, springReference: -1 },
      }],
    },
  });
  assert.ok(decision.scene);
  const runtime = await createRuntime(decision.scene);
  try {
    assert.deepEqual(vectorValue(runtime.snapshot(), 'sphere', 'Position'), [2, 0, 1]);
    simulate(runtime, 0.01, 1);
    const velocity = vectorValue(runtime.snapshot(), 'sphere', 'Velocity');
    assert.ok(Math.abs(velocity[0] + 0.1) < 0.0002);
    assert.equal(velocity[1], 0);
    assert.equal(velocity[2], 0);
    runtime.reset();
    assert.deepEqual(vectorValue(runtime.snapshot(), 'sphere', 'Position'), [2, 0, 1]);
  } finally {
    runtime.dispose();
  }
});

test('rendered spring state carries signed native length and force; visual controls do not change motion', async () => {
  const springScene = (restLength: number, anchorX: number, styled = false) => validateScene({
    category: 'mechanics', title: 'Signed spring render state', gravity: [0, 0, 0], ground: null,
    bodies: [{
      id: 'mass', label: 'Sliding mass', position: [2, 0, 1], shape: { kind: 'sphere', radius: 0.05 }, mass: 1,
      motion: { kind: 'slide', axis: [1, 0, 0], anchor: [0, 0, 1] },
    }],
    sites: [
      { id: 'attached', label: 'Mass attachment', bodyId: 'mass', position: [0, 0, 0] },
      { id: 'anchor', label: 'World anchor', bodyId: null, position: [anchorX, 0, 1] },
    ],
    tendons: [{
      id: 'spring', label: 'Spatial spring', mode: 'spring', length: restLength, stiffness: 10, damping: 0,
      path: [{ kind: 'site', siteId: 'attached' }, { kind: 'site', siteId: 'anchor' }],
      ...(styled ? { visual: { wireRadius: 0.01, coilRadius: 0.1, turns: 8, forceScale: 25 } } : {}),
    }],
  });
  const [stretched, styled, compressed] = await Promise.all([
    createRuntime(springScene(1, 0)),
    createRuntime(springScene(1, 0, true)),
    createRuntime(springScene(2, 3)),
  ]);
  try {
    const state = (runtime: MechanicsRuntime) => runtime.frame().find(item => item.entityId === 'spring')!.tendon!;
    const stretchState = state(stretched);
    const stretchSnapshot = stretched.snapshot();
    assert.equal(stretchState.mode, 'spring');
    assert.equal(stretchState.restLength, 1);
    assert.equal(stretchState.length, scalarValue(stretchSnapshot, 'spring', 'Length'));
    assert.equal(stretchState.force, scalarValue(stretchSnapshot, 'spring', 'Axial force'));
    assert.ok(stretchState.force! > 0);
    assert.deepEqual(styled.snapshot(), stretchSnapshot);

    const compressionState = state(compressed);
    const compressionSnapshot = compressed.snapshot();
    assert.equal(compressionState.length, scalarValue(compressionSnapshot, 'spring', 'Length'));
    assert.equal(compressionState.force, scalarValue(compressionSnapshot, 'spring', 'Axial force'));
    assert.ok(compressionState.force! < 0);

    simulate(stretched, 0.1, 1);
    simulate(styled, 0.1, 1);
    assert.deepEqual(styled.snapshot(), stretched.snapshot());
  } finally {
    stretched.dispose();
    styled.dispose();
    compressed.dispose();
  }
});

test('routed Atwood cable has the measured acceleration and Jacobian-signed tension', async () => {
  const runtime = await createRuntime(atwood());
  try {
    simulate(runtime, 1, 1);
    const snapshot = runtime.snapshot();
    assert.ok(Math.abs(vectorValue(snapshot, 'light', 'Position')[2] - 1.635) < 0.002);
    assert.ok(Math.abs(vectorValue(snapshot, 'heavy', 'Position')[2] + 1.635) < 0.002);
    assert.ok(Math.abs(scalarValue(snapshot, 'cord', 'Tension') - 13.08) < 0.05);
    const render = runtime.frame().find(item => item.entityId === 'cord')!.tendon!;
    assert.equal(render.mode, 'fixed');
    assert.equal(render.length, scalarValue(snapshot, 'cord', 'Length'));
    assert.equal(render.restLength, 6);
    assert.equal(render.force, scalarValue(snapshot, 'cord', 'Tension'));
  } finally {
    runtime.dispose();
  }
});

test('fixed tendons render native compression with its negative sign', async () => {
  const runtime = await createRuntime(validateScene({
    category: 'mechanics', title: 'Compressed fixed tendon', gravity: [0, 0, 0], ground: null,
    bodies: [{
      id: 'mass', label: 'Sliding mass', position: [1, 0, 1], shape: { kind: 'sphere', radius: 0.05 }, mass: 1,
      motion: { kind: 'slide', axis: [1, 0, 0], anchor: [0, 0, 1] },
    }],
    sites: [
      { id: 'attached', label: 'Mass attachment', bodyId: 'mass', position: [0, 0, 0] },
      { id: 'anchor', label: 'World anchor', bodyId: null, position: [0, 0, 1] },
    ],
    tendons: [{
      id: 'fixed', label: 'Bilateral link', mode: 'fixed', length: 1, stiffness: 0, damping: 0,
      path: [{ kind: 'site', siteId: 'attached' }, { kind: 'site', siteId: 'anchor' }],
    }],
    loads: [{ kind: 'force', bodyId: 'mass', vector: [-1, 0, 0], point: null }],
  }));
  try {
    simulate(runtime, 0.01, 1);
    const snapshot = runtime.snapshot();
    const force = scalarValue(snapshot, 'fixed', 'Tension');
    const render = runtime.frame().find(item => item.entityId === 'fixed')!.tendon!;
    assert.ok(force < 0);
    assert.equal(render.force, force);
    assert.equal(render.length, scalarValue(snapshot, 'fixed', 'Length'));
  } finally { runtime.dispose(); }
});

test('fixed tendon force stays unavailable when its native path has no generalized force', async () => {
  const model = atwood();
  model.sites.push(
    { id: 'static_a', label: 'Static endpoint A', bodyId: null, position: [5, 0, 0] },
    { id: 'static_b', label: 'Static endpoint B', bodyId: null, position: [6, 0, 0] },
  );
  model.tendons.push({
    ...model.tendons[0]!, id: 'static', label: 'Static reference',
    path: [{ kind: 'site', siteId: 'static_a' }, { kind: 'site', siteId: 'static_b' }],
    length: 1,
  });
  const runtime = await createRuntime(model);
  try {
    const snapshot = runtime.snapshot();
    const staticState = runtime.frame().find(item => item.entityId === 'static')!.tendon!;
    const staticInspection = snapshot.entities.find(entity => entity.id === 'static')!;
    assert.equal(staticState.force, null);
    assert.ok(!staticInspection.properties.some(property => property.label === 'Tension'));
  } finally { runtime.dispose(); }
});

test('pulley rendering scales the native axial force for each branch', async () => {
  const model = atwood();
  const tendon = model.tendons[0]!;
  tendon.path = [
    { kind: 'site', siteId: 'light_end' },
    { kind: 'site', siteId: 'left_guide' },
    { kind: 'pulley', divisor: 2 },
    { kind: 'site', siteId: 'right_guide' },
    { kind: 'site', siteId: 'heavy_end' },
  ];
  tendon.length = 3;
  const runtime = await createRuntime(model);
  try {
    simulate(runtime, 0.5, 1);
    const snapshot = runtime.snapshot();
    const generalizedForce = scalarValue(snapshot, 'cord', 'Tension');
    const branches = runtime.frame().filter(item => item.entityId === 'cord');
    assert.equal(branches.length, 2);
    assert.ok(Math.abs(generalizedForce) > 1);
    assert.equal(branches[0]!.tendon!.force, generalizedForce);
    assert.equal(branches[1]!.tendon!.force, generalizedForce / 2);
    assert.equal(branches[0]!.tendon!.length, scalarValue(snapshot, 'cord', 'Length'));
    assert.equal(branches[1]!.tendon!.length, scalarValue(snapshot, 'cord', 'Length'));
  } finally { runtime.dispose(); }
});

test('equal simulated time is independent of playback speed and snapshots do not alias live state', async () => {
  const runtimes = await Promise.all([createRuntime(projectile()), createRuntime(projectile()), createRuntime(projectile())]);
  try {
    const saved = runtimes[0].snapshot();
    const savedPosition = [...vectorValue(saved, 'ball', 'Position')];
    simulate(runtimes[0], 1, 0.1);
    simulate(runtimes[1], 1, 1);
    simulate(runtimes[2], 1, 10);
    const positions = runtimes.map(runtime => vectorValue(runtime.snapshot(), 'ball', 'Position'));
    assert.ok(Math.abs(positions[0][0] - positions[1][0]) < 1e-12);
    assert.ok(Math.abs(positions[1][0] - positions[2][0]) < 1e-12);
    assert.ok(Math.abs(positions[0][2] - positions[2][2]) < 1e-12);
    assert.equal(saved.time, 0);
    assert.deepEqual(vectorValue(saved, 'ball', 'Position'), savedPosition);
  } finally {
    for (const runtime of runtimes) runtime.dispose();
  }
});

test('initial impulse is applied once and continuous force is recomputed instead of accumulated', async () => {
  const impulse = await createRuntime(freeSphereScene('Single impulse', [0, 0, 0], [
    { kind: 'impulse', bodyId: 'body', linear: [10, 0, 0], angular: [0, 0, 0] },
  ]));
  const force = await createRuntime(freeSphereScene('Constant force', [0, 0, 0], [
    { kind: 'force', bodyId: 'body', vector: [10, 0, 0], point: null },
  ]));
  try {
    assert.ok(Math.abs(vectorValue(impulse.snapshot(), 'body', 'Velocity')[0] - 5) < 1e-10);
    simulate(impulse, 0.1, 1);
    assert.ok(Math.abs(vectorValue(impulse.snapshot(), 'body', 'Position')[0] - 0.5) < 1e-6);
    assert.ok(Math.abs(vectorValue(impulse.snapshot(), 'body', 'Velocity')[0] - 5) < 1e-10);
    simulate(force, 1, 1);
    assert.ok(Math.abs(vectorValue(force.snapshot(), 'body', 'Velocity')[0] - 5) < 1e-8);
    assert.ok(Math.abs(vectorValue(force.snapshot(), 'body', 'Position')[0] - 2.5) < 0.003);
  } finally {
    impulse.dispose();
    force.dispose();
  }
});

test('reset restores the initial impulse state and discards queued fractional time', async () => {
  const runtime = await createRuntime(freeSphereScene('Replay an impulse', [1, 0, 0], [
    { kind: 'impulse', bodyId: 'body', linear: [4, 0, 0], angular: [0, 0, 0] },
    { kind: 'force', bodyId: 'body', vector: [2, 0, 0], point: null },
  ]));
  try {
    const initial = runtime.snapshot();
    simulate(runtime, 0.1, 1);
    runtime.advance(0.0009, 1);
    runtime.reset();
    assert.deepEqual(runtime.snapshot(), initial);
    assert.equal(runtime.advance(0.0002, 1).steps, 0);
    assert.equal(runtime.advance(0.0008, 1).steps, 1);
    assert.ok(Math.abs(vectorValue(runtime.snapshot(), 'body', 'Velocity')[0] - 3.001) < 1e-10);
    runtime.reset();
    assert.deepEqual(runtime.snapshot(), initial);
  } finally {
    runtime.dispose();
  }
});

test('drag uses current world velocity and uniform mutual gravity attracts point particles', async () => {
  const drag = await createRuntime(freeSphereScene('Linear drag', [1, 0, 0], [
    { kind: 'drag', bodyId: 'body', coefficient: 2, mediumVelocity: [0, 0, 0] },
  ]));
  const particles = validateScene({
    category: 'mechanics', title: 'Mutual point gravity', gravity: [0, 0, 0], ground: null,
    bodies: [
      { id: 'left', label: 'Left particle', parentId: null, position: [-1, 0, 0], shape: { kind: 'point' }, mass: 1, motion: { kind: 'particle', linearVelocity: [0, 0, 0] }, color: '#67d9ce' },
      { id: 'right', label: 'Right particle', parentId: null, position: [1, 0, 0], shape: { kind: 'point' }, mass: 1, motion: { kind: 'particle', linearVelocity: [0, 0, 0] }, color: '#f2c178' },
    ],
    sites: [], tendons: [], connections: [], loads: [{ kind: 'gravity', bodyIds: ['left', 'right'], G: 1 }],
  });
  const gravity = await createRuntime(particles);
  try {
    simulate(drag, 0.1, 1);
    assert.ok(Math.abs(vectorValue(drag.snapshot(), 'body', 'Velocity')[0] - Math.exp(-0.1)) < 0.003);
    simulate(gravity, 0.1, 1);
    const snapshot = gravity.snapshot();
    assert.ok(vectorValue(snapshot, 'left', 'Position')[0] > -1);
    assert.ok(vectorValue(snapshot, 'right', 'Position')[0] < 1);
    assert.ok(Math.abs(vectorValue(snapshot, 'left', 'Velocity')[0] + vectorValue(snapshot, 'right', 'Velocity')[0]) < 1e-8);
    assert.equal(scalarValue(snapshot, 'left', 'Mass'), 1);
    const particle = snapshot.entities.find(entity => entity.id === 'left')!;
    assert.ok(!particle.properties.some(property => property.label === 'Principal moments of inertia'));
  } finally {
    drag.dispose();
    gravity.dispose();
  }
});

test('world torque and body-local force points map into the correct angular motion', async () => {
  const torque = await createRuntime(freeSphereScene('World torque', [0, 0, 0], [
    { kind: 'torque', bodyId: 'body', vector: [0, 0, 1] },
  ]));
  const pointForce = validateScene({
    category: 'mechanics', title: 'Offset force', gravity: [0, 0, 0], ground: null,
    bodies: [{ id: 'body', label: 'Box', parentId: null, position: [0, 0, 0], shape: { kind: 'box', size: [1, 1, 1] }, mass: 2,
      motion: { kind: 'free', linearVelocity: [0, 0, 0], angularVelocity: [0, 0, 0] }, color: '#67d9ce' }],
    sites: [], tendons: [], connections: [], loads: [{ kind: 'force', bodyId: 'body', vector: [1, 0, 0], point: [0, 1, 0] }],
  });
  const offset = await createRuntime(pointForce);
  try {
    simulate(torque, 0.1, 1);
    assert.ok(Math.abs(vectorValue(torque.snapshot(), 'body', 'Angular velocity')[2] - 12.5) < 0.1);
    simulate(offset, 0.01, 1);
    const snapshot = offset.snapshot();
    assert.ok(vectorValue(snapshot, 'body', 'Velocity')[0] > 0);
    assert.ok(vectorValue(snapshot, 'body', 'Angular velocity')[2] < 0);
  } finally {
    torque.dispose();
    offset.dispose();
  }
});

test('cable reaction remains observable with many independent degrees of freedom', async () => {
  const model = atwood();
  for (let index = 0; index < 24; index++) model.bodies.push({
    id: `particle_${index}`, label: `Independent particle ${index}`, parentId: null, heldBy: null,
    position: [10 + index, 1, 0], orientation: [1, 0, 0, 0], shape: { kind: 'point' },
    mass: 1, motion: { kind: 'particle', linearVelocity: [0, 0, 0] },
    restitution: 0, friction: { sliding: 0, torsional: 0, rolling: 0, static: null }, color: '#67d9ce',
  });
  const runtime = await createRuntime(model);
  try {
    simulate(runtime, 1, 1);
    assert.ok(Math.abs(scalarValue(runtime.snapshot(), 'cord', 'Tension') - 13.08) < 0.05);
  } finally { runtime.dispose(); }
});

test('a slack cable has zero rendered tension and acquires native tension when its limit activates', async () => {
  const model = atwood();
  model.tendons[0]!.mode = 'rope';
  model.tendons[0]!.length = 7;
  const runtime = await createRuntime(model);
  try {
    simulate(runtime, 0.1, 1);
    const slackSnapshot = runtime.snapshot();
    const slack = runtime.frame().find(item => item.entityId === 'cord')!.tendon!;
    assert.equal(scalarValue(slackSnapshot, 'cord', 'Tension'), 0);
    assert.equal(slack.force, 0);
    assert.equal(slack.restLength, 7);
    assert.equal(slack.length, scalarValue(slackSnapshot, 'cord', 'Length'));
    assert.ok(slack.length < 7);
    simulate(runtime, 0.5, 1);
    const loadedSnapshot = runtime.snapshot();
    const loaded = runtime.frame().find(item => item.entityId === 'cord')!.tendon!;
    assert.ok(Math.abs(scalarValue(loadedSnapshot, 'cord', 'Tension') - 13.08) < 0.05);
    assert.equal(loaded.force, scalarValue(loadedSnapshot, 'cord', 'Tension'));
    assert.notEqual(loaded.force, null);
    assert.ok(Math.abs(scalarValue(loadedSnapshot, 'cord', 'Length') - 7) < 0.001);
  } finally { runtime.dispose(); }
});

test('articulated cards and drag use each body velocity, not the subtree reference velocity', async () => {
  const model = validateScene({
    category: 'mechanics', title: 'Rotating articulated pair', gravity: [0, 0, 0], ground: null,
    bodies: [
      { id: 'root', label: 'Root body', position: [0, 0, 0], shape: { kind: 'sphere', radius: 0.1 }, mass: 1,
        motion: { kind: 'free', linearVelocity: [0, 0, 0], angularVelocity: [0, 0, 1] } },
      { id: 'tip', label: 'Offset body', parentId: 'root', position: [1, 0, 0], shape: { kind: 'sphere', radius: 0.1 }, mass: 1,
        motion: { kind: 'hinge', axis: [0, 0, 1], anchor: [0, 0, 0] } },
    ],
    loads: [{ kind: 'drag', bodyId: 'tip', coefficient: 1, mediumVelocity: [0, 0, 0] }],
  });
  const runtime = await createRuntime(model);
  try {
    const initial = runtime.snapshot();
    assert.deepEqual(vectorValue(initial, 'root', 'Velocity'), [0, 0, 0]);
    assert.deepEqual(vectorValue(initial, 'tip', 'Velocity'), [0, 1, 0]);
    runtime.advance(0.001, 1);
    const current = runtime.snapshot();
    const momentum = vectorValue(current, 'root', 'Velocity')[1] + vectorValue(current, 'tip', 'Velocity')[1];
    assert.ok(Math.abs(momentum - 0.999) < 1e-5);
  } finally { runtime.dispose(); }
});

test('a point-particle inspection does not invent rotational state', async () => {
  const model = projectile();
  model.bodies[0].shape = { kind: 'point' };
  model.bodies[0].motion = { kind: 'particle', linearVelocity: [5, 0, 0] };
  const runtime = await createRuntime(model);
  try {
    const properties = runtime.snapshot().entities[0].properties;
    assert.ok(!properties.some(property => property.unit === 'kg·m²' || property.unit === 'rad/s'));
    assert.ok(!properties.some(property => Array.isArray(property.value) && property.value.length === 4));
  } finally { runtime.dispose(); }
});

test('a cable leaving its guide renders reusable current paths with native wrap-edge flags', async () => {
  const runtime = await createRuntime(changingWrap());
  try {
    const item = runtime.frame().find(item => item.entityId === 'spring')!;
    const initial = item.points!;
    const wrapped = item.tendon!.wrapped;
    assert.ok(initial.length > 2);
    assert.equal(wrapped.length, initial.length - 1);
    assert.ok(wrapped.some(Boolean));
    for (let edge = 0; edge < wrapped.length; edge++) if (wrapped[edge]) {
      for (const pointIndex of [edge, edge + 1]) {
        assert.ok(Math.abs(Math.hypot(...initial[pointIndex]!) - 0.5) < 1e-8);
        const a = initial[edge]!;
        const b = initial[edge + 1]!;
        assert.ok(Math.hypot((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2) > 0.495);
      }
    }
    simulate(runtime, 2, 1);
    const current = runtime.frame().find(candidate => candidate.entityId === 'spring')!;
    const points = current.points!;
    const endpoint = vectorValue(runtime.snapshot(), 'load', 'Position');
    assert.equal(points, initial);
    assert.equal(current.tendon!.wrapped, wrapped);
    assert.equal(wrapped.length, points.length - 1);
    assert.ok(wrapped.every(flag => !flag));
    assert.deepEqual(points[0], [-2, 0, 0]);
    assert.deepEqual(points.at(-1), endpoint);
    let drawnLength = 0;
    for (let index = 1; index < points.length; index++) {
      drawnLength += Math.hypot(...points[index]!.map((value, axis) => value - points[index - 1]![axis]!));
    }
    assert.ok(Math.abs(drawnLength - scalarValue(runtime.snapshot(), 'spring', 'Length')) < 1e-8);
  } finally { runtime.dispose(); }
});

test('a translated rotated cylinder wrap renders on its native world-space surface', async () => {
  const center = [0.5, 0.25, 0.1];
  const runtime = await createRuntime(validateScene({
    category: 'mechanics', title: 'Rotated cylinder wrap', gravity: [0, 0, 0], ground: null,
    bodies: [
      { id: 'guide', label: 'Rotated cylinder', position: center, orientation: [Math.SQRT1_2, Math.SQRT1_2, 0, 0],
        shape: { kind: 'cylinder', radius: 0.5, length: 1 }, mass: null, motion: { kind: 'fixed' } },
      { id: 'load', label: 'Endpoint', position: [2.5, 0.25, 0.1], shape: { kind: 'sphere', radius: 0.05 }, mass: 1,
        motion: { kind: 'free', linearVelocity: [0, 0, 0], angularVelocity: [0, 0, 0] } },
    ],
    sites: [
      { id: 'left', label: 'Left end', bodyId: null, position: [-1.5, 0.25, 0.1] },
      { id: 'right', label: 'Right end', bodyId: 'load', position: [0, 0, 0] },
      { id: 'side', label: 'Wrap side', bodyId: null, position: [0.5, 0.25, 1.1] },
    ],
    tendons: [{
      id: 'cord', label: 'Wrapped cord', mode: 'spring', length: 5, stiffness: 1, damping: 0,
      path: [{ kind: 'site', siteId: 'left' }, { kind: 'wrap', bodyId: 'guide', sideSiteId: 'side' },
        { kind: 'site', siteId: 'right' }],
    }],
  }));
  try {
    const item = runtime.frame().find(candidate => candidate.entityId === 'cord')!;
    const points = item.points!;
    const wrapped = item.tendon!.wrapped;
    assert.equal(wrapped.length, points.length - 1);
    assert.ok(wrapped.some(Boolean));
    assert.deepEqual(points[0], [-1.5, 0.25, 0.1]);
    assert.deepEqual(points.at(-1), [2.5, 0.25, 0.1]);
    for (let edge = 0; edge < wrapped.length; edge++) if (wrapped[edge]) {
      for (const pointIndex of [edge, edge + 1]) {
        const point = points[pointIndex]!;
        assert.ok(point.every(Number.isFinite));
        assert.ok(Math.abs(Math.hypot(point[0] - center[0]!, point[2] - center[2]!) - 0.5) < 1e-8);
        const a = points[edge]!;
        const b = points[edge + 1]!;
        assert.ok(Math.hypot((a[0] + b[0]) / 2 - center[0]!, (a[2] + b[2]) / 2 - center[2]!) > 0.495);
      }
    }
  } finally { runtime.dispose(); }
});
