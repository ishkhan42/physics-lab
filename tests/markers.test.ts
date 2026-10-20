import assert from 'node:assert/strict';
import test from 'node:test';
import { Box3, BoxGeometry, BufferGeometry, Color, EdgesGeometry, Float32BufferAttribute, Line, LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial, PerspectiveCamera, Points, PointsMaterial, Vector3 } from 'three';
import { updateMarkers, type Marked } from '../src/markers.ts';
import { entityBounds, ScenePicker } from '../src/selection.ts';

function scene() {
  const marked: Marked[] = ['front', 'neighbor', 'queued'].map((entityId, index) => {
    const object = new Mesh(new BoxGeometry(0.2, 0.2, 0.2), new MeshBasicMaterial());
    object.position.x = index;
    object.visible = entityId !== 'queued';
    object.add(new LineSegments(new EdgesGeometry(object.geometry), new LineBasicMaterial()));
    const marker = new Points(new BufferGeometry().setAttribute('position', new Float32BufferAttribute([0, 0, 0], 3)), new PointsMaterial());
    object.add(marker);
    return { entityId, object, marker, radius: Math.sqrt(3) * 0.1, color: new Color(index === 0 ? '#00aa88' : '#aa4400'), surfaceVisible: true };
  });
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(new Float32Array(9), 3));
  geometry.setAttribute('color', new Float32BufferAttribute(new Float32Array(9), 3));
  const markerBatch = new Points(geometry, new PointsMaterial({ vertexColors: true }));
  const camera = new PerspectiveCamera(60, 1, 0.1, 10000);
  camera.position.set(0, -1000, 0);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  return { visuals: { marked, markerBatch, tracks: [] }, camera };
}

const selectionColor = new Color('#0f6b62');

test('batched distant bodies remain selectable and restore full geometry when focused', () => {
  const { visuals, camera } = scene();
  const front = visuals.marked[0]!;
  const targets = visuals.marked.map(({ entityId, object, marker }) => ({ entityId, object, marker }));
  const originalBounds = entityBounds(targets, 'front', new Box3()).clone();
  updateMarkers(visuals, camera, 800, 'front', selectionColor);
  assert.equal(visuals.markerBatch.geometry.drawRange.count, 1);
  assert.equal(visuals.markerBatch.geometry.getAttribute('position').getX(0), 1);
  assert.equal(front.object.visible, true);
  assert.equal((front.object.material as MeshBasicMaterial).visible, false);
  assert.equal((front.marker.material as PointsMaterial).visible, true);
  assert.equal((visuals.marked[1]!.marker.material as PointsMaterial).visible, false);
  assert.equal(visuals.marked[2]!.marker.visible, false);
  assert.equal(new ScenePicker().pick(targets, camera, 800, 800, 400, 400), 'front');
  assert.deepEqual(entityBounds(targets, 'front', new Box3()), originalBounds);

  camera.position.set(0, -1, 0);
  camera.updateMatrixWorld();
  updateMarkers(visuals, camera, 800, 'front', selectionColor);
  assert.equal(visuals.markerBatch.geometry.drawRange.count, 0);
  assert.equal(front.marker.visible, false);
  assert.equal((front.object.material as MeshBasicMaterial).visible, true);
  const edges = front.object.children.find(child => child instanceof LineSegments) as LineSegments;
  assert.equal((edges.material as LineBasicMaterial).visible, true);
  assert.equal(new ScenePicker().pick(targets, camera, 800, 800, 400, 400), 'front');
});

test('subpixel trail culling preserves the recorded path and shows it when resolvable', () => {
  const { visuals, camera } = scene();
  const trail = new Line(new BufferGeometry(), new LineBasicMaterial());
  const bounds = new Box3(new Vector3(0, 0, 0), new Vector3(0.01, 0, 0));
  const track = { object: visuals.marked[0]!.object, trail, bounds, count: 2 };
  const withTrail = { ...visuals, tracks: [track] };
  updateMarkers(withTrail, camera, 800, null, selectionColor);
  assert.equal(trail.visible, false);
  assert.equal(track.count, 2);
  assert.deepEqual(track.bounds.max.toArray(), [0.01, 0, 0]);
  camera.position.set(0, -1, 0);
  camera.updateMatrixWorld();
  updateMarkers(withTrail, camera, 800, null, selectionColor);
  assert.equal(trail.visible, true);
  track.object.visible = false;
  updateMarkers(withTrail, camera, 800, null, selectionColor);
  assert.equal(trail.visible, false);
});
