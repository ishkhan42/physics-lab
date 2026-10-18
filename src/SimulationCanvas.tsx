import { ArrowCounterClockwise, CornersOut, Crosshair, Pause, Play } from '@phosphor-icons/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CanvasTexture,
  AxesHelper,
  Box3,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CapsuleGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  DynamicDrawUsage,
  GridHelper,
  Group,
  HemisphereLight,
  Line,
  LineBasicMaterial,
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
import { createRuntime } from './physics/mujoco.ts';
import type { InspectionSnapshot, MechanicsRuntime, RenderItem } from './physics/types.ts';

export interface CanvasExperiment {
  id: number;
  scene: Scene;
  decision: Decision;
  userGroundChoice?: 'default' | 'none';
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
  physicalGround: boolean;
  groundDisabled: boolean;
  onPhysicalGroundChange: (enabled: boolean) => void;
}

interface Track {
  object: Object3D;
  trail: Line;
  positions: Float32Array;
  count: number;
  bounds: Box3;
}

interface Marked {
  object: Object3D;
  marker: Points;
  radius: number;
}

interface VisualSet {
  group: Group;
  objects: Map<string, Object3D>;
  lines: Map<string, Line>;
  tracks: Track[];
  marked: Marked[];
  planes: Mesh[];
}

const TRAIL_CAPACITY = 2048;
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
const TIME_FORMAT = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 5 });

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : 'An unknown rendering or runtime error occurred.';
}

function disposeGroup(group: Group): void {
  group.traverse(object => {
    if (!(object instanceof Mesh) && !(object instanceof Line) && !(object instanceof Points)) return;
    object.geometry.dispose();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) material.dispose();
  });
  group.removeFromParent();
}

