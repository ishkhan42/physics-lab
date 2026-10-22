import { ArrowCounterClockwise, ArrowLeft, ArrowRight, CaretDown, CornersOut, Crosshair, Pause, Play, X } from '@phosphor-icons/react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  CanvasTexture,
  AxesHelper,
  Box3,
  Box3Helper,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CapsuleGeometry,
  Color,
  CylinderGeometry,
  EdgesGeometry,
  DynamicDrawUsage,
  GridHelper,
  Group,
  Line,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  Scene as ThreeScene,
  SphereGeometry,
  PlaneGeometry,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
  type Object3D,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Decision, Scene } from '../shared/scene.ts';
import type { InspectionView } from '../shared/visual-inspection.ts';
import { createRuntime } from './physics/mujoco.ts';
import { FIXED_TIMESTEP, browserFrameSeconds } from './physics/clock.ts';
import type { InspectionSnapshot, MechanicsRuntime, RenderItem } from './physics/types.ts';
import { entityBounds, ScenePicker, type PickTarget } from './selection.ts';
import { updateMarkers, type Marked } from './markers.ts';
import { DEFAULT_APPEARANCE, type Appearance } from '../shared/appearance.ts';
import { SceneEnvironment } from './environment.ts';
import AppearanceControls from './AppearanceControls.tsx';
import { TendonVisual, TENDON_COMPRESSION_COLOR, TENDON_TENSION_COLOR } from './tendon-visuals.ts';

export interface CanvasExperiment {
  id: number;
  scene: Scene;
  decision: Decision;
  userGroundChoice?: 'default' | 'none';
  /** Optional opening camera direction; prepared examples use it when the default angle hides the motion. */
  view?: 'top';
}
export interface CanvasInspectionCapture {
  simulatedAt: number;
  focusedId: string | null;
  notes: string[];
  snapshot: InspectionSnapshot;
  camera: { position: [number, number, number]; target: [number, number, number] };
}

export interface CanvasInspectionController {
  capture(time: number, view: InspectionView, focusId: string | null): Promise<CanvasInspectionCapture>;
}

interface SimulationCanvasProps {
  experiment: CanvasExperiment | null;
  onStatus: (id: number, message: string) => void;
  onReady: (experiment: CanvasExperiment, snapshot: InspectionSnapshot) => void;
  onSnapshot: (id: number, snapshot: InspectionSnapshot) => void;
  onFailure: (id: number, message: string) => void;
  onBeforeRun: (id: number) => Promise<boolean>;
  onPlaybackChange: (id: number, playing: boolean) => void;
  replacementPending: boolean;
  playbackBlocked: boolean;
  runToken: number;
  clearToken: number;
  appearance?: Appearance;
  appearanceDisabled?: boolean;
  appearanceSaving?: boolean;
  onAppearanceChange?: (appearance: Appearance) => void;
  selectedEntityId: string | null;
  onSelectEntity: (id: string | null) => void;
  emptyContent?: ReactNode;
  onInspectionController?: (controller: CanvasInspectionController | null) => void;
}

interface Track {
  object: Object3D;
  trail: Line;
  positions: Float32Array;
  count: number;
  bounds: Box3;
}


interface VisualSet {
  group: Group;
  objects: Map<string, Object3D>;
  lines: Map<string, Line>;
  tendons: Map<string, TendonVisual>;
  tracks: Track[];
  marked: Marked[];
  markerBatch: Points<BufferGeometry, PointsMaterial>;
  planes: Mesh[];
  pickTargets: PickTarget[];
}

const TRAIL_CAPACITY = 2048;
const SPEED_OPTIONS = [0.1, 0.25, 0.5, 1, 2, 5, 10];
// Pauses the user caused; everything else is shown on the stage.
const ROUTINE_PAUSES = new Set(['Paused. Values show the current state.', 'Reset to the initial conditions. Press Run to repeat the experiment.']);
const GRID_SIZE = 12;
const GRID_DIVISIONS = 24;
let markerTextureCache: CanvasTexture | null = null;

// Screen-size ring so small or distant moving bodies stay visible; tinted by the material colour.
function markerTexture(): CanvasTexture {
  if (markerTextureCache) return markerTextureCache;
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext('2d');
  if (context) {
    context.strokeStyle = '#ffffff';
    context.fillStyle = '#ffffff';
    context.lineWidth = 9;
    context.beginPath();
    context.arc(32, 32, 24, 0, Math.PI * 2);
    context.stroke();
    context.beginPath();
    context.arc(32, 32, 7, 0, Math.PI * 2);
    context.fill();
  }
  markerTextureCache = new CanvasTexture(canvas);
  markerTextureCache.colorSpace = SRGBColorSpace;
  return markerTextureCache;
}

const initialCameraDirection = new Vector3(1, -1.25, 0.9).normalize();
// Nearly overhead but still Z-up, so orbiting afterwards behaves as usual.
const topCameraDirection = new Vector3(0.12, -0.42, 1).normalize();
function cameraDirection(view: CanvasExperiment['view']): Vector3 {
  return view === 'top' ? topCameraDirection : initialCameraDirection;
}
const TIME_FORMAT = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 5 });
const selectionColor = new Color(0x0f6b62);

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : 'An unknown rendering or runtime error occurred.';
}

function disposeGroup(group: Group): void {
  const dispose = (object: Object3D) => {
    if (object instanceof TendonVisual) {
      object.dispose();
      return;
    }
    if (object instanceof Mesh || object instanceof Line || object instanceof Points) {
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) if (!material.userData.environmentOwned) material.dispose();
    }
    for (let index = object.children.length - 1; index >= 0; index--) dispose(object.children[index]);
  };
  dispose(group);
  group.removeFromParent();
}

function createVisual(item: RenderItem): Object3D {
  if (item.tendon) return new TendonVisual(item);
  if (item.shape.kind === 'line') {
    const points = item.points ?? [];
    const geometry = new BufferGeometry();
    const positions = new Float32Array(points.length * 3);
    const attribute = new BufferAttribute(positions, 3).setUsage(DynamicDrawUsage);
    geometry.setAttribute('position', attribute);
    for (let index = 0; index < points.length; index += 1) {
      attribute.setXYZ(index, points[index][0], points[index][1], points[index][2]);
    }
    const color = new Color(item.color);
    const luminance = 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
    // Preserve hue while keeping thin cords legible on the light canvas.
    if (luminance > 0.12) color.multiplyScalar(0.12 / luminance);
    const line = new Line(geometry, new LineBasicMaterial({ color }));
    line.frustumCulled = false;
    return line;
  }

  let geometry;
  let material: MeshBasicMaterial | MeshStandardMaterial;
  let scale: [number, number, number] = [1, 1, 1];
  if (item.shape.kind === 'sphere') {
    geometry = new SphereGeometry(item.shape.radius, 32, 20);
    material = new MeshStandardMaterial({ color: item.color, roughness: 0.36, metalness: 0.12 });
  } else if (item.shape.kind === 'box') {
    geometry = new BoxGeometry(...item.shape.size);
    material = new MeshStandardMaterial({ color: item.color, roughness: 0.4, metalness: 0.12 });
  } else if (item.shape.kind === 'cylinder') {
    geometry = new CylinderGeometry(item.shape.radius, item.shape.radius, item.shape.length, 32, 1);
    geometry.rotateX(Math.PI / 2);
    material = new MeshStandardMaterial({ color: item.color, roughness: 0.36, metalness: 0.14 });
  } else if (item.shape.kind === 'capsule') {
    geometry = new CapsuleGeometry(item.shape.radius, item.shape.length, 6, 20);
    geometry.rotateX(Math.PI / 2);
    material = new MeshStandardMaterial({ color: item.color, roughness: 0.38, metalness: 0.1 });
  } else if (item.shape.kind === 'ellipsoid') {
    geometry = new SphereGeometry(1, 32, 20);
    scale = [...item.shape.radii];
    material = new MeshStandardMaterial({ color: item.color, roughness: 0.36, metalness: 0.12 });
  } else if (item.shape.kind === 'plane') {
    geometry = new PlaneGeometry(item.shape.size[0] * 2, item.shape.size[1] * 2);
    // Translucent and depth-neutral so the reference grid and contact points stay readable through supports.
    material = new MeshStandardMaterial({ color: item.color, roughness: 0.7, metalness: 0, transparent: true, opacity: 0.42, depthWrite: false, side: 2 });
  } else {
    geometry = new SphereGeometry(0.045, 12, 8);
    material = new MeshBasicMaterial({ color: item.color, transparent: true, opacity: 0.9 });
  }
  const mesh = new Mesh(geometry, material);
  mesh.scale.set(...scale);
  if (item.shape.kind === 'box') {
    const edges = new LineSegments(new EdgesGeometry(geometry), new LineBasicMaterial({ color: new Color(item.color).multiplyScalar(0.03) }));
    edges.renderOrder = 1;
    material.polygonOffset = true;
    material.polygonOffsetFactor = 1;
    material.polygonOffsetUnits = 1;
    mesh.add(edges);
  }
  return mesh;
}

