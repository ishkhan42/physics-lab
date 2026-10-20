import assert from 'node:assert/strict';
import test from 'node:test';
import { FixedStepClock, browserFrameSeconds } from '../src/physics/clock.ts';

const advanceStep = { advanced: true, pauseReason: null } as const;

test('fixed clock carries fractional time and consumes only fixed steps', () => {
  const clock = new FixedStepClock(0.001);
  let steps = 0;
  const step = () => { steps++; return advanceStep; };
  assert.deepEqual(clock.advance(0.0004, 1, step), { steps: 0, pauseReason: null });
  assert.deepEqual(clock.advance(0.0006, 1, step), { steps: 1, pauseReason: null });
  assert.equal(steps, 1);
});

test('a device slower than the selected speed keeps stepping without pausing or building unbounded debt', () => {
  const clock = new FixedStepClock(0.001);
  let steps = 0;
  const step = () => { steps++; return advanceStep; };
  for (let frame = 0; frame < 20; frame++) {
    const result = clock.advance(0.2, 10, step);
    assert.equal(result.pauseReason, null);
    assert.equal(result.steps, 512);
    assert.equal(result.throttled, true);
  }
  // Queued time is capped, so the next idle frame drains at most one frame of work instead of seconds of hidden catch-up.
  assert.equal(clock.advance(0, 1, step).steps, 512);
  assert.deepEqual(clock.advance(0, 1, step), { steps: 0, pauseReason: null });
  assert.equal(steps, 20 * 512 + 512);
});

test('clock rejects hidden pages and long frame gaps without adding wall time', () => {
  const clock = new FixedStepClock(0.001);
  let steps = 0;
  const step = () => { steps++; return advanceStep; };
  assert.deepEqual(clock.advance(0.0005, 1, step), { steps: 0, pauseReason: null });
  assert.equal(clock.advance(0.251, 1, step).steps, 0);
  assert.equal(clock.advance(0.0005, 1, step, false).steps, 0);
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

test('browser timing separates foreground work from suspended gaps while bounding catch-up', () => {
  assert.equal(browserFrameSeconds(1000, 1010, 1016), 0.016);
  assert.equal(browserFrameSeconds(1000, 2000, 2016), 0.25);
  assert.equal(browserFrameSeconds(1000, 2000, 2250), 0.25);
  assert.equal(browserFrameSeconds(1000, 2000, 2251), null);
  const clock = new FixedStepClock();
  assert.equal(clock.advance(browserFrameSeconds(0, 1000, 1016)!, 1, () => advanceStep).steps, 250);
});
