import assert from 'node:assert/strict';
import test from 'node:test';
import { validateScene } from '../shared/scene.ts';
import type { Scene, Vec3 } from '../shared/scene.ts';
import { createRuntime } from '../src/physics/mujoco.ts';
import type { InspectionSnapshot, MechanicsRuntime } from '../src/physics/types.ts';

type Friction = { sliding: number; static: number | null; torsional: number; rolling: number };
const frictionless: Friction = { sliding: 0, static: null, torsional: 0, rolling: 0 };
const frictional: Friction = { sliding: 0.5, static: 0.8, torsional: 0, rolling: 0 };
const ids = ['carrier', 'round1', 'round2', 'round3'];

function sphere(id: string, position: Vec3, mass: number | null, options: {
  heldBy?: string | null; velocity?: Vec3; angular?: Vec3; orientation?: [number, number, number, number];
  friction?: Friction;
} = {}) {
  const fixed = mass === null;
  return {
    id, label: id, parentId: null, heldBy: options.heldBy ?? null, position,
    orientation: options.orientation ?? [1, 0, 0, 0],
    shape: { kind: 'sphere', radius: id === 'carrier' ? 0.3 : 0.1 }, mass,
    motion: fixed ? { kind: 'fixed' } : {
      kind: 'free', linearVelocity: options.velocity ?? [0, 0, 0], angularVelocity: options.angular ?? [0, 0, 0],
    },
    restitution: 0, friction: options.friction ?? frictionless, color: '#67d9ce',
  };
}

function scene(
  bodies: unknown[],
  events: unknown[] = [],
  gravity: Vec3 = [0, 0, 0],
  ground: Scene['ground'] = null,
  loads: unknown[] = [],
): Scene {
  return validateScene({ category: 'mechanics', title: 'Scheduled actions', bodies, events, gravity, ground,
    sites: [], tendons: [], connections: [], loads });
}

function shots(): Scene {
  return scene([
    sphere('carrier', [0, 0, 0], 100),
    sphere('round1', [1, 0, 0], 10, { heldBy: 'carrier' }),
    sphere('round2', [2, 0, 0], 10, { heldBy: 'carrier' }),
    sphere('round3', [3, 0, 0], 10, { heldBy: 'carrier' }),
  ], [0, 1, 2].map(index => ({ id: `fire${index + 1}`, label: `Fire round ${index + 1}`, at: index * 10,
    action: { kind: 'launch', bodyId: `round${index + 1}`, velocity: [2, 0, 0], frame: 'body' } })));
}

function value(snapshot: InspectionSnapshot, bodyId: string, label: string): number | string | number[] {
  const property = snapshot.entities.find(entity => entity.id === bodyId)?.properties.find(item => item.label === label);
  assert.ok(property, `missing ${label} for ${bodyId}`);
  return property.value;
}

function vector(snapshot: InspectionSnapshot, bodyId: string, label: string): number[] {
  const result = value(snapshot, bodyId, label);
  assert.ok(Array.isArray(result), `${label} for ${bodyId} must be a vector`);
  return result;
}

function scalar(snapshot: InspectionSnapshot, bodyId: string, label: string): number {
  const result = value(snapshot, bodyId, label);
  assert.equal(typeof result, 'number', `${label} for ${bodyId} must be numeric`);
  return result as number;
}