function createVisualSet(items: RenderItem[], movingIds: Set<string>): VisualSet {
  if (items.length === 0) throw new Error('The runtime returned no renderable scene items.');
  const group = new Group();
  const objects = new Map<string, Object3D>();
  const lines = new Map<string, Line>();
  const tendons = new Map<string, TendonVisual>();
  const tracks: Track[] = [];
  const marked: Marked[] = [];
  const planes: Mesh[] = [];
  const markerGeometry = new BufferGeometry();
  markerGeometry.setAttribute('position', new BufferAttribute(new Float32Array(items.length * 3), 3).setUsage(DynamicDrawUsage));
  markerGeometry.setAttribute('color', new BufferAttribute(new Float32Array(items.length * 3), 3).setUsage(DynamicDrawUsage));
  markerGeometry.setDrawRange(0, 0);
  const markerBatch = new Points(markerGeometry, new PointsMaterial({
    vertexColors: true, size: 18, sizeAttenuation: false, map: markerTexture(), transparent: true, depthTest: false, depthWrite: false,
  }));
  markerBatch.frustumCulled = false;
  markerBatch.renderOrder = 3;
  group.add(markerBatch);
  const pickTargets: PickTarget[] = [];
  try {
    for (const item of items) {
      if (objects.has(item.id)) throw new Error(`The runtime returned a duplicate render ID: ${item.id}.`);
      const object = createVisual(item);
      object.visible = item.visible !== false;
      if (object instanceof TendonVisual) {
        tendons.set(item.id, object);
        if (item.selectable !== false) pickTargets.push({ entityId: item.entityId, object, pickLine: object.pickLine });
      } else if (object instanceof Line) {
        object.position.set(0, 0, 0);
        object.quaternion.identity();
        lines.set(item.id, object);
      } else {
        object.position.set(item.position[0], item.position[1], item.position[2]);
        object.quaternion.set(item.quaternion[0], item.quaternion[1], item.quaternion[2], item.quaternion[3]);
        if (object instanceof Mesh && object.geometry instanceof PlaneGeometry) planes.push(object);
        else if (object instanceof Mesh) {
          const markerGeometry = new BufferGeometry();
          markerGeometry.setAttribute('position', new BufferAttribute(new Float32Array(3), 3));
          const marker = new Points(markerGeometry, new PointsMaterial({
            color: item.color, size: 18, sizeAttenuation: false, map: markerTexture(), transparent: true, depthTest: false, depthWrite: false,
          }));
          marker.renderOrder = 3;
          marker.frustumCulled = false;
          marker.visible = false;
          object.add(marker);
          object.geometry.computeBoundingSphere();
          const radius = (object.geometry.boundingSphere?.radius ?? 0) * Math.max(object.scale.x, object.scale.y, object.scale.z);
          marked.push({ entityId: item.entityId, object, marker, radius, color: new Color(item.color), surfaceVisible: true });
          pickTargets.push({ entityId: item.entityId, object, marker });
          if (movingIds.has(item.entityId)) {
            const positions = new Float32Array(TRAIL_CAPACITY * 3);
            const geometry = new BufferGeometry();
            geometry.setAttribute('position', new BufferAttribute(positions, 3).setUsage(DynamicDrawUsage));
            geometry.setDrawRange(0, 0);
            const trail = new Line(geometry, new LineBasicMaterial({ color: item.color, transparent: true, opacity: 0.65 }));
            trail.frustumCulled = false;
            group.add(trail);
            tracks.push({ object, trail, positions, count: 0, bounds: new Box3() });
          }
        }
      }
      if (object instanceof Line && item.selectable !== false) pickTargets.push({ entityId: item.entityId, object });
      objects.set(item.id, object);
      group.add(object);
    }
    const visuals = { group, objects, lines, tendons, tracks, marked, markerBatch, planes, pickTargets };
    clearTrails(visuals);
    return visuals;
  } catch (error) {
    disposeGroup(group);
    throw error;
  }
}

function recordTrails(visuals: VisualSet): void {
  for (const track of visuals.tracks) {
    track.trail.visible = track.object.visible;
    if (!track.object.visible) continue;
    const { x, y, z } = track.object.position;
    if (track.count > 0) {
      const last = (track.count - 1) * 3;
      if (Math.abs(track.positions[last] - x) + Math.abs(track.positions[last + 1] - y) + Math.abs(track.positions[last + 2] - z) < 1e-5) continue;
    }
    if (track.count === TRAIL_CAPACITY) {
      // Halve resolution instead of dropping the start, so a long flight keeps its whole path.
      const kept = Math.ceil(track.count / 2);
      for (let index = 1; index < kept; index += 1) track.positions.copyWithin(index * 3, index * 6, index * 6 + 3);
      track.count = kept;
    }
    const offset = track.count * 3;
    track.positions[offset] = x;
    track.positions[offset + 1] = y;
    track.positions[offset + 2] = z;
    track.count += 1;
    track.bounds.expandByPoint(track.object.position);
    track.trail.geometry.setDrawRange(0, track.count);
    track.trail.geometry.getAttribute('position').needsUpdate = true;
  }
}

function clearTrails(visuals: VisualSet): void {
  for (const track of visuals.tracks) {
    track.count = 0;
    track.bounds.makeEmpty();
    track.trail.geometry.setDrawRange(0, 0);
    track.trail.visible = track.object.visible;
  }
  recordTrails(visuals);
}

/** Bodies, cables and recorded paths; infinite planes contribute only their reference point. */
function sceneBounds(visuals: VisualSet): Box3 {
  const bounds = new Box3();
  const point = new Vector3();
  for (const object of visuals.objects.values()) {
    if (!object.visible) continue;
    if (object instanceof Mesh && object.geometry instanceof PlaneGeometry) bounds.expandByPoint(object.getWorldPosition(point));
    else bounds.expandByObject(object, !(object instanceof TendonVisual));
  }
  for (const track of visuals.tracks) if (track.object.visible) bounds.union(track.bounds);
  return bounds;
}

function framing(camera: PerspectiveCamera, bounds: Box3): { center: Vector3; distance: number; radius: number } {
  const center = bounds.getCenter(new Vector3());
  const radius = Math.max(bounds.getSize(new Vector3()).length() / 2, 0.75);
  const verticalHalfAngle = camera.fov * Math.PI / 360;
  const horizontalHalfAngle = Math.atan(Math.tan(verticalHalfAngle) * camera.aspect);
  return { center, radius, distance: radius * 1.2 / Math.sin(Math.min(verticalHalfAngle, horizontalHalfAngle)) };
}

function applyCameraRange(camera: PerspectiveCamera, distance: number): void {
  camera.near = Math.max(distance / 5000, 0.001);
  camera.far = Math.max(distance * 100, 100);
  camera.updateProjectionMatrix();
}

/** Grid and infinite-plane patches grow in powers of ten with the scene; returns the grid cell size in metres. */
function scaleReferences(visuals: VisualSet, grid: Object3D, radius: number): number {
  const scale = Math.max(1, 10 ** Math.ceil(Math.log10(radius / (GRID_SIZE / 2))));
  grid.scale.setScalar(scale);
  for (const plane of visuals.planes) plane.scale.set(scale, scale, 1);
  return GRID_SIZE / GRID_DIVISIONS * scale;
}


