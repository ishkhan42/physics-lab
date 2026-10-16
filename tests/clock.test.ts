import assert from 'node:assert/strict';
import test from 'node:test';
import { FixedStepClock } from '../src/physics/clock.ts';

const advanceStep = { advanced: true, pauseReason: null } as const;

test('fixed clock carries fractional time and consumes only fixed steps', () => {
  const clock = new FixedStepClock(0.001);
  let steps = 0;
  const step = () => { steps++; return advanceStep; };
  assert.deepEqual(clock.advance(0.0004, 1, step), { steps: 0, pauseReason: null });
  assert.deepEqual(clock.advance(0.0006, 1, step), { steps: 1, pauseReason: null });
  assert.equal(steps, 1);
});

test('clock bounds frame work and retains queued simulation time', () => {
  const clock = new FixedStepClock(0.001);
  let steps = 0;
  const result = clock.advance(0.25, 10, () => { steps++; return advanceStep; });
  assert.equal(result.steps, 512);
  assert.match(result.pauseReason ?? '', /one simulated second is queued/);
  assert.equal(steps, 512);
  const resumed = clock.advance(0, 1, () => { steps++; return advanceStep; });
  assert.equal(resumed.steps, 512);
  assert.match(resumed.pauseReason ?? '', /one simulated second is queued/);
  assert.equal(steps, 1024);
});

test('clock rejects hidden pages and long frame gaps without adding wall time', () => {
  const clock = new FixedStepClock(0.001);
  let steps = 0;
  const step = () => { steps++; return advanceStep; };
  assert.deepEqual(clock.advance(0.0005, 1, step), { steps: 0, pauseReason: null });
  assert.match(clock.advance(0.251, 1, step).pauseReason ?? '', /long frame gap/);
  assert.match(clock.advance(0.0005, 1, step, false).pauseReason ?? '', /page is hidden/);
  assert.deepEqual(clock.advance(0.0005, 1, step), { steps: 1, pauseReason: null });
  assert.equal(steps, 1);
});

test('clock validates timestep, wall time, and playback speed', () => {
  assert.throws(() => new FixedStepClock(0), RangeError);
  const clock = new FixedStepClock();
  const step = () => advanceStep;
  assert.throws(() => clock.advance(Number.NaN, 1, step), RangeError);
  assert.throws(() => clock.advance(0, 0.09, step), RangeError);
  assert.throws(() => clock.advance(0, 10.1, step), RangeError);
});
