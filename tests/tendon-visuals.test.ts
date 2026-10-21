import assert from 'node:assert/strict';
import test from 'node:test';
import { Box3, Raycaster, Vector3 } from 'three';
import { TendonVisual } from '../src/tendon-visuals.ts';
import type { RenderItem, TendonRenderState } from '../src/physics/types.ts';

function item(points: [number, number, number][], tendon: TendonRenderState): RenderItem {
  return {
    id: 'tendon',
    entityId: 'tendon',
    label: 'tendon',
    color: '#b33f42',
    shape: { kind: 'line' },
    position: [0, 0, 0],
    quaternion: [0, 0, 0, 1],
    points,
    tendon,
  };
}

function tendon(mode: TendonRenderState['mode'], length: number, restLength = length): TendonRenderState {
  return { mode, length, restLength, force: null, wrapped: [] };
}

function positions(visual: TendonVisual): Float32Array {
  return visual.pickLine.geometry.getAttribute('position').array as Float32Array;
}

test('spring wire is a changing helix with pinned endpoints', () => {
  const state = tendon('spring', 1);
  state.visual = { wireRadius: 0.02, coilRadius: 0.15, turns: 8 };
  const visual = new TendonVisual(item([[0, 0, 0], [1, 0, 0]], state));
  const initial = positions(visual);
  const count = visual.pickLine.geometry.drawRange.count;
  const initialMidpoint = initial[(count >> 1) * 3];
  let offAxis = false;
  for (let point = 1; point < count - 1; point += 1) {
    if (Math.hypot(initial[point * 3 + 1], initial[point * 3 + 2]) > 0.05) offAxis = true;
  }
  assert.equal(offAxis, true);
  assert.deepEqual(Array.from(initial.slice(0, 3)), [0, 0, 0]);
  assert.deepEqual(Array.from(initial.slice((count - 1) * 3, count * 3)), [1, 0, 0]);

  state.length = 1.5;
  visual.update(item([[0, 0, 0], [1.5, 0, 0]], state));
  const extended = positions(visual);
  assert.deepEqual(Array.from(extended.slice((visual.pickLine.geometry.drawRange.count - 1) * 3, visual.pickLine.geometry.drawRange.count * 3)), [1.5, 0, 0]);
  assert.notEqual(extended[(count >> 1) * 3], initialMidpoint);
  visual.dispose();
  visual.dispose();
});

test('spring routing preserves native wrapped arc samples as plain wire', () => {
  const state = tendon('spring', 1);
  state.visual = { turns: 8, coilRadius: 0.1 };
  state.wrapped = [true, true];
  const visual = new TendonVisual(item([[0, 0, 0], [0.5, 0.5, 0], [1, 0, 0]], state));
  const line = positions(visual);
  assert.deepEqual(Array.from(line.slice(3, 6)), [0.5, 0.5, 0]);
  assert.deepEqual(Array.from(line.slice(6, 9)), [1, 0, 0]);
  visual.dispose();
});