function applyFrame(items: RenderItem[], visuals: VisualSet): void {
  for (const item of items) {
    const tendon = visuals.tendons.get(item.id);
    if (tendon) {
      tendon.visible = item.visible !== false;
      tendon.update(item);
      continue;
    }
    const line = visuals.lines.get(item.id);
    if (line) {
      line.visible = item.visible !== false;
      const points = item.points;
      let position = line.geometry.getAttribute('position') as BufferAttribute;
      if (!points) {
        if (position.count > 0) throw new Error(`The runtime omitted line points during playback: ${item.id}.`);
        continue;
      }
      if (position.count !== points.length) {
        const geometry = new BufferGeometry();
        position = new BufferAttribute(new Float32Array(points.length * 3), 3).setUsage(DynamicDrawUsage);
        geometry.setAttribute('position', position);
        const previous = line.geometry;
        line.geometry = geometry;
        previous.dispose();
      }
      for (let index = 0; index < points.length; index += 1) {
        position.setXYZ(index, points[index][0], points[index][1], points[index][2]);
      }
      position.needsUpdate = true;
      continue;
    }
    const object = visuals.objects.get(item.id);
    if (!object) throw new Error(`The runtime changed render IDs during playback: ${item.id}.`);
    object.visible = item.visible !== false;
    object.position.set(item.position[0], item.position[1], item.position[2]);
    object.quaternion.set(item.quaternion[0], item.quaternion[1], item.quaternion[2], item.quaternion[3]);
  }
  for (const track of visuals.tracks) track.trail.visible = track.object.visible;
}

/** Snaps to the default viewing direction; returns the framed radius. */
function fitCamera(camera: PerspectiveCamera, controls: OrbitControls, visuals: VisualSet, direction = initialCameraDirection): number {
  const { center, distance, radius } = framing(camera, sceneBounds(visuals));
  camera.position.copy(center).addScaledVector(direction, distance);
  applyCameraRange(camera, distance);
  controls.target.copy(center);
  controls.update();
  return radius;
}

function fitCameraPreset(
  camera: PerspectiveCamera,
  controls: OrbitControls,
  visuals: VisualSet,
  view: InspectionView,
  bounds = sceneBounds(visuals),
): number {
  const { center, distance, radius } = framing(camera, bounds);
  camera.up.set(0, 0, 1);
  const direction = view === 'overview'
    ? initialCameraDirection
    : view === 'front' ? new Vector3(0, -1, 0)
      : view === 'side' ? new Vector3(1, 0, 0)
        : new Vector3(0, 0, 1);
  if (view === 'top') camera.up.set(0, 1, 0);
  camera.position.copy(center).addScaledVector(direction, distance);
  applyCameraRange(camera, distance);
  controls.target.copy(center);
  controls.update();
  return radius;
}

/** Eases toward framing everything, keeping the user's viewing direction; returns the framed radius. */
function followCamera(camera: PerspectiveCamera, controls: OrbitControls, visuals: VisualSet): number {
  const { center, distance, radius } = framing(camera, sceneBounds(visuals));
  const direction = camera.position.clone().sub(controls.target);
  const currentDistance = Math.max(direction.length(), 1e-6);
  direction.divideScalar(currentDistance);
  const nextDistance = currentDistance + (distance - currentDistance) * 0.18;
  controls.target.lerp(center, 0.18);
  camera.position.copy(controls.target).addScaledVector(direction, nextDistance);
  applyCameraRange(camera, nextDistance);
  controls.update();
  return radius;
}


