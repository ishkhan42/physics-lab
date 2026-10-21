import assert from 'node:assert/strict';
import test from 'node:test';
import { Box3, BoxGeometry, BufferGeometry, Float32BufferAttribute, Line, LineBasicMaterial, Mesh, MeshBasicMaterial, PerspectiveCamera, Points, PointsMaterial, SphereGeometry } from 'three';
import { entityBounds, ScenePicker, type PickTarget } from '../src/selection.ts';
import { TendonVisual } from '../src/tendon-visuals.ts';
import type { RenderItem } from '../src/physics/types.ts';

function camera() {
  const value = new PerspectiveCamera(60, 1, 0.1, 100);
  value.position.set(0, 0, 10);
  value.lookAt(0, 0, 0);
  value.updateMatrixWorld();
  return value;
}

test('picking uses the front visible surface and excludes queued bodies and empty space', () => {
  const front = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
  const back = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
  back.position.z = -3;
  const targets: PickTarget[] = [{ entityId: 'back', object: back }, { entityId: 'front', object: front }];
  const picker = new ScenePicker();
  const view = camera();
  assert.equal(picker.pick(targets, view, 1000, 1000, 500, 500), 'front');
  front.visible = false;
  assert.equal(picker.pick(targets, view, 1000, 1000, 500, 500), 'back');
  back.visible = false;
  assert.equal(picker.pick(targets, view, 1000, 1000, 500, 500), null);
  front.visible = true;
  assert.equal(picker.pick(targets, view, 1000, 1000, 0, 0), null);
});

test('a tiny body is selectable through its screen marker but hidden and behind-camera markers are not', () => {
  const body = new Mesh(new SphereGeometry(0.0001), new MeshBasicMaterial());
  const marker = new Points(new BufferGeometry().setAttribute('position', new Float32BufferAttribute([0, 0, 0], 3)), new PointsMaterial());
  body.add(marker);
  const target = [{ entityId: 'tiny', object: body, marker }];
  const picker = new ScenePicker();
  const view = camera();
  assert.equal(picker.pick(target, view, 1000, 1000, 508, 500), 'tiny');
  assert.equal(picker.pick(target, view, 1000, 1000, 530, 500), null);
  body.visible = false;
  assert.equal(picker.pick(target, view, 1000, 1000, 508, 500), null);
  body.visible = true;
  body.position.z = 20;
  assert.equal(picker.pick(target, view, 1000, 1000, 500, 500), null);
  body.position.z = 0;
  const behind = new Mesh(new SphereGeometry(0.0001), new MeshBasicMaterial());
  behind.position.z = -2;
  const behindMarker = new Points(marker.geometry, marker.material);
  behind.add(behindMarker);
  assert.equal(picker.pick([{ entityId: 'behind', object: behind, marker: behindMarker }, ...target], view, 1000, 1000, 508, 500), 'tiny');
});

test('cable picking and selected bounds follow changing path geometry without including other bodies', () => {
  const geometry = new BufferGeometry().setAttribute('position', new Float32BufferAttribute([-2, 0, 0, 2, 0, 0], 3));
  const cable = new Line(geometry, new LineBasicMaterial());
  const other = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
  other.position.x = 50;
  const targets = [{ entityId: 'cable', object: cable }, { entityId: 'other', object: other }];
  const picker = new ScenePicker();
  const view = camera();
  assert.equal(picker.pick(targets, view, 1000, 1000, 500, 504), 'cable');
  const bounds = entityBounds(targets, 'cable', new Box3());
  assert.deepEqual(bounds.min.toArray(), [-2, 0, 0]);
  assert.deepEqual(bounds.max.toArray(), [2, 0, 0]);
  geometry.getAttribute('position').setXYZ(1, 4, 3, 0);
  entityBounds(targets, 'cable', bounds);
  assert.deepEqual(bounds.max.toArray(), [4, 3, 0]);
  cable.visible = false;
  assert.equal(entityBounds(targets, 'cable', bounds).isEmpty(), true);
});

test('a thin solid cord stays easy to pick after its path moves, without stale bounds or ghost hits', () => {
  const item: RenderItem = {
    id: 'cord', entityId: 'cord', label: 'Cord', color: '#c78b35', shape: { kind: 'line' },
    position: [0, 0, 0], quaternion: [0, 0, 0, 1], points: [[-2, 0, 0], [2, 0, 0]],
    tendon: { mode: 'fixed', length: 4, restLength: 4, force: 0, wrapped: [false] },
  };
  const visual = new TendonVisual(item);
  const targets: PickTarget[] = [{ entityId: 'cord', object: visual, pickLine: visual.pickLine }];
  const picker = new ScenePicker();
  const view = camera();
  try {
    assert.equal(picker.pick(targets, view, 1000, 1000, 500, 504), 'cord');
    assert.equal(picker.pick(targets, view, 1000, 1000, 500, 520), null);
    item.points![0][1] = 1;
    item.points![1][1] = 1;
    visual.update(item);
    assert.equal(picker.pick(targets, view, 1000, 1000, 500, 417), 'cord');
    assert.equal(picker.pick(targets, view, 1000, 1000, 500, 504), null);
    const bounds = entityBounds(targets, 'cord', new Box3());
    assert.ok(bounds.min.y > 0.9 && bounds.max.y < 1.1);
    visual.visible = false;
    assert.equal(picker.pick(targets, view, 1000, 1000, 500, 417), null);
  } finally {
    visual.dispose();
  }
});
