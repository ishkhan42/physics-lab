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

function scalar(snapshot: InspectionSnapshot, entityId: string, label: string): number {
  const property = snapshot.entities.find(entity => entity.id === entityId)?.properties.find(item => item.label === label);
  assert.ok(property && typeof property.value === 'number', `missing ${label} for ${entityId}`);
  return property.value;
}

function angleFromDown(pivot: number[], bob: number[]): number {
  return Math.atan2(bob[0] - pivot[0], pivot[2] - bob[2]) * 180 / Math.PI;
}

function distance(a: number[], b: number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function advanceTo(runtime: MechanicsRuntime, target: number): void {
  while (runtime.time < target - 1e-10) {
    const result = runtime.advance(Math.min(0.25, target - runtime.time), 1);
    assert.equal(result.pauseReason, null);
    assert.ok(result.steps > 0);
  }
}

test('corrected double pendulums retain their absolute angles and moving lower pivots', async () => {
  const runtime = await createRuntime(exampleScene('sensitive-pendulums', '120-vs-120-1-deg'));
  try {
    const initial = runtime.snapshot();
    assert.ok(Math.abs(angleFromDown(vector(initial, 'pivotA'), vector(initial, 'Aupper')) - 120) < 1e-6);
    assert.ok(Math.abs(angleFromDown(vector(initial, 'Aupper'), vector(initial, 'Alower')) + 10) < 1e-6);
    assert.ok(Math.abs(angleFromDown(vector(initial, 'pivotB'), vector(initial, 'Bupper')) - 120.1) < 1e-6);
    assert.ok(Math.abs(angleFromDown(vector(initial, 'Bupper'), vector(initial, 'Blower')) + 10) < 1e-6);

    advanceTo(runtime, 0.5);
    const moved = runtime.snapshot();
    assert.ok(distance(vector(moved, 'Aupper'), vector(initial, 'Aupper')) > 0.05);
    assert.ok(Math.abs(distance(vector(moved, 'Aupper'), vector(moved, 'Alower')) - 1) < 1e-3);
    assert.ok(Math.abs(distance(vector(moved, 'Bupper'), vector(moved, 'Blower')) - 1) < 1e-3);
  } finally {
    runtime.dispose();
  }
});

test('recoil example launches held rounds on schedule and updates native loaded inventory', async () => {
  const runtime = await createRuntime(exampleScene('recoil', 'frictional-contacts'));
  try {
    const initial = runtime.snapshot();
    assert.equal(scalar(initial, 'cart', 'Loaded mass'), 8);
    assert.deepEqual(initial.events?.map(event => event.status), ['pending', 'pending', 'pending']);

    advanceTo(runtime, 0.001);
    let snapshot = runtime.snapshot();
    assert.deepEqual(snapshot.events?.map(event => event.status), ['completed', 'pending', 'pending']);
    assert.equal(scalar(snapshot, 'cart', 'Loaded mass'), 7);
    assert.ok(Math.abs(vector(snapshot, 'round1', 'Velocity')[0] - 10.392304845413264) < 0.02);
    assert.ok(Math.abs(vector(snapshot, 'round1', 'Velocity')[2] - 5.999999999999999) < 0.02);
    assert.ok(vector(snapshot, 'cart', 'Velocity')[0] < 0, 'the free cart receives launch recoil');

    advanceTo(runtime, 1.999);
    snapshot = runtime.snapshot();
    assert.deepEqual(snapshot.events?.map(event => event.status), ['completed', 'pending', 'pending']);
    assert.equal(scalar(snapshot, 'cart', 'Loaded mass'), 7);
    advanceTo(runtime, 2.001);
    snapshot = runtime.snapshot();
    assert.deepEqual(snapshot.events?.map(event => event.status), ['completed', 'completed', 'pending']);
    assert.equal(scalar(snapshot, 'cart', 'Loaded mass'), 6);

    advanceTo(runtime, 3.999);
    snapshot = runtime.snapshot();
    assert.deepEqual(snapshot.events?.map(event => event.status), ['completed', 'completed', 'pending']);
    assert.equal(scalar(snapshot, 'cart', 'Loaded mass'), 6);
    advanceTo(runtime, 4.001);
    snapshot = runtime.snapshot();
    assert.deepEqual(snapshot.events?.map(event => event.status), ['completed', 'completed', 'completed']);
    assert.ok(snapshot.events?.every((event, index) => event.firedAt !== null && Math.abs(event.firedAt - index * 2) < 1e-9));
    assert.equal(scalar(snapshot, 'cart', 'Loaded mass'), 5);
  } finally {
    runtime.dispose();
  }
});