export default function SimulationCanvas({
  experiment,
  replacementPending,
  onStatus,
  onReady,
  onSnapshot,
  onFailure,
  onBeforeRun,
  onPlaybackChange,
  playbackBlocked,
  runToken,
  clearToken,
  appearance,
  appearanceDisabled = false,
  appearanceSaving = false,
  onAppearanceChange,
  selectedEntityId,
  onSelectEntity,
  emptyContent,
  onInspectionController,
}: SimulationCanvasProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<WebGLRenderer | null>(null);
  const sceneRef = useRef<ThreeScene | null>(null);
  const environmentRef = useRef<SceneEnvironment | null>(null);
  const appearanceUploadPendingRef = useRef(false);
  const cameraRef = useRef<PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const visualSetRef = useRef<VisualSet | null>(null);
  const runtimeRef = useRef<MechanicsRuntime | null>(null);
  const activeIdRef = useRef<number | null>(null);
  const inspectionGenerationRef = useRef(0);
  const frameRequestRef = useRef<number | null>(null);
  const scheduleRef = useRef<(() => void) | null>(null);
  const runningRef = useRef(false);
  const speedRef = useRef(1);
  const lastFrameRef = useRef<number | null>(null);
  const lastFrameEndRef = useRef(0);
  const lastSnapshotRef = useRef(0);
  const callbacksRef = useRef({ onStatus, onReady, onSnapshot, onFailure, onBeforeRun, onPlaybackChange, onSelectEntity, onInspectionController });
  const experimentRef = useRef(experiment);
  const [running, setRunning] = useState(false);
  const [runPending, setRunPending] = useState(false);
  const runPendingRef = useRef(false);
  const runAttemptRef = useRef(0);
  const runTokenRef = useRef(runToken);
  const playbackBlockedRef = useRef(playbackBlocked);
  const clearTokenRef = useRef(clearToken);
  const [speed, setSpeed] = useState(1);
  const [time, setTime] = useState(0);
  const [preparing, setPreparing] = useState(false);
  const [canvasIssue, setCanvasIssue] = useState('');
  const [candidateError, setCandidateError] = useState('');
  const [environmentIssue, setEnvironmentIssue] = useState('');
  const environmentIssueRef = useRef('');
  const canvasIssueRef = useRef(canvasIssue);
  const preparingRef = useRef(preparing);
  const replacementPendingRef = useRef(replacementPending);
  const [pauseReason, setPauseReason] = useState('');
  const [follow, setFollow] = useState(true);
  const [throttled, setThrottled] = useState(false);
  const throttledRef = useRef(false);
  const lastThrottledAtRef = useRef(-Infinity);
  const followRef = useRef(true);
  const [followTarget, setFollowTarget] = useState<'all' | 'selection'>('all');
  const followTargetRef = useRef<'all' | 'selection'>('all');
  const followVisibleRef = useRef(false);
  const selectedRef = useRef<string | null>(selectedEntityId);
  const selectionHelperRef = useRef<Box3Helper | null>(null);
  const [objectChoices, setObjectChoices] = useState<{ id: string; label: string }[]>([]);
  const [gridCell, setGridCell] = useState(GRID_SIZE / GRID_DIVISIONS);
  const [interacted, setInteracted] = useState(false);
  const gridCellRef = useRef(GRID_SIZE / GRID_DIVISIONS);
  const gridRef = useRef<Object3D | null>(null);
  const axesRef = useRef<Object3D | null>(null);
  const viewDirectionRef = useRef(initialCameraDirection);
  // The grid and origin axes are one visual guide. Inspection captures keep the axes for orientation.
  const setGuides = useCallback((visible: boolean) => {
    if (gridRef.current) gridRef.current.visible = visible;
    if (axesRef.current) axesRef.current.visible = visible || Boolean(callbacksRef.current.onInspectionController);
  }, []);

  const rescaleReferences = useCallback((visuals: VisualSet, radius: number) => {
    const grid = gridRef.current;
    if (!grid) return;
    const cell = scaleReferences(visuals, grid, radius);
    if (cell !== gridCellRef.current) {
      environmentRef.current?.syncGround(visuals.planes);
      gridCellRef.current = cell;
      setGridCell(cell);
    }
  }, []);

  callbacksRef.current = { onStatus, onReady, onSnapshot, onFailure, onBeforeRun, onPlaybackChange, onSelectEntity, onInspectionController };
  experimentRef.current = experiment;
  canvasIssueRef.current = canvasIssue;
  preparingRef.current = preparing;
  replacementPendingRef.current = replacementPending;
  runTokenRef.current = runToken;
  playbackBlockedRef.current = playbackBlocked;


  const selectEntity = useCallback((id: string | null) => {
    if (selectedRef.current === id) return;
    if (followTargetRef.current === 'selection') {
      followRef.current = false;
      setFollow(false);
    }
    followVisibleRef.current = false;
    selectedRef.current = id;
    callbacksRef.current.onSelectEntity(id);
    scheduleRef.current?.();
  }, []);

  useEffect(() => { selectEntity(selectedEntityId); }, [selectedEntityId, selectEntity]);

  useEffect(() => {
    if (!appearance || !visualSetRef.current) return;
    environmentRef.current?.setAppearance(appearance, visualSetRef.current.planes);
    setGuides(appearance.grid);
    scheduleRef.current?.();
  }, [appearance, setGuides]);

  const focusSelection = useCallback(() => {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    const visuals = visualSetRef.current;
    const helper = selectionHelperRef.current;
    if (!camera || !controls || !visuals || !helper || !selectedRef.current) return false;
    const bounds = entityBounds(visuals.pickTargets, selectedRef.current, helper.box);
    if (bounds.isEmpty()) return false;
    const { center, distance } = framing(camera, bounds);
    const direction = camera.position.clone().sub(controls.target).normalize();
    if (direction.lengthSq() === 0) direction.copy(initialCameraDirection);
    camera.position.copy(center).addScaledVector(direction, distance);
    applyCameraRange(camera, distance);
    controls.target.copy(center);
    controls.update();
    scheduleRef.current?.();
    return true;
  }, []);
  const publishSnapshot = useCallback((id: number, runtime: MechanicsRuntime) => {
    const snapshot = runtime.snapshot();
    setTime(snapshot.time);
    callbacksRef.current.onSnapshot(id, snapshot);
  }, []);

  const captureInspectionFrame = useCallback(async (
    generation: number,
    id: number,
    runtime: MechanicsRuntime,
    requestedAt: number,
    view: InspectionView,
    focusId: string | null,
  ): Promise<CanvasInspectionCapture> => {
    if (!Number.isFinite(requestedAt) || requestedAt < 0) {
      throw new RangeError('Inspection time must be finite and nonnegative.');
    }
    if (!['overview', 'front', 'side', 'top'].includes(view)) throw new TypeError('The inspection camera view is invalid.');
    const assertCurrent = () => {
      if (generation !== inspectionGenerationRef.current
        || runtimeRef.current !== runtime
        || activeIdRef.current !== id
        || !callbacksRef.current.onInspectionController) {
        throw new Error('The inspection controller is stale because its scene is no longer active.');
      }
    };
    assertCurrent();
    if (runningRef.current || runPendingRef.current) throw new Error('Inspection requires ordinary playback to remain stopped.');
    if (document.hidden) throw new Error('Inspection cannot capture while the browser page is hidden.');
    if (preparingRef.current || replacementPendingRef.current || playbackBlockedRef.current || canvasIssueRef.current) {
      throw new Error('Inspection is unavailable while the current scene is paused or being replaced.');
    }
    const visuals = visualSetRef.current;
    if (!visuals) throw new Error('The current scene has no renderer geometry to inspect.');
    const requestedSteps = requestedAt / FIXED_TIMESTEP;
    const targetStep = Math.ceil(requestedSteps - Number.EPSILON * Math.max(1, requestedSteps) * 2);
    if (!Number.isSafeInteger(targetStep)) throw new RangeError('Inspection time is outside the exactly representable native-step horizon.');
    let currentStep = Math.round(runtime.time / FIXED_TIMESTEP);
    if (currentStep > targetStep) {
      throw new Error(`Inspection time ${requestedAt} is stale; the simulation has already advanced beyond it.`);
    }
    while (currentStep < targetStep) {
      assertCurrent();
      const result = runtime.advance(FIXED_TIMESTEP, 1);
      if (result.pauseReason) throw new Error(`Physics paused during visual inspection: ${result.pauseReason}`);
      if (result.steps !== 1) throw new Error('The native physics runtime did not advance by exactly one fixed step.');
      applyFrame(runtime.frame(), visuals);
      recordTrails(visuals);
      currentStep += 1;
    }
    assertCurrent();
    applyFrame(runtime.frame(), visuals);
    recordTrails(visuals);

    let focusedId: string | null = null;
    let focusNote: string | null = null;
    let focusBounds: Box3 | undefined;
    if (focusId) {
      const bounds = entityBounds(visuals.pickTargets, focusId, new Box3());
      if (bounds.isEmpty()) focusNote = `Focus ${focusId} is not currently visible; the scene was framed instead.`;
      else {
        focusedId = focusId;
        focusBounds = bounds;
      }
    }
    selectEntity(focusedId);
    followRef.current = false;
    setFollow(false);
    followTargetRef.current = 'all';
    setFollowTarget('all');
    followVisibleRef.current = false;

    const camera = cameraRef.current;
    const controls = controlsRef.current;
    const renderer = rendererRef.current;
    const scene = sceneRef.current;
    const viewport = viewportRef.current;
    const selectionHelper = selectionHelperRef.current;
    if (!camera || !controls || !renderer || !scene || !viewport || !selectionHelper) {
      throw new Error('The actual Three.js renderer is unavailable for visual inspection.');
    }
    rescaleReferences(visuals, fitCameraPreset(camera, controls, visuals, view, focusBounds));
    await environmentRef.current?.ready();
    assertCurrent();
    updateMarkers(visuals, camera, viewport.clientHeight, selectedRef.current, selectionColor);
    if (selectedRef.current) entityBounds(visuals.pickTargets, selectedRef.current, selectionHelper.box);
    selectionHelper.visible = selectedRef.current !== null && !selectionHelper.box.isEmpty();
    renderer.render(scene, camera);

    assertCurrent();
    const snapshot = runtime.snapshot();
    setTime(snapshot.time);
    callbacksRef.current.onSnapshot(id, snapshot);
    const tendonNote = runtime.scene.tendons.length ? 'Connector thickness, spring coils and slack curves are schematic, not collision geometry or a distributed material simulation. Color and arrows show relative signed branch force; native length and force values are authoritative.' : null;
    const extraNotes = [focusNote, environmentIssueRef.current, tendonNote].filter((note): note is string => Boolean(note));
    const notes = [...snapshot.notes.slice(0, 6 - extraNotes.length), ...extraNotes];
    return {
      simulatedAt: snapshot.time,
      focusedId,
      notes,
      snapshot,
      camera: {
        position: camera.position.toArray() as [number, number, number],
        target: controls.target.toArray() as [number, number, number],
      },
    };
  }, [rescaleReferences, selectEntity]);

  const invalidateRunStart = useCallback(() => {
    runAttemptRef.current += 1;
    if (!runPendingRef.current) return;
    runPendingRef.current = false;
    setRunPending(false);
  }, []);

  const stopSimulation = useCallback((reason: string, publish = true) => {
    const wasRunning = runningRef.current;
    runningRef.current = false;
    invalidateRunStart();
    lastFrameRef.current = null;
    setRunning(false);
    setPauseReason(reason);
    const runtime = runtimeRef.current;
    const id = activeIdRef.current;
    if (publish && runtime && id !== null) publishSnapshot(id, runtime);
    if (wasRunning && id !== null) callbacksRef.current.onPlaybackChange(id, false);
    scheduleRef.current?.();
  }, [invalidateRunStart, publishSnapshot]);

  useEffect(() => {
    if (!replacementPending) return;
    invalidateRunStart();
    if (runningRef.current) stopSimulation('Paused while preparing a replacement experiment.');
  }, [replacementPending, invalidateRunStart, stopSimulation]);

  useEffect(() => {
    invalidateRunStart();
  }, [runToken, invalidateRunStart]);

  useEffect(() => {
    if (playbackBlocked && runningRef.current) stopSimulation('Paused because saved-scene retention could not be confirmed.');
    else if (playbackBlocked) invalidateRunStart();
  }, [playbackBlocked, invalidateRunStart, stopSimulation]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    let disposed = false;
    let renderer: WebGLRenderer;
    let scene: ThreeScene;
    let camera: PerspectiveCamera;
    let controls: OrbitControls;
    try {
      renderer = new WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
      rendererRef.current = renderer;
      renderer.outputColorSpace = SRGBColorSpace;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.domElement.className = 'simulation-canvas__webgl';
      renderer.domElement.tabIndex = 0;
      renderer.domElement.setAttribute('aria-label', 'Three-dimensional mechanics preview. Focus and use arrow keys to pan; drag to orbit, scroll to zoom, and right-drag to pan.');
      scene = new ThreeScene();
      scene.background = new Color(0xe4e9e8);
      camera = new PerspectiveCamera(44, 1, 0.01, 1000);
      camera.up.set(0, 0, 1);
      camera.position.set(7, -9, 6);
      controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = false;
      controls.screenSpacePanning = false;
      controls.minDistance = 0.05;
      controls.maxDistance = 10000;
      controls.target.set(0, 0, 0);
      controls.listenToKeyEvents(renderer.domElement);
      environmentRef.current = new SceneEnvironment(scene, renderer, upload => {
        if (upload) {
          lastFrameRef.current = null;
          appearanceUploadPendingRef.current = true;
        }
        scheduleRef.current?.();
      }, message => {
        environmentIssueRef.current = message;
        setEnvironmentIssue(message);
      });
      environmentRef.current.setAppearance(DEFAULT_APPEARANCE, []);
      const grid = new GridHelper(12, 24, 0x8d9b99, 0xc6cfcd);
      grid.rotation.x = Math.PI / 2;
      grid.renderOrder = 1;
      grid.position.z = 0.002; // Keep the visual reference above z=0 supports, without z-fighting.
      grid.material.transparent = true;
      grid.material.opacity = 0.6;
      grid.material.depthWrite = false;
      grid.visible = DEFAULT_APPEARANCE.grid;
      scene.add(grid);
      gridRef.current = grid;
      const axes = new AxesHelper(1);
      for (const material of Array.isArray(axes.material) ? axes.material : [axes.material]) {
        material.transparent = true;
        material.opacity = 0.82;
      }
      axes.visible = DEFAULT_APPEARANCE.grid || Boolean(callbacksRef.current.onInspectionController);
      scene.add(axes);
      axesRef.current = axes;
      const selectionHelper = new Box3Helper(new Box3(), selectionColor);
      selectionHelper.visible = false;
      selectionHelper.renderOrder = 4;
      for (const material of Array.isArray(selectionHelper.material) ? selectionHelper.material : [selectionHelper.material]) material.depthTest = false;
      scene.add(selectionHelper);
      selectionHelperRef.current = selectionHelper;
      const followedPosition = new Vector3();
      viewport.append(renderer.domElement);
      sceneRef.current = scene;
      cameraRef.current = camera;
      controlsRef.current = controls;

      const resize = () => {
        const width = viewport.clientWidth;
        const height = viewport.clientHeight;
        if (width <= 0 || height <= 0) return;
        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        scheduleRef.current?.();
      };
      const observer = new ResizeObserver(resize);
      observer.observe(viewport);
      controls.update();
      resize();

      const pauseForGap = (reason: string) => {
        if (!runningRef.current) return;
        stopSimulation(reason);
      };
      const tick = (timestamp: number) => {
        frameRequestRef.current = null;
        if (disposed) return;
        if (runningRef.current) {
          const previous = lastFrameRef.current;
          lastFrameRef.current = timestamp;
          if (document.hidden) {
            pauseForGap('Paused because the page became hidden. Resume when you return to the lab.');
          } else if (previous !== null) {
            const wallSeconds = browserFrameSeconds(previous, lastFrameEndRef.current, timestamp);
            if (wallSeconds === null) {
              pauseForGap('Paused because the browser frame gap exceeded 0.25 seconds. Resume to continue without hidden catch-up.');
            } else {
              const runtime = runtimeRef.current;
              const id = activeIdRef.current;
              const visuals = visualSetRef.current;
              if (runtime && id !== null && visuals) {
                try {
                  const result = runtime.advance(wallSeconds, speedRef.current, 10);
                  applyFrame(runtime.frame(), visuals);
                  if (result.throttled) lastThrottledAtRef.current = timestamp;
                  const nowThrottled = timestamp - lastThrottledAtRef.current < 2000;
                  if (nowThrottled !== throttledRef.current) {
                    throttledRef.current = nowThrottled;
                    setThrottled(nowThrottled);
                  }
                  recordTrails(visuals);
                  if (followRef.current && followTargetRef.current === 'all') {
                    rescaleReferences(visuals, followCamera(camera, controls, visuals));
                  } else if (followRef.current && selectedRef.current) {
                    entityBounds(visuals.pickTargets, selectedRef.current, selectionHelper.box);
                    if (!selectionHelper.box.isEmpty()) {
                      if (!followVisibleRef.current) focusSelection();
                      else {
                        selectionHelper.box.getCenter(followedPosition);
                        camera.position.add(followedPosition).sub(controls.target);
                        controls.target.copy(followedPosition);
                        controls.update();
                      }
                      followVisibleRef.current = true;
                    } else followVisibleRef.current = false;
                  }
                  if (result.pauseReason) {
                    stopSimulation(result.pauseReason);
                  } else if (result.steps > 0 && timestamp - lastSnapshotRef.current >= 50) {
                    lastSnapshotRef.current = timestamp;
                    publishSnapshot(id, runtime);
                  }
                } catch (error) {
                  stopSimulation(`Paused because the runtime could not advance safely: ${describeError(error)}`, false);
                }
              }
            }
          }
        }
        const activeRenderer = rendererRef.current;
        const activeScene = sceneRef.current;
        const activeCamera = cameraRef.current;
        if (activeRenderer && activeScene && activeCamera) {
          try {
            const visuals = visualSetRef.current;
            if (visuals) {
              updateMarkers(visuals, activeCamera, viewport.clientHeight, selectedRef.current, selectionColor);
              if (selectedRef.current) entityBounds(visuals.pickTargets, selectedRef.current, selectionHelper.box);
              selectionHelper.visible = selectedRef.current !== null && !selectionHelper.box.isEmpty();
            } else selectionHelper.visible = false;
            activeRenderer.render(activeScene, activeCamera);
            if (appearanceUploadPendingRef.current) {
              // Texture upload is visual work, not elapsed simulation time or a hidden-tab gap.
              lastFrameRef.current = null;
              appearanceUploadPendingRef.current = false;
            }
          } catch (error) {
            setCanvasIssue(`WebGL could not draw the preview: ${describeError(error)}`);
            if (runningRef.current) stopSimulation('Paused because WebGL could not draw the preview.', false);
          }
        }
        lastFrameEndRef.current = performance.now();
        // Camera updates inside this frame can already have scheduled the next one; never run two loops.
        if (runningRef.current && frameRequestRef.current === null) frameRequestRef.current = requestAnimationFrame(tick);
      };
      scheduleRef.current = () => {
        if (!disposed && frameRequestRef.current === null) frameRequestRef.current = requestAnimationFrame(tick);
      };
      controls.addEventListener('change', () => scheduleRef.current?.());
      const stopFollowing = () => {
        followRef.current = false;
        setFollow(false);
      };
      const picker = new ScenePicker();
      const pointers = new Map<number, { x: number; y: number }>();
      let downX = 0;
      let downY = 0;
      let dragged = false;
      let panning = false;
      let downEntity: string | null = null;
      let downScene: number | null = null;
      let touchCenterX = 0;
      let touchCenterY = 0;
      let touchDistance = 0;
      const pointerDown = (event: PointerEvent) => {
        pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (pointers.size > 1) {
          dragged = true;
          if (followTargetRef.current !== 'selection' || pointers.size !== 2) stopFollowing();
          const contacts = pointers.values();
          const first = contacts.next().value!;
          const second = contacts.next().value!;
          touchCenterX = (first.x + second.x) / 2;
          touchCenterY = (first.y + second.y) / 2;
          touchDistance = Math.hypot(first.x - second.x, first.y - second.y);
          return;
        }
        downX = event.clientX;
        downY = event.clientY;
        dragged = event.button !== 0;
        panning = event.button === 2 || event.ctrlKey || event.metaKey || event.shiftKey;
        downScene = activeIdRef.current;
        const rect = renderer.domElement.getBoundingClientRect();
        const visuals = visualSetRef.current;
        downEntity = visuals ? picker.pick(visuals.pickTargets, camera, rect.width, rect.height, event.clientX - rect.left, event.clientY - rect.top, event.pointerType === 'touch' ? 22 : 14) : null;
      };
      const pointerMove = (event: PointerEvent) => {
        const pointer = pointers.get(event.pointerId);
        if (!pointer) return;
        pointer.x = event.clientX;
        pointer.y = event.clientY;
        if (pointers.size === 2) {
          const contacts = pointers.values();
          const first = contacts.next().value!;
          const second = contacts.next().value!;
          const pan = Math.hypot((first.x + second.x) / 2 - touchCenterX, (first.y + second.y) / 2 - touchCenterY);
          const pinch = Math.abs(Math.hypot(first.x - second.x, first.y - second.y) - touchDistance);
          if (pan > 6 && pinch < pan * 1.5) stopFollowing();
          return;
        }
        if (Math.hypot(event.clientX - downX, event.clientY - downY) > 6) {
          dragged = true;
          if (followTargetRef.current !== 'selection' || panning) stopFollowing();
        }
      };
      const pointerUp = (event: PointerEvent) => {
        if (pointers.has(event.pointerId) && pointers.size === 1 && !dragged
          && Math.hypot(event.clientX - downX, event.clientY - downY) <= 6
          && downScene === activeIdRef.current && !preparingRef.current && !replacementPendingRef.current) {
          selectEntity(downEntity);
        }
        pointers.delete(event.pointerId);
      };
      const pointerCancel = (event: PointerEvent) => { pointers.delete(event.pointerId); dragged = true; };
      const keyboardNavigation = (event: KeyboardEvent) => { if (event.key.startsWith('Arrow')) stopFollowing(); };
      const wheelNavigation = () => { if (followTargetRef.current !== 'selection') stopFollowing(); };
      renderer.domElement.addEventListener('pointerdown', pointerDown, true);
      renderer.domElement.addEventListener('pointermove', pointerMove, true);
      renderer.domElement.addEventListener('pointerup', pointerUp, true);
      renderer.domElement.addEventListener('pointercancel', pointerCancel, true);
      renderer.domElement.addEventListener('wheel', wheelNavigation, { passive: true });
      renderer.domElement.addEventListener('keydown', keyboardNavigation, true);
      scheduleRef.current?.();

      const onVisibility = () => {
        if (!document.hidden) return;
        invalidateRunStart();
        if (runningRef.current) stopSimulation('Paused because the page became hidden. Resume when you return to the lab.');
      };
      document.addEventListener('visibilitychange', onVisibility);
      const onContextLost = (event: Event) => {
        event.preventDefault();
        const message = 'WebGL context was lost. The preview is unavailable until the page is reloaded.';
        setCanvasIssue(message);
        invalidateRunStart();
        if (runningRef.current) stopSimulation(message, false);
        const pending = experimentRef.current;
        if (pending) callbacksRef.current.onFailure(pending.id, message);
      };
      renderer.domElement.addEventListener('webglcontextlost', onContextLost);

      return () => {
        disposed = true;
        observer.disconnect();
        document.removeEventListener('visibilitychange', onVisibility);
        renderer.domElement.removeEventListener('webglcontextlost', onContextLost);
        renderer.domElement.removeEventListener('pointerdown', pointerDown, true);
        renderer.domElement.removeEventListener('pointermove', pointerMove, true);
        renderer.domElement.removeEventListener('pointerup', pointerUp, true);
        renderer.domElement.removeEventListener('pointercancel', pointerCancel, true);
        renderer.domElement.removeEventListener('wheel', wheelNavigation);
        renderer.domElement.removeEventListener('keydown', keyboardNavigation, true);
        selectionHelper.geometry.dispose();
        for (const material of Array.isArray(selectionHelper.material) ? selectionHelper.material : [selectionHelper.material]) material.dispose();
        selectionHelperRef.current = null;
        if (frameRequestRef.current !== null) cancelAnimationFrame(frameRequestRef.current);
        frameRequestRef.current = null;
        runAttemptRef.current += 1;
        runPendingRef.current = false;
        runningRef.current = false;
        controls.dispose();
        runtimeRef.current?.dispose();
        runtimeRef.current = null;
        grid.geometry.dispose();
        for (const material of Array.isArray(grid.material) ? grid.material : [grid.material]) material.dispose();
        axes.geometry.dispose();
        for (const material of Array.isArray(axes.material) ? axes.material : [axes.material]) material.dispose();
        environmentRef.current?.dispose();
        environmentRef.current = null;
        if (visualSetRef.current) disposeGroup(visualSetRef.current.group);
        visualSetRef.current = null;
        renderer.dispose();
        renderer.forceContextLoss();
        renderer.domElement.remove();
        rendererRef.current = null;
        sceneRef.current = null;
        cameraRef.current = null;
        controlsRef.current = null;
        scheduleRef.current = null;
      };
    } catch (error) {
      const message = `WebGL renderer unavailable: ${describeError(error)}`;
      environmentRef.current?.dispose();
      environmentRef.current = null;
      rendererRef.current?.dispose();
      rendererRef.current?.domElement.remove();
      rendererRef.current = null;
      setCanvasIssue(message);
      const pending = experimentRef.current;
      if (pending) callbacksRef.current.onFailure(pending.id, message);
      return () => {
        disposed = true;
        runAttemptRef.current += 1;
        runPendingRef.current = false;
        rendererRef.current?.dispose();
        rendererRef.current?.domElement.remove();
        rendererRef.current = null;
      };
    }
  }, [invalidateRunStart, publishSnapshot, stopSimulation, selectEntity, focusSelection]);

  useEffect(() => {
    if (!experiment) return;
    const inspectionGeneration = ++inspectionGenerationRef.current;
    callbacksRef.current.onInspectionController?.(null);
    invalidateRunStart();
    let canceled = false;
    let candidateRuntime: MechanicsRuntime | null = null;
    let candidateVisuals: VisualSet | null = null;
    const id = experiment.id;
    setPreparing(true);
    setCandidateError('');
    callbacksRef.current.onStatus(id, 'Loading and compiling the replacement MuJoCo model.');
    if (runningRef.current) stopSimulation('Paused while preparing a replacement model.');

    void (async () => {
      try {
        if (!rendererRef.current || !sceneRef.current || !cameraRef.current || !controlsRef.current) {
          throw new Error(canvasIssueRef.current || 'WebGL is unavailable, so the preview cannot be prepared.');
        }
        candidateRuntime = await createRuntime(experiment.scene);
        if (canceled) {
          candidateRuntime.dispose();
          candidateRuntime = null;
          return;
        }
        callbacksRef.current.onStatus(id, 'Building render meshes from the prepared runtime geometry.');
        const movingIds = new Set(experiment.scene.bodies.filter(body => body.motion.kind !== 'fixed').map(body => body.id));
        candidateVisuals = createVisualSet(candidateRuntime.frame(), movingIds);
        const initialSnapshot = candidateRuntime.snapshot();
        const renderer = rendererRef.current;
        const scene = sceneRef.current;
        const camera = cameraRef.current;
        const controls = controlsRef.current;
        if (!renderer || !scene || !camera || !controls) throw new Error('The WebGL renderer stopped before the preview was ready.');
        if (canceled) return;

        if (!candidateRuntime || !candidateVisuals) throw new Error('The replacement preview was incomplete.');
        const previousRuntime = runtimeRef.current;
        const previousVisuals = visualSetRef.current;
        const previousPosition = camera.position.clone();
        const previousTarget = controls.target.clone();
        const previousNear = camera.near;
        const previousFar = camera.far;
        scene.add(candidateVisuals.group);
        try {
          rescaleReferences(candidateVisuals, fitCamera(camera, controls, candidateVisuals, cameraDirection(experiment.view)));
          environmentRef.current?.setAppearance(experiment.scene.appearance, candidateVisuals.planes);
          setGuides(experiment.scene.appearance.grid);
          updateMarkers(candidateVisuals, camera, viewportRef.current?.clientHeight ?? 640, null, selectionColor);
          renderer.render(scene, camera);
          if (previousVisuals) scene.remove(previousVisuals.group);
          renderer.render(scene, camera);
        } catch (error) {
          scene.remove(candidateVisuals.group);
          if (previousVisuals) scene.add(previousVisuals.group);
          camera.position.copy(previousPosition);
          camera.near = previousNear;
          camera.far = previousFar;
          camera.updateProjectionMatrix();
          controls.target.copy(previousTarget);
          controls.update();
          environmentRef.current?.setAppearance(appearance ?? DEFAULT_APPEARANCE, previousVisuals?.planes ?? []);
          setGuides((appearance ?? DEFAULT_APPEARANCE).grid);
          try { renderer.render(scene, camera); } catch { /* Keep the previous runtime alive if WebGL has failed. */ }
          throw error;
        }

        const installedRuntime = candidateRuntime;
        if (!installedRuntime) throw new Error('The replacement runtime was not initialized.');
        runtimeRef.current = installedRuntime;
        viewDirectionRef.current = cameraDirection(experiment.view);
        visualSetRef.current = candidateVisuals;
        activeIdRef.current = id;
        selectEntity(null);
        followRef.current = true;
        setFollow(true);
        followTargetRef.current = 'all';
        setFollowTarget('all');
        followVisibleRef.current = false;
        const pickableIds = new Set(candidateVisuals.pickTargets.map(target => target.entityId));
        setObjectChoices(initialSnapshot.entities.filter(entity => pickableIds.has(entity.id)).map(entity => ({ id: entity.id, label: entity.label })));
        candidateRuntime = null;
        candidateVisuals = null;
        setPreparing(false);
        setRunning(false);
        runningRef.current = false;
        setPauseReason('');
        lastFrameRef.current = null;
        setTime(initialSnapshot.time);
        lastSnapshotRef.current = performance.now();
        callbacksRef.current.onInspectionController?.({
          capture: (time, view, focusId) => captureInspectionFrame(inspectionGeneration, id, installedRuntime, time, view, focusId),
        });
        callbacksRef.current.onReady(experiment, initialSnapshot);
        scheduleRef.current?.();
        try { if (previousVisuals) disposeGroup(previousVisuals.group); }
        catch (error) { setCandidateError(`Previous render resources could not be fully released: ${describeError(error)}`); }
        try { previousRuntime?.dispose(); }
        catch (error) { setCandidateError(`Previous model runtime could not be fully released: ${describeError(error)}`); }
      } catch (error) {
        candidateRuntime?.dispose();
        if (candidateVisuals) disposeGroup(candidateVisuals.group);
        candidateRuntime = null;
        candidateVisuals = null;
        if (canceled) return;
        setPreparing(false);
        const message = describeError(error);
        if (rendererRef.current?.getContext().isContextLost()) {
          setCanvasIssue(`WebGL context was lost while preparing the preview: ${message}`);
        } else {
          setCandidateError(message);
        }
        callbacksRef.current.onFailure(id, message);
        scheduleRef.current?.();
      }
    })();

    return () => {
      canceled = true;
      invalidateRunStart();
      setPreparing(false);
      candidateRuntime?.dispose();
      if (candidateVisuals) disposeGroup(candidateVisuals.group);
    };
  }, [experiment, invalidateRunStart, stopSimulation, captureInspectionFrame]);

  useEffect(() => {
    if (clearTokenRef.current === clearToken) return;
    clearTokenRef.current = clearToken;
    inspectionGenerationRef.current += 1;
    callbacksRef.current.onInspectionController?.(null);
    invalidateRunStart();
    if (runningRef.current) stopSimulation('Paused because the current scene was closed.', false);
    setCandidateError('');
    const visuals = visualSetRef.current;
    const runtime = runtimeRef.current;
    activeIdRef.current = null;
    selectEntity(null);
    setObjectChoices([]);
    visualSetRef.current = null;
    runtimeRef.current = null;
    environmentRef.current?.syncGround([]);
    if (visuals) {
      sceneRef.current?.remove(visuals.group);
      try { disposeGroup(visuals.group); }
      catch (error) { setCandidateError(`Render resources could not be fully released: ${describeError(error)}`); }
    }
    try { runtime?.dispose(); }
    catch (error) { setCandidateError(`The model runtime could not be fully released: ${describeError(error)}`); }
    setPreparing(false);
    setRunning(false);
    setTime(0);
    setPauseReason('');
    setThrottled(false);
    throttledRef.current = false;
    scheduleRef.current?.();
  }, [clearToken, invalidateRunStart, stopSimulation]);

  const updateSpeed = (value: string) => {
    const next = Number(value);
    if (Number.isFinite(next)) {
      speedRef.current = next;
      setSpeed(next);
    }
  };

  const toggleRunning = async () => {
    if (callbacksRef.current.onInspectionController) return;
    const runtime = runtimeRef.current;
    const id = activeIdRef.current;
    if (!runtime || id === null || preparingRef.current || replacementPendingRef.current || playbackBlockedRef.current || canvasIssueRef.current) return;
    if (runningRef.current) {
      stopSimulation('Paused. Values show the current state.');
      return;
    }
    if (runPendingRef.current) return;
    if (document.hidden) {
      setPauseReason('The page is hidden. Return to the lab before running the simulation.');
      return;
    }
    const attempt = ++runAttemptRef.current;
    const requestToken = runTokenRef.current;
    runPendingRef.current = true;
    setRunPending(true);
    setPauseReason('Checking saved-scene retention before running.');
    try {
      const allowed = await callbacksRef.current.onBeforeRun(id);
      if (attempt !== runAttemptRef.current || requestToken !== runTokenRef.current) return;
      if (!allowed) {
        setPauseReason('Scene retention could not be confirmed. Retry the local scene request before running.');
        return;
      }
      if (activeIdRef.current !== id
        || runtimeRef.current !== runtime
        || preparingRef.current
        || replacementPendingRef.current
        || playbackBlockedRef.current
        || document.hidden) return;
      setPauseReason('');
      runningRef.current = true;
      setRunning(true);
      lastFrameRef.current = null;
      callbacksRef.current.onPlaybackChange(id, true);
      scheduleRef.current?.();
    } catch (error) {
      if (attempt === runAttemptRef.current) setPauseReason(`Could not confirm saved-scene retention: ${describeError(error)}`);
    } finally {
      if (attempt === runAttemptRef.current) {
        runPendingRef.current = false;
        setRunPending(false);
      }
    }
  };

  const resetSimulation = () => {
    const runtime = runtimeRef.current;
    const visuals = visualSetRef.current;
    const id = activeIdRef.current;
    if (!runtime || !visuals || id === null || preparingRef.current || replacementPendingRef.current || canvasIssueRef.current) return;
    stopSimulation('Reset to the initial conditions. Press Run to repeat the experiment.', false);
    try {
      runtime.reset();
      applyFrame(runtime.frame(), visuals);
      clearTrails(visuals);
      selectEntity(null);
      followRef.current = true;
      setFollow(true);
      publishSnapshot(id, runtime);
      setCandidateError('');
      fitView();
    } catch (error) {
      setCandidateError(`Could not reset the model: ${describeError(error)}`);
    }
  };

  const toggleFollow = () => {
    const next = !followRef.current || followTargetRef.current !== 'all';
    followRef.current = next;
    setFollow(next);
    followTargetRef.current = 'all';
    setFollowTarget('all');
    followVisibleRef.current = false;
    if (next && !runningRef.current) fitView();
  };

  const toggleSelectedFollow = () => {
    const next = !(followRef.current && followTargetRef.current === 'selection');
    followTargetRef.current = 'selection';
    setFollowTarget('selection');
    followRef.current = next;
    setFollow(next);
    followVisibleRef.current = next && focusSelection();
    scheduleRef.current?.();
  };

  const fitView = () => {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    const visuals = visualSetRef.current;
    if (!camera || !controls || !visuals || preparingRef.current) return;
    followTargetRef.current = 'all';
    setFollowTarget('all');
    followVisibleRef.current = false;
    rescaleReferences(visuals, fitCamera(camera, controls, visuals, viewDirectionRef.current));
    scheduleRef.current?.();
  };
  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      const target = event.target;
      if (event.isComposing || event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
      if (document.querySelector('dialog[open]')) return;
      if (event.code === 'Escape' && !(target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable="true"]'))) {
        selectEntity(null);
        rendererRef.current?.domElement.focus({ preventScroll: true });
        return;
      }
      if (target instanceof HTMLElement && (
        target.isContentEditable || target.closest('input, textarea, select, button, summary, a, [contenteditable="true"]')
      )) return;
      if (event.code === 'Space' && !callbacksRef.current.onInspectionController && runtimeRef.current && !preparingRef.current && !replacementPendingRef.current && !playbackBlockedRef.current && !canvasIssueRef.current) {
        event.preventDefault();
        void toggleRunning();
      } else if (event.code === 'KeyR' && runtimeRef.current && !preparingRef.current && !replacementPendingRef.current && !canvasIssueRef.current) {
        event.preventDefault();
        resetSimulation();
      } else if (event.code === 'KeyF' && runtimeRef.current && !preparingRef.current) {
        event.preventDefault();
        fitView();
      }
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, []);

  const selectedChoice = objectChoices.find(choice => choice.id === selectedEntityId);
  const selectedVisible = Boolean(selectedEntityId && visualSetRef.current?.pickTargets.some(target => target.entityId === selectedEntityId && target.object.visible));
  const hasRuntime = Boolean(runtimeRef.current);
  const statusText = canvasIssue || candidateError || pauseReason || (preparing ? 'Preparing a paused replacement.' : running ? (throttled ? 'Running below the selected speed on this device. No physics steps are skipped.' : 'Running. Values and graphs update as it moves.') : hasRuntime ? 'Paused at the start. Press Run to begin.' : 'The experiment opens paused.');
  const notice = canvasIssue || candidateError || (pauseReason && !ROUTINE_PAUSES.has(pauseReason) ? pauseReason : '');
  const speedOptions = SPEED_OPTIONS.includes(speed) ? SPEED_OPTIONS : [...SPEED_OPTIONS, speed].sort((a, b) => a - b);

  return (
    <div className="simulation-frame">
      <div className="simulation-viewport" ref={viewportRef} onPointerDown={event => { if (!interacted && event.target instanceof HTMLCanvasElement) setInteracted(true); }}>
        {hasRuntime ? (
          <div className="canvas-tools" role="toolbar" aria-label="View">
            {onAppearanceChange ? <AppearanceControls
              value={appearance ?? DEFAULT_APPEARANCE}
              onChange={onAppearanceChange}
              disabled={appearanceDisabled || preparing || replacementPending}
              saving={appearanceSaving}
            /> : null}
            <button className="icon-button" type="button" onClick={toggleFollow} aria-pressed={follow && followTarget === 'all'} aria-label="Follow moving objects" title="Follow moving objects">
              <Crosshair size={18} aria-hidden="true" />
            </button>
            <button className="icon-button" type="button" onClick={fitView} disabled={preparing} title="Fit everything in view (F)" aria-label="Fit view" aria-keyshortcuts="F">
              <CornersOut size={18} aria-hidden="true" />
            </button>
          </div>
        ) : null}
        {selectedChoice ? (
          <div className="selection-pill" role="group" aria-label={`Selected: ${selectedChoice.label}`}>
            <span className="selection-pill__label">{selectedChoice.label}</span>
            {!selectedVisible ? <span className="selection-pill__state" role="status">Not visible yet</span> : null}
            <button className="pill-button" type="button" disabled={!selectedVisible || preparing} onClick={() => { followRef.current = false; setFollow(false); focusSelection(); }}>Focus</button>
            <button className="pill-button" type="button" aria-pressed={follow && followTarget === 'selection'} disabled={preparing} onClick={toggleSelectedFollow}>Follow</button>
            <button className="pill-button pill-button--icon" type="button" aria-label="Clear selection" onClick={() => { selectEntity(null); rendererRef.current?.domElement.focus({ preventScroll: true }); }}><X size={14} aria-hidden="true" /></button>
          </div>
        ) : null}
        {!hasRuntime ? (
          emptyContent && !preparing && !canvasIssue && !candidateError ? <div className="canvas-welcome">{emptyContent}</div> : (
            <div className="canvas-empty-state" role="status">
              {preparing ? <span className="spinner" aria-hidden="true" /> : null}
              <strong>{preparing ? 'Preparing the experiment' : canvasIssue || candidateError ? 'Preview unavailable' : 'Nothing here yet'}</strong>
              <p>{canvasIssue || candidateError || (preparing ? 'It opens paused, so you can look before it runs.' : 'Describe an experiment to build one.')}</p>
            </div>
          )
        ) : null}
        {preparing && hasRuntime ? <div className="replacement-indicator" role="status"><span className="spinner" aria-hidden="true" />Preparing the new version. This one stays paused until it is ready.</div> : null}
        {environmentIssue ? <div className="canvas-warning" role="status">{environmentIssue}</div> : null}
        {hasRuntime && !interacted && !selectedChoice ? <p className="canvas-help"><span className="hint-pointer">Drag to turn · Scroll to zoom · Click an object to inspect it</span><span className="hint-touch">Drag to turn · Pinch to zoom · Tap an object to inspect it</span></p> : null}
        {hasRuntime && (appearance ?? experiment?.scene.appearance ?? DEFAULT_APPEARANCE).grid ? <p className="grid-scale">Grid {gridCell} m</p> : null}
        {runtimeRef.current?.scene.tendons.length ? (
          <div className="tendon-legend" role="note" aria-label="Relative connector force: inward arrows show tension, outward arrows show compression. Slack curves are schematic.">
            <div>
              <span><i style={{ color: TENDON_TENSION_COLOR }}><ArrowRight size={13} aria-hidden="true" /><ArrowLeft size={13} aria-hidden="true" /></i>Tension</span>
              <span><i style={{ color: TENDON_COMPRESSION_COLOR }}><ArrowLeft size={13} aria-hidden="true" /><ArrowRight size={13} aria-hidden="true" /></i>Compression</span>
            </div>
            <small>Relative force · slack curves are schematic</small>
          </div>
        ) : null}
        {notice && hasRuntime ? <p className="canvas-toast" role="alert">{notice}</p> : null}
        {hasRuntime ? (
          <div className="transport" role="group" aria-label="Playback">
            <button className={`run-button ${running ? 'is-running' : ''}`} type="button" onClick={() => { void toggleRunning(); }} disabled={Boolean(onInspectionController) || preparing || replacementPending || runPending || playbackBlocked || Boolean(canvasIssue)} aria-keyshortcuts="Space" aria-busy={runPending} title={running ? 'Pause (Space)' : 'Run (Space)'}>
              {running ? <Pause size={18} weight="fill" aria-hidden="true" /> : <Play size={18} weight="fill" aria-hidden="true" />}
              <span>{runPending ? 'Checking' : running ? 'Pause' : 'Run'}</span>
            </button>
            <button className="transport__button" type="button" onClick={resetSimulation} disabled={preparing || replacementPending || Boolean(canvasIssue)} title="Back to the start (R)" aria-label="Reset to the start" aria-keyshortcuts="R">
              <ArrowCounterClockwise size={18} aria-hidden="true" />
            </button>
            {running && throttled ? <span className="transport__slow" title="This device cannot keep up with the selected speed, so the simulation plays slower. No steps are skipped.">Slow motion</span> : null}
            <output className="simulation-clock" aria-label="Simulated time" aria-live="off"><strong>{TIME_FORMAT.format(time)}</strong><small>s</small></output>
            <label className="speed-select" title="Playback speed">
              <span className="visually-hidden">Playback speed</span>
              <select value={speed} onChange={event => updateSpeed(event.target.value)}>
                {speedOptions.map(option => <option key={option} value={option}>{option}×</option>)}
              </select>
              <CaretDown size={12} weight="bold" aria-hidden="true" />
            </label>
          </div>
        ) : null}
      </div>
      <p className="visually-hidden" role="status" aria-live="polite">{statusText}</p>
    </div>
  );
}
