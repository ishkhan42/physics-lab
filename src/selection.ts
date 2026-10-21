import { Box3, Line, Raycaster, Vector2, Vector3, type Intersection, type Object3D, type PerspectiveCamera, type Points } from 'three';

export interface PickTarget {
  entityId: string;
  object: Object3D;
  marker?: Points;
  /** Compound connector visuals own a current, unrendered centerline for pixel-tolerant picking. */
  pickLine?: Line;
}

export function entityBounds(targets: PickTarget[], entityId: string, bounds: Box3): Box3 {
  bounds.makeEmpty();
  for (const target of targets) {
    if (target.entityId === entityId && target.object.visible) bounds.expandByObject(target.object, target.object instanceof Line);
  }
  return bounds;
}

export class ScenePicker {
  private raycaster = new Raycaster();
  private pointer = new Vector2();
  private projected = new Vector3();
  private intersections: Intersection[] = [];

  pick(targets: PickTarget[], camera: PerspectiveCamera, width: number, height: number, x: number, y: number, radius = 14): string | null {
    if (width <= 0 || height <= 0) return null;
    camera.updateMatrixWorld();
    let markerId: string | null = null;
    let markerDistance = radius * radius;
    let markerDepth = Infinity;
    for (const target of targets) {
      if (!target.object.visible || !target.marker?.visible) continue;
      target.object.updateWorldMatrix(true, false);
      this.projected.setFromMatrixPosition(target.object.matrixWorld).project(camera);
      if (this.projected.z < -1 || this.projected.z > 1) continue;
      const dx = (this.projected.x + 1) * width / 2 - x;
      const dy = (1 - this.projected.y) * height / 2 - y;
      const distance = dx * dx + dy * dy;
      if (distance < markerDistance || (distance === markerDistance && this.projected.z < markerDepth)) {
        markerDistance = distance;
        markerDepth = this.projected.z;
        markerId = target.entityId;
      }
    }
    if (markerId) return markerId;
    this.pointer.set(x / width * 2 - 1, 1 - y / height * 2);
    this.raycaster.setFromCamera(this.pointer, camera);
    const pixelsAtOne = height / 2 / Math.tan(camera.fov * Math.PI / 360);
    let closest = Infinity;
    let selected: string | null = null;
    for (const target of targets) {
      if (!target.object.visible) continue;
      target.object.updateWorldMatrix(true, false);
      const line = target.pickLine ?? (target.object instanceof Line ? target.object : null);
      if (line) {
        if (target.pickLine) line.updateWorldMatrix(true, false);
        else line.geometry.computeBoundingSphere();
        const sphere = line.geometry.boundingSphere;
        if (sphere) this.projected.copy(sphere.center).applyMatrix4(line.matrixWorld);
        this.raycaster.params.Line.threshold = Math.max(camera.position.distanceTo(this.projected), camera.near) / pixelsAtOne * 6;
      }
      this.intersections.length = 0;
      this.raycaster.intersectObject(target.object, false, this.intersections);
      if (target.pickLine) this.raycaster.intersectObject(target.pickLine, false, this.intersections);
      for (const hit of this.intersections) if (hit.distance < closest) { closest = hit.distance; selected = target.entityId; }
    }
    return selected;
  }
}
