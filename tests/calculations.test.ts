import assert from 'node:assert/strict';
import test from 'node:test';
import { calculate } from '../shared/calculations.ts';

test('calculates projectile components and 45-degree cord projections', () => {
  const { results } = calculate({ steps: [
    { id: 'angle3', operation: 'deg_to_rad', args: [3] },
    { id: 'cos3', operation: 'cos', args: [{ ref: 'angle3' }] },
    { id: 'sin3', operation: 'sin', args: [{ ref: 'angle3' }] },
    { id: 'horizontalVelocity', operation: 'multiply', args: [300, { ref: 'cos3' }] },
    { id: 'verticalVelocity', operation: 'multiply', args: [300, { ref: 'sin3' }] },
    { id: 'speed', operation: 'hypot', args: [{ ref: 'horizontalVelocity' }, { ref: 'verticalVelocity' }] },
    { id: 'measuredAngle', operation: 'atan2', args: [{ ref: 'verticalVelocity' }, { ref: 'horizontalVelocity' }] },
    { id: 'measuredDegrees', operation: 'rad_to_deg', args: [{ ref: 'measuredAngle' }] },
    { id: 'angle45', operation: 'divide', args: [{ constant: 'pi' }, 4] },
    { id: 'cos45', operation: 'cos', args: [{ ref: 'angle45' }] },
    { id: 'sin45', operation: 'sin', args: [{ ref: 'angle45' }] },
    { id: 'cordProjection', operation: 'multiply', args: [3, { ref: 'cos45' }] },
    { id: 'cordVerticalProjection', operation: 'multiply', args: [3, { ref: 'sin45' }] },
  ] });

  assert.ok(Math.abs(results.horizontalVelocity! - 299.58886042637215) < 1e-10);
  assert.ok(Math.abs(results.verticalVelocity! - 15.70078687288315) < 1e-10);
  assert.ok(Math.abs(results.speed! - 300) < 1e-10);
  assert.ok(Math.abs(results.cordProjection! - 2.121320343559643) < 1e-12);
  assert.ok(Math.abs(results.cordVerticalProjection! - 2.121320343559643) < 1e-12);
  assert.ok(Math.abs(results.measuredDegrees! - 3) < 1e-12);
});

test('rejects division by zero, forward references, invalid domains and wrong arity', () => {
  assert.throws(() => calculate({ steps: [{ id: 'zero', operation: 'divide', args: [1, 0] }] }), Error);
  assert.throws(() => calculate({ steps: [{ id: 'later', operation: 'add', args: [{ ref: 'future' }, 1] }] }), Error);
  assert.throws(() => calculate({ steps: [{ id: 'root', operation: 'sqrt', args: [-1] }] }), Error);
  assert.throws(() => calculate({ steps: [{ id: 'zeroVector', operation: 'atan2', args: [0, 0] }] }), Error);
  assert.throws(() => calculate({ steps: [
    { id: 'halfPi', operation: 'divide', args: [{ constant: 'pi' }, 2] },
    { id: 'pole', operation: 'tan', args: [{ ref: 'halfPi' }] },
  ] }), Error);
  assert.throws(() => calculate({ steps: [{ id: 'sum', operation: 'add', args: [1] }] }), Error);
});

test('rejects duplicate names, more than 32 steps and more than 8 arguments', () => {
  assert.throws(() => calculate({ steps: [
    { id: 'same', operation: 'add', args: [1, 2] },
    { id: 'same', operation: 'add', args: [3, 4] },
  ] }), Error);
  assert.throws(() => calculate({ steps: Array.from({ length: 33 }, (_, index) => ({ id: `step${index}`, operation: 'sqrt', args: [1] })) }), Error);
  assert.throws(() => calculate({ steps: [{ id: 'wide', operation: 'hypot', args: Array(9).fill(1) }] }), Error);
  const boundary = calculate({ steps: Array.from({ length: 32 }, (_, index) => ({
    id: `step${index}`, operation: 'add', args: [index === 0 ? 0 : { ref: `step${index - 1}` }, 1],
  })) });
  assert.equal(boundary.results.step31, 32);
  assert.equal(calculate({ steps: [{ id: 'norm', operation: 'hypot', args: [3, 4, 0, 0, 0, 0, 0, 0] }] }).results.norm, 5);
});
