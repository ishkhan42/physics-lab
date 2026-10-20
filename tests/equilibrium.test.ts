import assert from 'node:assert/strict';
import test from 'node:test';
import { validateScene } from '../shared/scene.ts';
import { createRuntime } from '../src/physics/mujoco.ts';
import type { MechanicsRuntime } from '../src/physics/types.ts';

function run(runtime: MechanicsRuntime, seconds: number): void {
  const end = runtime.time + seconds;
  while (runtime.time < end - 1e-10) {
    const result = runtime.advance(Math.min(0.05, end - runtime.time), 1);
    assert.equal(result.pauseReason, null);
    assert.ok(result.steps > 0);
  }
}
function property(runtime: MechanicsRuntime, id: string, label: string) {
  return runtime.snapshot().entities.find(entity => entity.id === id)?.properties.find(item => item.label === label)?.value;
}
function scene(velocity = 0, gravity = -9.81) {
  return validateScene({ category: 'mechanics', title: 'Rest and impact', gravity: [0, 0, gravity],
    bodies: [
      { id: 'box', label: 'Box', position: [0, 0, 0.1], shape: { kind: 'box', size: [0.2, 0.2, 0.2] }, mass: 1,
        friction: { sliding: 0.3 }, motion: { kind: 'free', linearVelocity: [velocity, 0, 0] } },
      { id: 'ball', label: 'Incoming ball', position: [-2, 0, 0.1], shape: { kind: 'sphere', radius: 0.08 }, mass: 2,
        motion: { kind: 'free', linearVelocity: [2, 0, 0] } },
    ],
  });
}

test('settled rough boxes sleep, wake on impact, and reset without preserving sleep', async () => {
  const runtime = await createRuntime(scene());
  try {
    run(runtime, 0.3);
    assert.equal(property(runtime, 'box', 'Activity'), 'Resting · wakes on contact');
    assert.equal(property(runtime, 'box', 'Contact force'), undefined);
    assert.equal(property(runtime, 'world-ground', 'Contact force'), undefined);
    const resting = property(runtime, 'box', 'Position');
    assert.ok(Array.isArray(resting));
    run(runtime, 0.9);
    const moved = property(runtime, 'box', 'Position');
    assert.ok(Array.isArray(moved));
    assert.ok(moved[0] > resting[0] + 0.1);
    assert.notEqual(property(runtime, 'box', 'Activity'), 'Resting · wakes on contact');
    runtime.reset();
    assert.equal(runtime.time, 0);
    assert.deepEqual(property(runtime, 'box', 'Position'), [0, 0, 0.1]);
    assert.notEqual(property(runtime, 'box', 'Activity'), 'Resting · wakes on contact');
    run(runtime, 0.3);
    assert.equal(property(runtime, 'box', 'Activity'), 'Resting · wakes on contact');
  } finally { runtime.dispose(); }
});

test('explicit slow motion in zero gravity is never rounded into rest', async () => {
  const runtime = await createRuntime(scene(0.0001, 0));
  try {
    run(runtime, 0.5);
    assert.deepEqual(property(runtime, 'box', 'Velocity'), [0.0001, 0, 0]);
    const position = property(runtime, 'box', 'Position');
    assert.ok(Array.isArray(position));
    assert.ok(Math.abs(position[0] - 0.00005) < 1e-12);
    assert.notEqual(property(runtime, 'box', 'Activity'), 'Resting · wakes on contact');
  } finally { runtime.dispose(); }
});

test('a resting box launched airborne by contact cannot sleep at its apex', async () => {
  const runtime = await createRuntime(validateScene({
    category: 'mechanics', title: 'Contact wake into flight', gravity: [0, 0, -1], ground: null,
    bodies: [
      { id: 'support', label: 'Narrow support', position: [0.08, 0, 1], shape: { kind: 'box', size: [0.02, 0.2, 0.1] }, mass: null, motion: { kind: 'fixed' } },
      { id: 'support-left', label: 'Left support', position: [-0.08, 0, 1], shape: { kind: 'box', size: [0.02, 0.2, 0.1] }, mass: null, motion: { kind: 'fixed' } },
      { id: 'box', label: 'Box', position: [0, 0, 1.15], shape: { kind: 'box', size: [0.2, 0.2, 0.2] }, mass: 1, friction: { sliding: 1 }, motion: { kind: 'free' } },
      { id: 'ball', label: 'Incoming ball', position: [0, 0, 0.3], shape: { kind: 'sphere', radius: 0.02 }, mass: 10, motion: { kind: 'free', linearVelocity: [0, 0, 2] } },
    ],
  }));
  try {
    run(runtime, 0.1);
    assert.equal(property(runtime, 'box', 'Activity'), 'Resting · wakes on contact');
    let highest = 0;
    for (let sample = 0; sample < 500; sample++) {
      run(runtime, 0.01);
      const position = property(runtime, 'box', 'Position');
      assert.ok(Array.isArray(position));
      highest = Math.max(highest, position[2]);
      if (position[2] > 1.3) assert.notEqual(property(runtime, 'box', 'Activity'), 'Resting · wakes on contact');
    }
    const final = property(runtime, 'box', 'Position');
    assert.ok(Array.isArray(final));
    assert.ok(highest > 1.5, 'impact must produce actual upward flight');
    assert.ok(final[2] < highest - 0.2, 'gravity must continue through the apex');
  } finally { runtime.dispose(); }
});