function totalMomentum(snapshot: InspectionSnapshot, bodyIds: string[]): Vec3 {
  const total: Vec3 = [0, 0, 0];
  for (const id of bodyIds) {
    const momentum = vector(snapshot, id, 'Linear momentum');
    for (let axis = 0; axis < 3; axis++) total[axis] += momentum[axis];
  }
  return total;
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function totalAngularMomentum(snapshot: InspectionSnapshot, bodyIds: string[], radii: Record<string, number>): Vec3 {
  const total: Vec3 = [0, 0, 0];
  for (const id of bodyIds) {
    const orbital = cross(vector(snapshot, id, 'Position') as Vec3, vector(snapshot, id, 'Linear momentum') as Vec3);
    const omega = vector(snapshot, id, 'Angular velocity');
    const inertia = 0.4 * scalar(snapshot, id, 'Mass') * radii[id] ** 2;
    for (let axis = 0; axis < 3; axis++) total[axis] += orbital[axis] + inertia * omega[axis];
  }
  return total;
}

function nearVector(actual: number[], expected: number[], tolerance: number, message: string): void {
  for (let axis = 0; axis < 3; axis++) assert.ok(Math.abs(actual[axis] - expected[axis]) <= tolerance,
    `${message}[${axis}]: expected ${expected[axis]}, got ${actual[axis]}`);
}

function advanceTo(runtime: MechanicsRuntime, target: number, speed = 1): void {
  let calls = 0;
  while (runtime.time < target - 1e-10) {
    const wallSeconds = Math.min(0.25, 0.5 / speed, (target - runtime.time) / speed);
    const result = runtime.advance(wallSeconds, speed);
    assert.equal(result.pauseReason, null);
    assert.ok(result.steps > 0, 'the fixed-step clock should advance toward the requested time');
    if (++calls > 2000) throw new Error('simulation did not reach the requested time');
  }
}

test('events publish at their reached boundary, never early, including fractional-step times', async () => {
  const runtime = await createRuntime(scene([
    { id: 'point', label: 'Point', position: [0, 0, 0], shape: { kind: 'point' }, mass: 2, motion: { kind: 'particle' } },
  ], [
    { id: 'start', label: 'Initial push', at: 0, action: { kind: 'impulse', bodyId: 'point', linear: [-2, 0, 0] } },
    { id: 'tiny', label: 'Positive delay', at: 1e-13, action: { kind: 'impulse', bodyId: 'point', linear: [0, 0, 2] } },
    { id: 'fractional', label: 'Fractional delay', at: 0.0003, action: { kind: 'impulse', bodyId: 'point', linear: [2, 0, 0] } },
    { id: 'boundary', label: 'Boundary push', at: 0.001, action: { kind: 'impulse', bodyId: 'point', linear: [0, 4, 0] } },
  ]));
  try {
    assert.ok(runtime.snapshot().events?.every(event => event.status === 'pending'));
    advanceTo(runtime, 0.001);
    assert.deepEqual(runtime.snapshot().events?.map(event => event.firedAt), [0, 0.001, 0.001, 0.001]);
    nearVector(vector(runtime.snapshot(), 'point', 'Velocity'), [0, 2, 1], 1e-12, 'boundary impulses');
    nearVector(vector(runtime.snapshot(), 'point', 'Position'), [-0.001, 0, 0], 1e-12, 'no early positive-time impulses');
    advanceTo(runtime, 0.002);
    nearVector(vector(runtime.snapshot(), 'point', 'Position'), [-0.001, 0.002, 0.001], 1e-12, 'no repeated boundary impulses');
  } finally { runtime.dispose(); }
});

test('three scheduled 10 kg rounds fire once at 0, 10 and 20 s with recoil, remaining mass, reset and speed-independent replay', async () => {
  const runtime = await createRuntime(shots());
  try {
    const initial = runtime.snapshot();
    assert.deepEqual(initial.events?.map(event => [event.status, event.firedAt]), [
      ['pending', null], ['pending', null], ['pending', null],
    ]);
    assert.equal(runtime.frame().find(item => item.entityId === 'round1')?.visible, false);
    assert.equal(value(initial, 'round1', 'Activity'), 'Waiting for launch');
    nearVector(totalMomentum(initial, ids), [0, 0, 0], 1e-12, 'initial loaded momentum');
    assert.equal(scalar(initial, 'carrier', 'Mass') + scalar(initial, 'round1', 'Mass')
      + scalar(initial, 'round2', 'Mass') + scalar(initial, 'round3', 'Mass'), 130);
    assert.equal(scalar(initial, 'carrier', 'Loaded mass'), 130);
    assert.equal(scalar(initial, 'carrier', 'Carried objects'), 3);

    advanceTo(runtime, 0.001);
    let snapshot = runtime.snapshot();
    assert.deepEqual(snapshot.events?.map(event => event.status), ['completed', 'pending', 'pending']);
    assert.equal(snapshot.events?.[0].firedAt, 0);
    assert.notEqual(runtime.frame().find(item => item.entityId === 'round1')?.visible, false);
    assert.equal(runtime.frame().find(item => item.entityId === 'round2')?.visible, false);
    assert.equal(scalar(snapshot, 'carrier', 'Mass') + scalar(snapshot, 'round2', 'Mass') + scalar(snapshot, 'round3', 'Mass'), 120);
    assert.equal(scalar(snapshot, 'carrier', 'Loaded mass'), 120);
    assert.ok(Math.abs(vector(snapshot, 'round1', 'Velocity')[0] - vector(snapshot, 'carrier', 'Velocity')[0] - 2) < 1e-8);
    nearVector(totalMomentum(snapshot, ids), [0, 0, 0], 1e-8, 'momentum after first shot');

    advanceTo(runtime, 9.999);
    assert.deepEqual(runtime.snapshot().events?.map(event => event.status), ['completed', 'pending', 'pending']);
    advanceTo(runtime, 10.001);
    snapshot = runtime.snapshot();
    assert.deepEqual(snapshot.events?.map(event => event.status), ['completed', 'completed', 'pending']);
    assert.ok(Math.abs(snapshot.events![1].firedAt! - 10) < 1e-9);
    assert.ok(Math.abs(vector(snapshot, 'round2', 'Velocity')[0] - vector(snapshot, 'carrier', 'Velocity')[0] - 2) < 1e-8);
    advanceTo(runtime, 19.999);
    assert.deepEqual(runtime.snapshot().events?.map(event => event.status), ['completed', 'completed', 'pending']);
    advanceTo(runtime, 20.001);
    const final = runtime.snapshot();
    assert.deepEqual(final.events?.map(event => event.status), ['completed', 'completed', 'completed']);
    assert.ok(Math.abs(final.events![2].firedAt! - 20) < 1e-9);
    nearVector(totalMomentum(final, ids), [0, 0, 0], 1e-8, 'momentum after all shots');
    assert.equal(scalar(final, 'carrier', 'Loaded mass'), 100);
    assert.equal(scalar(final, 'carrier', 'Carried objects'), 0);

    runtime.reset();
    assert.deepEqual(runtime.snapshot(), initial);
    assert.equal(runtime.frame().find(item => item.entityId === 'round1')?.visible, false);
    advanceTo(runtime, 20.001, 10);
    assert.deepEqual(runtime.snapshot(), final);
  } finally {
    runtime.dispose();
  }
});

test('moving rotated carriers preserve loaded momentum and angular momentum; body axes belong to the carrier and world targets are absolute', async () => {
  const orientation: [number, number, number, number] = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];
  const build = (frame: 'body' | 'world', velocity: Vec3) => scene([
    sphere('carrier', [0, 0, 0], 100, { orientation, velocity: [0.5, -0.25, 0.1], angular: [0, 0, 0.2] }),
    sphere('round1', [1, 0, 0], 10, { heldBy: 'carrier' }),
    sphere('round2', [2, 0, 0], 10, { heldBy: 'carrier' }),
  ], [{ id: 'launch', label: 'Launch', at: 0, action: { kind: 'launch', bodyId: 'round1', velocity, frame } }]);
  const radii = { carrier: 0.3, round1: 0.1, round2: 0.1 };
  // The remaining 100 kg carrier and 10 kg round recoil about their shared center of mass.
  const center = 20 / 110;
  const remainingInertia = 0.4 * 100 * 0.3 ** 2 + 0.4 * 10 * 0.1 ** 2 + 100 * center ** 2 + 10 * (2 - center) ** 2;
  const impulse = 2 / (1 / 10 + 1 / 110 + (1 - center) ** 2 / remainingInertia);
  const cases: ['body' | 'world', Vec3, Vec3][] = [
    ['body', [2, 0, 0], [0.5, -0.05 + impulse / 10, 0.1]],
    ['world', [4, -1, 0.5], [4, -1, 0.5]],
  ];
  for (const [frame, command, expected] of cases) {
    const runtime = await createRuntime(build(frame, command));
    try {
      const initial = runtime.snapshot();
      nearVector(totalMomentum(initial, ['carrier', 'round1', 'round2']), [60, -24, 12], 1e-8, 'initial loaded momentum');
      advanceTo(runtime, 0.001);
      const after = runtime.snapshot();
      nearVector(vector(after, 'round1', 'Velocity') as Vec3, expected, 1e-8, `${frame}-frame target velocity`);
      nearVector(totalMomentum(after, ['carrier', 'round1', 'round2']), [60, -24, 12], 1e-7, `${frame}-frame momentum`);
      nearVector(totalAngularMomentum(after, ['carrier', 'round1', 'round2'], radii),
        totalAngularMomentum(initial, ['carrier', 'round1', 'round2'], radii), 1e-6, `${frame}-frame angular momentum`);
    } finally {
      runtime.dispose();
    }
  }
});
test('release preserves the carried point velocity and inherited spin', async () => {
  const runtime = await createRuntime(scene([
    sphere('carrier', [0, 0, 0], 20, { velocity: [0.5, -0.2, 0], angular: [0, 0, 0.3] }),
    sphere('payload', [1, 0, 0], 10, { heldBy: 'carrier' }),
  ], [{ id: 'release', label: 'Release', at: 0, action: { kind: 'release', bodyId: 'payload' } }]));
  try {
    const initial = runtime.snapshot();
    const momentum = totalMomentum(initial, ['carrier', 'payload']);
    advanceTo(runtime, 0.001);
    const released = runtime.snapshot();
    nearVector(vector(released, 'payload', 'Velocity') as Vec3, [0.5, 0.1, 0], 1e-9, 'released carried velocity');
    nearVector(vector(released, 'payload', 'Angular velocity') as Vec3, [0, 0, 0.3], 1e-9, 'released carried spin');
    nearVector(totalMomentum(released, ['carrier', 'payload']), momentum, 1e-9, 'release momentum');
    assert.notEqual(runtime.frame().find(item => item.entityId === 'payload')?.visible, false);
  } finally {
    runtime.dispose();
  }
});
test('a fixed carrier supplies launch reaction and body-frame speed follows its axes', async () => {
  const runtime = await createRuntime(scene([
    sphere('carrier', [0, 0, 0], null, { orientation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2] }),
    sphere('payload', [1, 0, 0], 10, { heldBy: 'carrier' }),
  ], [{ id: 'launch', label: 'Launch', at: 0,
    action: { kind: 'launch', bodyId: 'payload', velocity: [2, 0, 0], frame: 'body' } }]));
  try {
    advanceTo(runtime, 0.001);
    const snapshot = runtime.snapshot();
    nearVector(vector(snapshot, 'carrier', 'Velocity') as Vec3, [0, 0, 0], 1e-12, 'fixed carrier velocity');
    nearVector(vector(snapshot, 'payload', 'Velocity') as Vec3, [0, 2, 0], 1e-9, 'fixed carrier local launch');
  } finally {
    runtime.dispose();
  }
});