test('rope slack bows only free spans and cached picking geometry follows updates', () => {
  const state = tendon('rope', Math.SQRT2, 2);
  state.wrapped = [true, false];
  const start = item([[0, 0, 0], [0.5, 0.5, 0], [1, 0, 0]], state);
  const visual = new TendonVisual(start);
  const first = positions(visual);
  assert.deepEqual(Array.from(first.slice(0, 3)), [0, 0, 0]);
  assert.deepEqual(Array.from(first.slice(3, 6)), [0.5, 0.5, 0]);
  assert.deepEqual(Array.from(first.slice((visual.pickLine.geometry.drawRange.count - 1) * 3, visual.pickLine.geometry.drawRange.count * 3)), [1, 0, 0]);
  let bowed = false;
  for (let point = 2; point < visual.pickLine.geometry.drawRange.count - 1; point += 1) {
    if (Math.abs(first[point * 3 + 2]) > 0.01) bowed = true;
  }
  assert.equal(bowed, true);

  state.length = 1.6;
  state.wrapped = [false];
  visual.update(item([[3, 1, 0], [4, 1, 0]], state));
  const bounds = visual.pickLine.geometry.boundingBox!;
  assert.ok(bounds.min.x > 2.9);
  assert.ok(bounds.max.x > 3.9);
  assert.ok(visual.pickLine.geometry.boundingSphere!.center.x > 3.4);
  visual.dispose();
});
test('signed force cues point inward for tension and outward for compression', () => {
  const state = tendon('fixed', 1);
  const visualOptions = state.visual = { wireRadius: 0.02, forceScale: 25 };
  const visual = new TendonVisual(item([[0, 0, 0], [1, 0, 0]], state));
  const rayHit = (x: number, y: number): boolean => {
    visual.updateWorldMatrix(true, true);
    const raycaster = new Raycaster(new Vector3(x, y, 1), new Vector3(0, 0, -1));
    return raycaster.intersectObject(visual, false).length > 0;
  };

  state.force = 25;
  visual.update(item([[0, 0, 0], [1, 0, 0]], state));
  assert.equal(rayHit(0.4, 0.06), true);

  state.force = -25;
  visual.update(item([[0, 0, 0], [1, 0, 0]], state));
  assert.equal(rayHit(0.4, 0.06), false);
  assert.equal(rayHit(0.2, 0.06), true);

  state.force = 0;
  visual.update(item([[0, 0, 0], [1, 0, 0]], state));
  assert.equal(rayHit(0.4, 0.06), false);
  state.force = null;
  visual.update(item([[0, 0, 0], [1, 0, 0]], state));
  assert.equal(rayHit(0.4, 0.06), false);
  visualOptions.forceScale = 1e-12;
  state.force = 1e-8;
  visual.update(item([[0, 0, 0], [1, 0, 0]], state));
  assert.equal(rayHit(0.48, 0.06), true);

  visualOptions.forceScale = 0;
  assert.throws(() => visual.update(item([[0, 0, 0], [1, 0, 0]], state)), RangeError);
  visual.dispose();
});
test('expanded routes retain pins beyond 64 points and reject unsafe positions without changing visible geometry', () => {
  const points: [number, number, number][] = [];
  let length = 0;
  for (let index = 0; index < 130; index += 1) {
    const y = index % 2 === 0 ? 0 : 0.25;
    if (index > 0) length += Math.hypot(1, 0.25);
    points.push([index, y, 0]);
  }
  const state = tendon('fixed', length);
  const visual = new TendonVisual(item(points, state));
  const line = positions(visual);
  assert.deepEqual(Array.from(line.slice(100 * 3, 100 * 3 + 3)), points[100]);
  assert.deepEqual(Array.from(line.slice(129 * 3, 130 * 3)), points[129]);
  const previousGeometry = line.slice(0, visual.pickLine.geometry.drawRange.count * 3);

  assert.throws(() => visual.update(item([[0, 0, 0], [Number.NaN, 0, 0]], state)), RangeError);
  assert.throws(() => visual.update(item([[0, 0, 0], [Number.MAX_VALUE, 0, 0]], state)), RangeError);
  assert.deepEqual(positions(visual).slice(0, previousGeometry.length), previousGeometry);
  visual.dispose();
});



test('degenerate and rotated paths keep finite meshes, current bounds, and solid ray picking', () => {
  const state = tendon('fixed', 0);
  state.visual = { wireRadius: 0.08 };
  const visual = new TendonVisual(item([[1, 2, 3], [1, 2, 3]], state));
  const geometry = visual.pickLine.geometry;
  const initialPositions = positions(visual);
  assert.equal(initialPositions.every(Number.isFinite), true);
  assert.equal(geometry.boundingBox!.isEmpty(), false);

  state.length = 2;
  visual.update(item([[0, 0, 0], [0, 0, 2]], state));
  const raycaster = new Raycaster(new Vector3(1, 0, 1), new Vector3(-1, 0, 0));
  visual.updateWorldMatrix(true, true);
  assert.ok(raycaster.intersectObject(visual, false).length > 0);
  const lineRaycaster = new Raycaster(new Vector3(1, 0, 1), new Vector3(-1, 0, 0));
  lineRaycaster.params.Line.threshold = 0.1;
  assert.ok(lineRaycaster.intersectObject(visual.pickLine, false).length > 0);
  const bounds = new Box3().setFromObject(visual, false);
  assert.ok(bounds.min.x < 0);
  assert.ok(bounds.max.z > 1.9);
  assert.equal(positions(visual).every(Number.isFinite), true);
  visual.dispose();
});

test('explicit wire and coil radii remain visible when a spring compresses', () => {
  const state = tendon('spring', 1);
  state.visual = { wireRadius: 0.06, coilRadius: 0.25, turns: 4 };
  const visual = new TendonVisual(item([[0, 0, 0], [1, 0, 0]], state));
  const coilRadius = () => {
    const path = positions(visual);
    let radius = 0;
    for (let point = 0; point < visual.pickLine.geometry.drawRange.count; point++) {
      radius = Math.max(radius, Math.hypot(path[point * 3 + 1], path[point * 3 + 2]));
    }
    return radius;
  };
  try {
    assert.ok(Math.abs(coilRadius() - 0.25) < 0.01);
    assert.ok(new Box3().setFromObject(visual, false).max.y > 0.3);
    state.length = 0.25;
    visual.update(item([[0, 0, 0], [0.25, 0, 0]], state));
    assert.ok(Math.abs(coilRadius() - 0.25) < 0.01);
    assert.ok(new Box3().setFromObject(visual, false).max.y > 0.3);
  } finally {
    visual.dispose();
  }
});
