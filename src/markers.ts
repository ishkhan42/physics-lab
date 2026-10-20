import { LineSegments, type Box3, type BufferGeometry, type Color, type Line, type Mesh, type Object3D, type PerspectiveCamera, type Points, type PointsMaterial } from 'three';

export interface Marked {
  object: Mesh;
  entityId: string;
  marker: Points;
  radius: number;
  color: Color;
  surfaceVisible: boolean;
}

interface MarkerVisuals {
  marked: Marked[];
  markerBatch: Points<BufferGeometry, PointsMaterial>;
  tracks: { object: Object3D; trail: Line; bounds: Box3; count: number }[];
}

export function updateMarkers(visuals: MarkerVisuals, camera: PerspectiveCamera, viewportHeight: number, selectedEntityId: string | null, selectionColor: Color): void {
  const pixelsPerUnitAtOne = viewportHeight / 2 / Math.tan(camera.fov * Math.PI / 360);
  const positions = visuals.markerBatch.geometry.getAttribute('position');
  const colors = visuals.markerBatch.geometry.getAttribute('color');
  let count = 0;
  for (const item of visuals.marked) {
    const distance = Math.max(camera.position.distanceTo(item.object.position), 1e-6);
    const marked = item.object.visible && item.radius * pixelsPerUnitAtOne / distance < 5;
    item.marker.visible = marked;
    const selected = selectedEntityId === item.entityId;
    const material = item.marker.material as PointsMaterial;
    material.visible = selected;
    material.size = 26;
    material.color.copy(selectionColor);
    item.marker.renderOrder = 4;
    if (marked && !selected) {
      positions.setXYZ(count, item.object.position.x, item.object.position.y, item.object.position.z);
      colors.setXYZ(count, item.color.r, item.color.g, item.color.b);
      count++;
    }
    // The marker replaces geometry too small to resolve, not the physical or pickable object.
    const surfaceVisible = !marked;
    if (surfaceVisible !== item.surfaceVisible) {
      item.surfaceVisible = surfaceVisible;
      const surface = item.object.material;
      if (Array.isArray(surface)) for (const part of surface) part.visible = surfaceVisible;
      else surface.visible = surfaceVisible;
      for (const child of item.object.children) {
        if (!(child instanceof LineSegments)) continue;
        const edges = child.material;
        if (Array.isArray(edges)) for (const part of edges) part.visible = surfaceVisible;
        else edges.visible = surfaceVisible;
      }
    }
  }
  visuals.markerBatch.geometry.setDrawRange(0, count);
  positions.needsUpdate = true;
  colors.needsUpdate = true;
  for (const track of visuals.tracks) {
    if (!track.object.visible || track.count < 2) {
      track.trail.visible = false;
      continue;
    }
    const bounds = track.bounds;
    const radius = Math.hypot(bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y, bounds.max.z - bounds.min.z) / 2;
    const x = (bounds.min.x + bounds.max.x) / 2 - camera.position.x;
    const y = (bounds.min.y + bounds.max.y) / 2 - camera.position.y;
    const z = (bounds.min.z + bounds.max.z) / 2 - camera.position.z;
    const distance = Math.max(Math.hypot(x, y, z) - radius, camera.near);
    track.trail.visible = radius * 2 * pixelsPerUnitAtOne / distance >= 1;
  }
}