test('scheduled carrier impulses include carried mass and angular momentum', async () => {
  const impulse: Vec3 = [5, 2, -1];
  const spinImpulse: Vec3 = [0.2, -0.1, 0.7];
  const runtime = await createRuntime(scene([
    sphere('carrier', [0, 1, 0], 20, { velocity: [0.5, 0, 0] }),
    sphere('round1', [1, 1, 0], 10, { heldBy: 'carrier' }),
    sphere('round2', [2, 1, 0], 10, { heldBy: 'carrier' }),
  ], [{ id: 'push', label: 'Timed push', at: 0,
    action: { kind: 'impulse', bodyId: 'carrier', linear: impulse, angular: spinImpulse } }]));
  try {
    const before = runtime.snapshot();
    const initialMomentum = totalMomentum(before, ['carrier', 'round1', 'round2']);
    const initialAngular = totalAngularMomentum(before, ['carrier', 'round1', 'round2'], { carrier: 0.3, round1: 0.1, round2: 0.1 });
    advanceTo(runtime, 0.001);
    const after = runtime.snapshot();
    nearVector(totalMomentum(after, ['carrier', 'round1', 'round2']),
      [initialMomentum[0] + impulse[0], initialMomentum[1] + impulse[1], initialMomentum[2] + impulse[2]], 1e-7, 'cluster impulse momentum');
    const orbital = cross([0, 1, 0], impulse);
    nearVector(totalAngularMomentum(after, ['carrier', 'round1', 'round2'], { carrier: 0.3, round1: 0.1, round2: 0.1 }),
      [initialAngular[0] + orbital[0] + spinImpulse[0], initialAngular[1] + orbital[1] + spinImpulse[1], initialAngular[2] + orbital[2] + spinImpulse[2]],
      1e-6, 'cluster impulse angular momentum');
  } finally {
    runtime.dispose();
  }
});