function createVisual(item: RenderItem): Object3D {
  if (item.shape.kind === 'line') {
    const points = item.points ?? [];
    const geometry = new BufferGeometry();
    const positions = new Float32Array(points.length * 3);
    const attribute = new BufferAttribute(positions, 3).setUsage(DynamicDrawUsage);
    geometry.setAttribute('position', attribute);
    for (let index = 0; index < points.length; index += 1) {
      attribute.setXYZ(index, points[index][0], points[index][1], points[index][2]);
    }
    const line = new Line(geometry, new LineBasicMaterial({ color: item.color, transparent: true, opacity: 0.92 }));
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
  return mesh;
}

function createVisualSet(items: RenderItem[], movingIds: Set<string>): VisualSet {
  if (items.length === 0) throw new Error('The runtime returned no renderable scene items.');
  const group = new Group();
  const objects = new Map<string, Object3D>();
  const lines = new Map<string, Line>();
  const tracks: Track[] = [];
  const marked: Marked[] = [];
  const planes: Mesh[] = [];
  try {
    for (const item of items) {
      if (objects.has(item.id)) throw new Error(`The runtime returned a duplicate render ID: ${item.id}.`);
      const object = createVisual(item);
      if (object instanceof Line) {
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
          marked.push({ object, marker, radius });
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
      objects.set(item.id, object);
      group.add(object);
    }
    const visuals = { group, objects, lines, tracks, marked, planes };
    clearTrails(visuals);
    return visuals;
  } catch (error) {
    disposeGroup(group);
    throw error;
  }
}

function recordTrails(visuals: VisualSet): void {
  for (const track of visuals.tracks) {
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
    track.positions.set([x, y, z], track.count * 3);
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
  }
  recordTrails(visuals);
}

/** Bodies, cables and recorded paths; infinite planes contribute only their reference point. */
function sceneBounds(visuals: VisualSet): Box3 {
  const bounds = new Box3();
  const point = new Vector3();
  for (const object of visuals.objects.values()) {
    if (object instanceof Mesh && object.geometry instanceof PlaneGeometry) bounds.expandByPoint(object.getWorldPosition(point));
    else bounds.expandByObject(object, true);
  }
  for (const track of visuals.tracks) bounds.union(track.bounds);
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

function updateMarkers(visuals: VisualSet, camera: PerspectiveCamera, viewportHeight: number): void {
  const pixelsPerUnitAtOne = viewportHeight / 2 / Math.tan(camera.fov * Math.PI / 360);
  for (const item of visuals.marked) {
    const distance = Math.max(camera.position.distanceTo(item.object.position), 1e-6);
    item.marker.visible = item.radius * pixelsPerUnitAtOne / distance < 5;
  }
}

function applyFrame(items: RenderItem[], visuals: VisualSet): void {
  for (const item of items) {
    const line = visuals.lines.get(item.id);
    if (line) {
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
    object.position.set(item.position[0], item.position[1], item.position[2]);
    object.quaternion.set(item.quaternion[0], item.quaternion[1], item.quaternion[2], item.quaternion[3]);
  }
}

/** Snaps to the default viewing direction; returns the framed radius. */
function fitCamera(camera: PerspectiveCamera, controls: OrbitControls, visuals: VisualSet): number {
  const { center, distance, radius } = framing(camera, sceneBounds(visuals));
  camera.position.copy(center).addScaledVector(initialCameraDirection, distance);
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
  physicalGround,
  groundDisabled,
  onPhysicalGroundChange,
}: SimulationCanvasProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<WebGLRenderer | null>(null);
  const sceneRef = useRef<ThreeScene | null>(null);
  const cameraRef = useRef<PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const visualSetRef = useRef<VisualSet | null>(null);
  const runtimeRef = useRef<MechanicsRuntime | null>(null);
  const activeIdRef = useRef<number | null>(null);
  const frameRequestRef = useRef<number | null>(null);
  const scheduleRef = useRef<(() => void) | null>(null);
  const runningRef = useRef(false);
  const speedRef = useRef(1);
  const lastFrameRef = useRef<number | null>(null);
  const lastSnapshotRef = useRef(0);
  const callbacksRef = useRef({ onStatus, onReady, onSnapshot, onFailure, onBeforeRun, onPlaybackChange });
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
  const canvasIssueRef = useRef(canvasIssue);
  const preparingRef = useRef(preparing);
  const replacementPendingRef = useRef(replacementPending);
  const [pauseReason, setPauseReason] = useState('');
  const [follow, setFollow] = useState(true);
  const [throttled, setThrottled] = useState(false);
  const throttledRef = useRef(false);
  const lastThrottledAtRef = useRef(-Infinity);
  const followRef = useRef(true);
  const [gridCell, setGridCell] = useState(GRID_SIZE / GRID_DIVISIONS);
  const gridCellRef = useRef(GRID_SIZE / GRID_DIVISIONS);
  const gridRef = useRef<Object3D | null>(null);

  const rescaleReferences = (visuals: VisualSet, radius: number) => {
    const grid = gridRef.current;
    if (!grid) return;
    const cell = scaleReferences(visuals, grid, radius);
    if (cell !== gridCellRef.current) {
      gridCellRef.current = cell;
      setGridCell(cell);
    }
  };

  callbacksRef.current = { onStatus, onReady, onSnapshot, onFailure, onBeforeRun, onPlaybackChange };
  experimentRef.current = experiment;
  canvasIssueRef.current = canvasIssue;
  preparingRef.current = preparing;
  replacementPendingRef.current = replacementPending;
  runTokenRef.current = runToken;
  playbackBlockedRef.current = playbackBlocked;

  const publishSnapshot = useCallback((id: number, runtime: MechanicsRuntime) => {
    const snapshot = runtime.snapshot();
    setTime(snapshot.time);
    callbacksRef.current.onSnapshot(id, snapshot);
  }, []);

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
      const hemisphere = new HemisphereLight(0xf4fbfc, 0x7b9094, 1.9);
      scene.add(hemisphere);
      const keyLight = new DirectionalLight(0xf8ffff, 2.0);
      keyLight.position.set(-4, -5, 8);
      scene.add(keyLight);
      const fillLight = new DirectionalLight(0xa5c3c6, 0.8);
      fillLight.position.set(5, 4, 3);
      scene.add(fillLight);
      const grid = new GridHelper(12, 24, 0x8d9b99, 0xc6cfcd);
      grid.rotation.x = Math.PI / 2;
      grid.renderOrder = 1;
      grid.position.z = 0.002; // Keep the visual reference above z=0 supports, without z-fighting.
      grid.material.transparent = true;
      grid.material.opacity = 0.6;
      grid.material.depthWrite = false;
      scene.add(grid);
      gridRef.current = grid;
      const axes = new AxesHelper(1);
      for (const material of Array.isArray(axes.material) ? axes.material : [axes.material]) {
        material.transparent = true;
        material.opacity = 0.82;
      }
      scene.add(axes);
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
            const wallSeconds = (timestamp - previous) / 1000;
            if (wallSeconds > 0.25) {
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
                  if (followRef.current) rescaleReferences(visuals, followCamera(camera, controls, visuals));
                  if (result.pauseReason) {
                    stopSimulation(result.pauseReason);
                  } else if (timestamp - lastSnapshotRef.current >= 50) {
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
            if (visualSetRef.current) updateMarkers(visualSetRef.current, activeCamera, viewport.clientHeight);
            activeRenderer.render(activeScene, activeCamera);
          } catch (error) {
            setCanvasIssue(`WebGL could not draw the preview: ${describeError(error)}`);
            if (runningRef.current) stopSimulation('Paused because WebGL could not draw the preview.', false);
          }
        }
        // Camera updates inside this frame can already have scheduled the next one; never run two loops.
        if (runningRef.current && frameRequestRef.current === null) frameRequestRef.current = requestAnimationFrame(tick);
      };
      scheduleRef.current = () => {
        if (!disposed && frameRequestRef.current === null) frameRequestRef.current = requestAnimationFrame(tick);
      };
      controls.addEventListener('change', () => scheduleRef.current?.());
      // Any manual orbit, pan or zoom hands the camera back to the user.
      controls.addEventListener('start', () => {
        if (!followRef.current) return;
        followRef.current = false;
        setFollow(false);
      });
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
  }, [invalidateRunStart, publishSnapshot, stopSimulation]);

  useEffect(() => {
    if (!experiment) return;
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
          rescaleReferences(candidateVisuals, fitCamera(camera, controls, candidateVisuals));
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
          try { renderer.render(scene, camera); } catch { /* Keep the previous runtime alive if WebGL has failed. */ }
          throw error;
        }

        const installedRuntime = candidateRuntime;
        if (!installedRuntime) throw new Error('The replacement runtime was not initialized.');
        runtimeRef.current = installedRuntime;
        visualSetRef.current = candidateVisuals;
        activeIdRef.current = id;
        candidateRuntime = null;
        candidateVisuals = null;
        setPreparing(false);
        setRunning(false);
        runningRef.current = false;
        setPauseReason('');
        lastFrameRef.current = null;
        setTime(initialSnapshot.time);
        lastSnapshotRef.current = performance.now();
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
  }, [experiment, invalidateRunStart, stopSimulation]);

  useEffect(() => {
    if (clearTokenRef.current === clearToken) return;
    clearTokenRef.current = clearToken;
    invalidateRunStart();
    if (runningRef.current) stopSimulation('Paused because the current scene was closed.', false);
    setCandidateError('');
    const visuals = visualSetRef.current;
    const runtime = runtimeRef.current;
    activeIdRef.current = null;
    visualSetRef.current = null;
    runtimeRef.current = null;
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
    const runtime = runtimeRef.current;
    const id = activeIdRef.current;
    if (!runtime || id === null || preparingRef.current || replacementPendingRef.current || playbackBlockedRef.current || canvasIssueRef.current) return;
    if (runningRef.current) {
      stopSimulation('Paused by you. The inspection cards show the current solver state.');
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
      publishSnapshot(id, runtime);
      setCandidateError('');
      fitView();
    } catch (error) {
      setCandidateError(`Could not reset the model: ${describeError(error)}`);
    }
  };

  const toggleFollow = () => {
    const next = !followRef.current;
    followRef.current = next;
    setFollow(next);
    if (next && !runningRef.current) fitView();
  };

  const fitView = () => {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    const visuals = visualSetRef.current;
    if (!camera || !controls || !visuals || preparingRef.current) return;
    rescaleReferences(visuals, fitCamera(camera, controls, visuals));
    scheduleRef.current?.();
  };
  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      const target = event.target;
      if (event.isComposing || event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
      if (target instanceof HTMLElement && (
        target.isContentEditable || target.closest('input:not([type="range"]), textarea, select, [contenteditable="true"]')
      )) return;
      if (event.code === 'Space' && runtimeRef.current && !preparingRef.current && !replacementPendingRef.current && !playbackBlockedRef.current && !canvasIssueRef.current) {
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

  return (
    <div className="simulation-frame">
      <div className="simulation-viewport" ref={viewportRef}>
        <div className="canvas-tools">
          {runtimeRef.current ? (
            <label className="physical-ground-toggle">
              <input
                type="checkbox"
                role="switch"
                checked={physicalGround}
                onChange={event => onPhysicalGroundChange(event.currentTarget.checked)}
                disabled={groundDisabled || preparing || replacementPending}
              />
              <span>Ground</span>
            </label>
          ) : null}
          {runtimeRef.current ? (
            <button className="tool-button" type="button" onClick={toggleFollow} aria-pressed={follow} aria-label="Follow camera" title="Keep moving bodies and their paths in view while running">
              <Crosshair size={16} aria-hidden="true" />
              <span>Follow</span>
            </button>
          ) : null}
          <button className="tool-button" type="button" onClick={fitView} disabled={!runtimeRef.current || preparing} title="Frame all objects (F)" aria-label="Fit view" aria-keyshortcuts="F">
            <CornersOut size={16} aria-hidden="true" />
            <span>Fit</span>
          </button>
        </div>
        {!runtimeRef.current ? (
          <div className="canvas-empty-state" role="status">
            <strong>{preparing ? 'Preparing your model' : canvasIssue || candidateError ? 'Preview unavailable' : 'No experiment yet'}</strong>
            <p>{canvasIssue || candidateError || 'Describe a setup and assemble it. The scene opens here, paused, ready to inspect.'}</p>
          </div>
        ) : null}
        {preparing && runtimeRef.current ? <div className="replacement-indicator" role="status">Preparing replacement. Current preview is paused and preserved.</div> : null}
        {candidateError && runtimeRef.current ? <div className="canvas-warning" role="alert">{candidateError}</div> : null}
        <p className="canvas-help">{runtimeRef.current ? <span className="grid-scale">Grid squares {gridCell} m. </span> : null}<span className="hint-pointer">Drag to orbit. Scroll to zoom. Right-drag or arrow keys to pan.</span><span className="hint-touch">Drag to orbit. Pinch to zoom. Two-finger drag to pan.</span></p>
      </div>
      <div className="simulation-controls">
        <div className="playback-control">
          <button className={`run-button ${running ? 'is-running' : ''}`} type="button" onClick={() => { void toggleRunning(); }} disabled={!runtimeRef.current || preparing || replacementPending || runPending || playbackBlocked || Boolean(canvasIssue)} aria-keyshortcuts="Space" aria-busy={runPending}>
            {running ? <Pause size={16} weight="fill" aria-hidden="true" /> : <Play size={16} weight="fill" aria-hidden="true" />}
            <span>{runPending ? 'Checking scene' : running ? 'Pause' : 'Run'}</span>
          </button>
          <button className="tool-button" type="button" onClick={resetSimulation} disabled={!runtimeRef.current || preparing || replacementPending || Boolean(canvasIssue)} title="Return to the initial state without a model request (R)" aria-label="Reset" aria-keyshortcuts="R">
            <ArrowCounterClockwise size={16} aria-hidden="true" />
            <span>Reset</span>
          </button>
        </div>
        <div className="speed-control">
          <label htmlFor="playback-speed">Speed</label>
          <input id="playback-speed" type="range" min="0.1" max="10" step="0.1" value={speed} onChange={event => updateSpeed(event.target.value)} aria-label="Playback speed from 0.1 to 10 times" />
          <output>{speed.toFixed(1)}×</output>
          <span className="speed-presets" role="group" aria-label="Playback speed shortcuts">
            {[0.1, 1, 10].map(preset => (
              <button type="button" key={preset} value={preset} aria-pressed={speed === preset} onClick={event => updateSpeed(event.currentTarget.value)}>{preset}×</button>
            ))}
          </span>
        </div>
        <output className="simulation-clock" aria-live="off"><span>t</span><strong>{TIME_FORMAT.format(time)}</strong><small>s</small></output>
      </div>
      <div className="canvas-footer">
        <p className="canvas-status" role="status" aria-live="polite">
          {canvasIssue || candidateError || pauseReason || (preparing ? 'Preparing a paused replacement.' : running ? (throttled ? 'Running as fast as this device allows, slower than the selected speed. Every physics step is still computed.' : 'Running. Values and graphs update about twenty times per second.') : runtimeRef.current ? 'Paused at the initial state. Press Run when the setup looks right.' : 'No scene loaded.')}
        </p>
        <p className="keyboard-hint" aria-hidden="true"><kbd>Space</kbd> run <kbd>R</kbd> reset <kbd>F</kbd> fit</p>
      </div>
    </div>
  );
}
