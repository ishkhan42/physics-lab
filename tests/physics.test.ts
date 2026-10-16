import assert from 'node:assert/strict';
import test from 'node:test';
import { validateScene } from '../shared/scene.ts';
import { createRuntime } from '../src/physics/mujoco.ts';
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

test('routed Atwood cable has the measured acceleration and Jacobian-signed tension', async () => {
  const runtime = await createRuntime(atwood());
  try {
    simulate(runtime, 1, 1);
    const snapshot = runtime.snapshot();
    assert.ok(Math.abs(vectorValue(snapshot, 'light', 'Position')[2] - 1.635) < 0.002);
    assert.ok(Math.abs(vectorValue(snapshot, 'heavy', 'Position')[2] + 1.635) < 0.002);
    assert.ok(Math.abs(scalarValue(snapshot, 'cord', 'Tension') - 13.08) < 0.05);
  } finally {
    runtime.dispose();
  }
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
    id: `particle_${index}`, label: `Independent particle ${index}`, parentId: null,
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

test('a slack cable has zero tension and acquires tension when its limit activates', async () => {
  const model = atwood();
  model.tendons[0].mode = 'rope';
  model.tendons[0].length = 7;
  const runtime = await createRuntime(model);
  try {
    simulate(runtime, 0.1, 1);
    assert.equal(scalarValue(runtime.snapshot(), 'cord', 'Tension'), 0);
    assert.ok(scalarValue(runtime.snapshot(), 'cord', 'Length') < 7);
    simulate(runtime, 0.5, 1);
    assert.ok(Math.abs(scalarValue(runtime.snapshot(), 'cord', 'Tension') - 13.08) < 0.05);
    assert.ok(Math.abs(scalarValue(runtime.snapshot(), 'cord', 'Length') - 7) < 0.001);
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

test('a cable leaving its guide renders only current physical path points', async () => {
  const runtime = await createRuntime(changingWrap());
  try {
    const initial = runtime.frame().find(item => item.entityId === 'spring')!.points!;
    assert.ok(initial.length > 2);
    for (const point of initial.slice(1, -1)) assert.ok(Math.abs(Math.hypot(...point) - 0.5) < 1e-8);
    simulate(runtime, 2, 1);
    const points = runtime.frame().find(item => item.entityId === 'spring')!.points!;
    const endpoint = vectorValue(runtime.snapshot(), 'load', 'Position');
    assert.deepEqual(points[0], [-2, 0, 0]);
    assert.deepEqual(points.at(-1), endpoint);
    let drawnLength = 0;
    for (let index = 1; index < points.length; index++) {
      drawnLength += Math.hypot(...points[index].map((value, axis) => value - points[index - 1][axis]));
    }
    assert.ok(Math.abs(drawnLength - scalarValue(runtime.snapshot(), 'spring', 'Length')) < 1e-8);
  } finally { runtime.dispose(); }
});