test('held overlapping bodies have no contacts or visibility until release, then regain explicit material collisions', async () => {
  const runtime = await createRuntime(scene([
    sphere('carrier', [0, 0, 0], null, { friction: frictional }),
    sphere('payload', [0.39, 0, 0], 1, { heldBy: 'carrier', friction: frictional }),
  ], [{ id: 'release', label: 'Release', at: 0.002, action: { kind: 'release', bodyId: 'payload' } }]));
  try {
    const initial = runtime.snapshot();
    assert.equal(runtime.frame().find(item => item.entityId === 'payload')?.visible, false);
    assert.equal(value(initial, 'payload', 'Activity'), 'Waiting for release');
    assert.deepEqual(vector(initial, 'payload', 'Contact force'), [0, 0, 0]);
    advanceTo(runtime, 0.001);
    assert.equal(runtime.snapshot().events?.[0].status, 'pending');
    assert.equal(runtime.frame().find(item => item.entityId === 'payload')?.visible, false);
    advanceTo(runtime, 0.003);
    const released = runtime.snapshot();
    assert.equal(released.events?.[0].status, 'completed');
    assert.notEqual(runtime.frame().find(item => item.entityId === 'payload')?.visible, false);
    assert.ok(Math.hypot(...vector(released, 'payload', 'Velocity')) > 0.01, 'the newly active overlap must resolve as a native contact');
  } finally {
    runtime.dispose();
  }
});

