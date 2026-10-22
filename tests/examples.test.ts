import assert from 'node:assert/strict';
import test from 'node:test';
import { EXPERIMENT_EXAMPLES } from '../shared/examples.ts';
import { createRuntime } from '../src/physics/mujoco.ts';
import type { InspectionSnapshot, MechanicsRuntime } from '../src/physics/types.ts';

function exampleScene(groupId: string, setupId: string) {
  const setup = EXPERIMENT_EXAMPLES.find(group => group.id === groupId)?.setups.find(item => item.id === setupId);
  assert.ok(setup, `missing example ${groupId}/${setupId}`);
  return setup.document.scene;
}

function vector(snapshot: InspectionSnapshot, entityId: string, label = 'Position'): number[] {
  const property = snapshot.entities.find(entity => entity.id === entityId)?.properties.find(item => item.label === label);
  assert.ok(property && Array.isArray(property.value), `missing ${label} vector for ${entityId}`);
  return property.value;
}


function angleFromDown(pivot: number[], bob: number[]): number {
  return Math.atan2(bob[0] - pivot[0], pivot[2] - bob[2]) * 180 / Math.PI;
}

function distance(a: number[], b: number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function mechanicalEnergy(runtime: MechanicsRuntime, snapshot: InspectionSnapshot, bodyId: string): number {
  const body = runtime.scene.bodies.find(item => item.id === bodyId);
  assert.ok(body?.mass);
  const velocity = vector(snapshot, bodyId, 'Velocity');
  const position = vector(snapshot, bodyId);
  return 0.5 * body.mass * velocity.reduce((sum, component) => sum + component * component, 0)
    - body.mass * runtime.scene.gravity.reduce((sum, component, axis) => sum + component * position[axis], 0);
}

function tendonForce(runtime: MechanicsRuntime, id: string): number {
  const force = runtime.frame().find(item => item.entityId === id && item.tendon)?.tendon?.force;
  assert.ok(typeof force === 'number' && Number.isFinite(force));
  return force;
}

function tiltFromVertical(runtime: MechanicsRuntime, id: string): number {
  const item = runtime.frame().find(frame => frame.entityId === id && frame.shape.kind === 'box');
  assert.ok(item);
  const [x, y] = item.quaternion;
  return Math.acos(Math.max(-1, Math.min(1, 1 - 2 * (x * x + y * y))));
}

function advanceTo(runtime: MechanicsRuntime, target: number): void {
  while (runtime.time < target - 1e-10) {
    const before = runtime.time;
    const result = runtime.advance(Math.min(0.25, target - runtime.time), 1);
    assert.equal(result.pauseReason, null);
    assert.ok(runtime.time > before);
  }
}

test('corrected double pendulums retain their absolute angles and moving lower pivots', async () => {
  const runtime = await createRuntime(exampleScene('sensitive-pendulums', '120-vs-125-deg'));
  try {
    const initial = runtime.snapshot();
    assert.ok(Math.abs(angleFromDown(vector(initial, 'pivotA'), vector(initial, 'Aupper')) - 120) < 1e-6);
    assert.ok(Math.abs(angleFromDown(vector(initial, 'Aupper'), vector(initial, 'Alower')) + 10) < 1e-6);
    assert.ok(Math.abs(angleFromDown(vector(initial, 'pivotB'), vector(initial, 'Bupper')) - 125) < 1e-6);
    assert.ok(Math.abs(angleFromDown(vector(initial, 'Bupper'), vector(initial, 'Blower')) + 10) < 1e-6);
    assert.ok(Math.abs(angleFromDown(vector(initial, 'pivotB'), vector(initial, 'Bupper'))
      - angleFromDown(vector(initial, 'pivotA'), vector(initial, 'Aupper')) - 5) < 1e-6);

    advanceTo(runtime, 0.5);
    const moved = runtime.snapshot();
    assert.ok(distance(vector(moved, 'Aupper'), vector(initial, 'Aupper')) > 0.05);
    assert.ok(Math.abs(distance(vector(moved, 'Aupper'), vector(moved, 'Alower')) - 1) < 1e-3);
    assert.ok(Math.abs(distance(vector(moved, 'Bupper'), vector(moved, 'Blower')) - 1) < 1e-3);
    advanceTo(runtime, 4);
    const separated = runtime.snapshot();
    const lowerA = vector(separated, 'Alower'), lowerB = vector(separated, 'Blower');
    assert.ok(Math.hypot(lowerA[0] - lowerB[0], lowerA[2] - lowerB[2]) > 0.5);
  } finally {
    runtime.dispose();
  }
});


test('the spring net releases its load on schedule, stretches under impact and returns energy to the ball', async () => {
  const runtime = await createRuntime(exampleScene('spring-net', 'drop-and-rebound'));
  try {
    assert.equal(runtime.snapshot().events?.[0].status, 'pending');
    advanceTo(runtime, 1.199);
    assert.equal(runtime.snapshot().events?.[0].status, 'pending');
    assert.ok(Math.abs(vector(runtime.snapshot(), 'impact-ball')[2] - 3.25) < 1e-3);
    const beforeForce = tendonForce(runtime, 'spring-2-2-2-3');
    advanceTo(runtime, 1.21);
    assert.equal(runtime.snapshot().events?.[0].status, 'completed');
    assert.ok(Math.abs(runtime.snapshot().events![0].firedAt! - 1.2) < 1e-9);
    assert.ok(vector(runtime.snapshot(), 'impact-ball', 'Velocity')[2] < 0);
    advanceTo(runtime, 2);
    assert.ok(vector(runtime.snapshot(), 'node-2-2')[2] < 1.3);
    assert.ok(tendonForce(runtime, 'spring-2-2-2-3') > beforeForce + 1);
    assert.ok(vector(runtime.snapshot(), 'impact-ball', 'Velocity')[2] > 1);
    advanceTo(runtime, 2.5);
    assert.ok(vector(runtime.snapshot(), 'impact-ball')[2] > 2.7);
  } finally { runtime.dispose(); }
});

test('equal-speed beads retain or lose mechanical energy through normal impacts even with zero friction', async () => {
  const runtime = await createRuntime(exampleScene('loop-the-loop', 'elastic-and-inelastic'));
  try {
    const initial = runtime.snapshot();
    const initialEnergy = mechanicalEnergy(runtime, initial, 'elastic-bead');
    assert.ok(Math.abs(initialEnergy - mechanicalEnergy(runtime, initial, 'inelastic-bead')) < 1e-9);
    advanceTo(runtime, 4);
    const final = runtime.snapshot();
    assert.ok(mechanicalEnergy(runtime, final, 'elastic-bead') > initialEnergy * 0.9);
    assert.ok(mechanicalEnergy(runtime, final, 'inelastic-bead') < initialEnergy * 0.3);
  } finally { runtime.dispose(); }
});

test('three-body choreography moves freely and nearly closes one orbit without center-of-mass drift', async () => {
  const runtime = await createRuntime(exampleScene('three-body-figure-eight', 'native-mutual-gravity'));
  try {
    const ids = ['blue-mass', 'orange-mass', 'teal-mass'];
    const initial = runtime.snapshot();
    advanceTo(runtime, 1);
    assert.ok(distance(vector(runtime.snapshot(), ids[0]), vector(initial, ids[0])) > 0.2);
    advanceTo(runtime, 6.326);
    const final = runtime.snapshot();
    for (const id of ids) assert.ok(distance(vector(final, id), vector(initial, id)) < 0.01);
    for (let axis = 0; axis < 3; axis++) {
      const initialCenter = ids.reduce((sum, id) => sum + vector(initial, id)[axis], 0) / ids.length;
      const finalCenter = ids.reduce((sum, id) => sum + vector(final, id)[axis], 0) / ids.length;
      assert.ok(Math.abs(finalCenter - initialCenter) < 1e-6);
    }
  } finally { runtime.dispose(); }
});

test('the domino cascade reaches the far end after an initially undisturbed interval', async () => {
  const runtime = await createRuntime(exampleScene('domino-arc', 'twenty-domino-arc'));
  try {
    advanceTo(runtime, 1);
    assert.ok(tiltFromVertical(runtime, 'domino20') < Math.PI / 18);
    advanceTo(runtime, 3);
    for (const id of ['domino01', 'domino10', 'domino20']) assert.ok(tiltFromVertical(runtime, id) > Math.PI / 3);
  } finally { runtime.dispose(); }
});