test('load toggles take effect at their boundaries, preserve continuous force between events, and replay on Reset', async () => {
  const model = scene([sphere('body', [0, 0, 0], 1)], [
    { id: 'off', label: 'Pause force', at: 0.01, action: { kind: 'load', loadIndex: 0, enabled: false } },
    { id: 'on', label: 'Resume force', at: 0.02, action: { kind: 'load', loadIndex: 0, enabled: true } },
  ], [0, 0, 0], null, [{ kind: 'force', bodyId: 'body', vector: [10, 0, 0], point: null }]);
  const runtime = await createRuntime(model);
  try {
    const initial = runtime.snapshot();
    advanceTo(runtime, 0.009);
    const beforeOff = runtime.snapshot();
    assert.deepEqual(beforeOff.events?.map(event => event.status), ['pending', 'pending']);
    const v9 = vector(beforeOff, 'body', 'Velocity')[0];
    advanceTo(runtime, 0.011);
    const off = runtime.snapshot();
    assert.equal(off.events?.[0].status, 'completed');
    assert.equal(value(off, 'body', 'Load state'), 'Disabled');
    assert.ok(Math.abs(vector(off, 'body', 'Velocity')[0] - v9 - 0.01) < 1e-8);
    advanceTo(runtime, 0.021);
    const on = runtime.snapshot();
    assert.equal(on.events?.[1].status, 'completed');
    assert.equal(value(on, 'body', 'Load state'), 'Enabled');
    assert.ok(Math.abs(vector(on, 'body', 'Velocity')[0] - vector(off, 'body', 'Velocity')[0] - 0.01) < 1e-8);
    runtime.reset();
    assert.deepEqual(runtime.snapshot(), initial);
    assert.equal(value(runtime.snapshot(), 'body', 'Load state'), 'Enabled');
  } finally {
    runtime.dispose();
  }
});

test('same-time continuous-load toggles follow event input order', async () => {
  const make = (enabled: boolean[]) => scene([sphere('body', [0, 0, 0], 1)], enabled.map((value, index) => ({
    id: `toggle${index}`, label: `Toggle ${index}`, at: 0, action: { kind: 'load', loadIndex: 0, enabled: value },
  })), [0, 0, 0], null, [{ kind: 'force', bodyId: 'body', vector: [10, 0, 0], point: null }]);
  const on = await createRuntime(make([false, true]));
  const off = await createRuntime(make([true, false]));
  try {
    advanceTo(on, 0.001);
    advanceTo(off, 0.001);
    assert.equal(value(on.snapshot(), 'body', 'Load state'), 'Enabled');
    assert.equal(value(off.snapshot(), 'body', 'Load state'), 'Disabled');
    assert.ok(vector(on.snapshot(), 'body', 'Velocity')[0] > 0.009);
    assert.ok(Math.abs(vector(off.snapshot(), 'body', 'Velocity')[0]) < 1e-12);
  } finally {
    on.dispose();
    off.dispose();
  }
});

test('surface friction continues between scheduled impulses', async () => {
  const runtime = await createRuntime(validateScene({
    category: 'mechanics', title: 'Friction between actions', gravity: [0, 0, -9.81],
    bodies: [sphere('runner', [0, 0, 0.1], 1, { friction: frictional })],
    ground: { height: 0, restitution: 0, friction: frictional }, sites: [], tendons: [], connections: [], loads: [],
    events: [
      { id: 'start', label: 'First impulse', at: 0, action: { kind: 'impulse', bodyId: 'runner', linear: [2, 0, 0] } },
      { id: 'later', label: 'Second impulse', at: 0.1, action: { kind: 'impulse', bodyId: 'runner', linear: [1, 0, 0] } },
    ],
  }));
  try {
    advanceTo(runtime, 0.001);
    const initialSpeed = vector(runtime.snapshot(), 'runner', 'Velocity')[0];
    advanceTo(runtime, 0.05);
    const betweenShots = runtime.snapshot();
    const reducedSpeed = vector(betweenShots, 'runner', 'Velocity')[0];
    assert.ok(reducedSpeed < initialSpeed - 0.1, 'kinetic contact friction must remain active between actions');
    assert.equal(betweenShots.events?.[1].status, 'pending');
    advanceTo(runtime, 0.101);
    assert.equal(runtime.snapshot().events?.[1].status, 'completed');
    assert.ok(vector(runtime.snapshot(), 'runner', 'Velocity')[0] > reducedSpeed + 0.7, 'the later impulse must still apply once');
  } finally {
    runtime.dispose();
  }
});
