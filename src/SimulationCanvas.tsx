import { useCallback, useEffect, useRef, useState } from 'react';
import {
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
}

interface SimulationCanvasProps {
  experiment: CanvasExperiment | null;
  onStatus: (id: number, message: string) => void;
  onReady: (experiment: CanvasExperiment, snapshot: InspectionSnapshot) => void;
  onSnapshot: (id: number, snapshot: InspectionSnapshot) => void;
  onFailure: (id: number, message: string) => void;
  replacementPending: boolean;
}

interface VisualSet {
  group: Group;
  objects: Map<string, Object3D>;
  lines: Map<string, Line>;
}

const initialCameraDirection = new Vector3(1, -1.25, 0.9).normalize();
const TIME_FORMAT = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 5 });

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : 'An unknown rendering or runtime error occurred.';
}

function disposeGroup(group: Group): void {
  group.traverse(object => {
    if (!(object instanceof Mesh) && !(object instanceof Line)) return;
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
    material = new MeshStandardMaterial({ color: item.color, roughness: 0.62, metalness: 0.02, transparent: true, opacity: 0.54, side: 2 });
  } else {
    geometry = new SphereGeometry(0.045, 12, 8);
    material = new MeshBasicMaterial({ color: item.color, transparent: true, opacity: 0.9 });
  }
  const mesh = new Mesh(geometry, material);
  mesh.scale.set(...scale);
  return mesh;
}

function createVisualSet(items: RenderItem[]): VisualSet {
  if (items.length === 0) throw new Error('The runtime returned no renderable scene items.');
  const group = new Group();
  const objects = new Map<string, Object3D>();
  const lines = new Map<string, Line>();
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
      }
      objects.set(item.id, object);
      group.add(object);
    }
    return { group, objects, lines };
  } catch (error) {
    disposeGroup(group);
    throw error;
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

function fitCamera(camera: PerspectiveCamera, controls: OrbitControls, group: Group): void {
  const bounds = new Box3().setFromObject(group, true);
  const center = bounds.getCenter(new Vector3());
  const size = bounds.getSize(new Vector3());
  const extent = Math.max(size.x, size.y, size.z, 4);
  const verticalHalfAngle = camera.fov * Math.PI / 360;
  const horizontalHalfAngle = Math.atan(Math.tan(verticalHalfAngle) * camera.aspect);
  const distance = extent * 1.35 / Math.sin(Math.min(verticalHalfAngle, horizontalHalfAngle));
  camera.position.copy(center).addScaledVector(initialCameraDirection, distance);
  camera.near = Math.max(distance / 5000, 0.001);
  camera.far = Math.max(distance * 100, 100);
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.update();
}


export default function SimulationCanvas({ experiment, replacementPending, onStatus, onReady, onSnapshot, onFailure }: SimulationCanvasProps) {
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
  const callbacksRef = useRef({ onStatus, onReady, onSnapshot, onFailure });
  const experimentRef = useRef(experiment);
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [time, setTime] = useState(0);
  const [preparing, setPreparing] = useState(false);
  const [canvasIssue, setCanvasIssue] = useState('');
  const [candidateError, setCandidateError] = useState('');
  const canvasIssueRef = useRef(canvasIssue);
  const [pauseReason, setPauseReason] = useState('');

  callbacksRef.current = { onStatus, onReady, onSnapshot, onFailure };
  experimentRef.current = experiment;
  canvasIssueRef.current = canvasIssue;

  const publishSnapshot = useCallback((id: number, runtime: MechanicsRuntime) => {
    const snapshot = runtime.snapshot();
    setTime(snapshot.time);
    callbacksRef.current.onSnapshot(id, snapshot);
  }, []);

  const stopSimulation = useCallback((reason: string, publish = true) => {
    runningRef.current = false;
    lastFrameRef.current = null;
    setRunning(false);
    setPauseReason(reason);
    const runtime = runtimeRef.current;
    const id = activeIdRef.current;
    if (publish && runtime && id !== null) publishSnapshot(id, runtime);
    scheduleRef.current?.();
  }, [publishSnapshot]);

  useEffect(() => {
    if (replacementPending && runningRef.current) stopSimulation('Paused while preparing a replacement experiment.');
  }, [replacementPending, stopSimulation]);

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
      scene.background = new Color(0x0b1215);
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
      const hemisphere = new HemisphereLight(0xdaf8f5, 0x19282b, 2.1);
      scene.add(hemisphere);
      const keyLight = new DirectionalLight(0xe6fbff, 2.3);
      keyLight.position.set(-4, -5, 8);
      scene.add(keyLight);
      const fillLight = new DirectionalLight(0x80bec2, 0.75);
      fillLight.position.set(5, 4, 3);
      scene.add(fillLight);
      const grid = new GridHelper(12, 24, 0x456267, 0x273a3e);
      grid.rotation.x = Math.PI / 2;
      grid.position.z = -0.008;
      grid.material.transparent = true;
      grid.material.opacity = 0.42;
      grid.material.depthWrite = false;
      scene.add(grid);
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
                  const result = runtime.advance(wallSeconds, speedRef.current);
                  applyFrame(runtime.frame(), visuals);
                  if (result.pauseReason) {
                    stopSimulation(result.pauseReason);
                  } else if (timestamp - lastSnapshotRef.current >= 100) {
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
            activeRenderer.render(activeScene, activeCamera);
          } catch (error) {
            setCanvasIssue(`WebGL could not draw the preview: ${describeError(error)}`);
            if (runningRef.current) stopSimulation('Paused because WebGL could not draw the preview.', false);
          }
        }
        if (runningRef.current) frameRequestRef.current = requestAnimationFrame(tick);
      };
      scheduleRef.current = () => {
        if (!disposed && frameRequestRef.current === null) frameRequestRef.current = requestAnimationFrame(tick);
      };
      controls.addEventListener('change', () => scheduleRef.current?.());
      scheduleRef.current?.();

      const onVisibility = () => {
        if (document.hidden && runningRef.current) {
          stopSimulation('Paused because the page became hidden. Resume when you return to the lab.');
        }
      };
      document.addEventListener('visibilitychange', onVisibility);
      const onContextLost = (event: Event) => {
        event.preventDefault();
        const message = 'WebGL context was lost. The preview is unavailable until the page is reloaded.';
        setCanvasIssue(message);
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
        rendererRef.current?.dispose();
        rendererRef.current?.domElement.remove();
        rendererRef.current = null;
      };
    }
  }, [publishSnapshot, stopSimulation]);

  useEffect(() => {
    if (!experiment) return;
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
        candidateVisuals = createVisualSet(candidateRuntime.frame());
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
          fitCamera(camera, controls, candidateVisuals.group);
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
      setPreparing(false);
      candidateRuntime?.dispose();
      if (candidateVisuals) disposeGroup(candidateVisuals.group);
    };
  }, [experiment, stopSimulation]);

  const updateSpeed = (value: string) => {
    const next = Number(value);
    if (Number.isFinite(next)) {
      speedRef.current = next;
      setSpeed(next);
    }
  };

  const toggleRunning = () => {
    const runtime = runtimeRef.current;
    const id = activeIdRef.current;
    if (!runtime || id === null) return;
    if (runningRef.current) {
      stopSimulation('Paused by you. The inspection cards show the current solver state.');
      return;
    }
    if (document.hidden) {
      setPauseReason('The page is hidden. Return to the lab before running the simulation.');
      return;
    }
    setPauseReason('');
    runningRef.current = true;
    setRunning(true);
    lastFrameRef.current = null;
    scheduleRef.current?.();
  };

  const resetSimulation = () => {
    const runtime = runtimeRef.current;
    const visuals = visualSetRef.current;
    const id = activeIdRef.current;
    if (!runtime || !visuals || id === null) return;
    stopSimulation('Reset to the initial conditions. Press Run to repeat the experiment.', false);
    try {
      runtime.reset();
      applyFrame(runtime.frame(), visuals);
      publishSnapshot(id, runtime);
      setCandidateError('');
      fitView();
    } catch (error) {
      setCandidateError(`Could not reset the model: ${describeError(error)}`);
    }
  };

  const fitView = () => {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    const visuals = visualSetRef.current;
    if (!camera || !controls || !visuals) return;
    fitCamera(camera, controls, visuals.group);
    scheduleRef.current?.();
  };

  return (
    <div className="simulation-frame">
      <div className="simulation-viewport" ref={viewportRef}>
        <div className="canvas-orientation" aria-hidden="true">Z UP <span>·</span> SI</div>
        <div className="canvas-tools">
          <button className="secondary-button" type="button" onClick={fitView} disabled={!runtimeRef.current || preparing} title="Frame all objects without changing the simulation">Fit view</button>
        </div>
        {!runtimeRef.current ? (
          <div className="canvas-empty-state" role="status">
            <span className="empty-orbit" aria-hidden="true"><i /><b /></span>
            <strong>{preparing ? 'Preparing your model' : canvasIssue || candidateError ? 'Preview unavailable' : 'Canvas ready for an experiment'}</strong>
            <p>{canvasIssue || candidateError || 'The reference grid is not a physical floor. Assemble a scene to see its real geometry here.'}</p>
          </div>
        ) : null}
        {preparing && runtimeRef.current ? <div className="replacement-indicator" role="status">Preparing replacement · current preview is paused and preserved</div> : null}
        {candidateError && runtimeRef.current ? <div className="canvas-warning" role="alert">{candidateError}</div> : null}
        <p className="canvas-help">Focus canvas for arrow-key pan · drag to orbit · scroll to zoom · right-drag to pan</p>
      </div>
      <div className="simulation-controls">
        <div className="playback-control">
          <button className={`run-button ${running ? 'is-running' : ''}`} type="button" onClick={toggleRunning} disabled={!runtimeRef.current || preparing || replacementPending || Boolean(canvasIssue)}>
            {running ? 'Pause' : 'Run'}
          </button>
          <button className="secondary-button" type="button" onClick={resetSimulation} disabled={!runtimeRef.current || preparing || replacementPending || Boolean(canvasIssue)} title="Return to the original positions and velocities without another model request">Reset</button>
          <span className={`run-state ${running ? 'run-state--active' : ''}`}><i aria-hidden="true" />{running ? 'RUNNING' : runtimeRef.current ? 'PAUSED' : 'NO MODEL'}</span>
        </div>
        <div className="speed-control">
          <label htmlFor="playback-speed">Playback speed</label>
          <input id="playback-speed" type="range" min="0.1" max="10" step="0.1" value={speed} onChange={event => updateSpeed(event.target.value)} aria-label="Playback speed from 0.1 to 10 times" />
          <output>{speed.toFixed(1)}×</output>
          <span className="speed-presets" role="group" aria-label="Playback speed shortcuts">
            {[0.1, 1, 10].map(preset => (
              <button className="secondary-button" type="button" key={preset} value={preset} aria-pressed={speed === preset} onClick={event => updateSpeed(event.currentTarget.value)}>{preset}×</button>
            ))}
          </span>
        </div>
        <output className="simulation-clock" aria-live="off"><span>SIM TIME</span><strong>{TIME_FORMAT.format(time)} <small>s</small></strong></output>
      </div>
      <p className="canvas-disclosure">Reference grid and 1 m axes are visual aids, not a generated floor. Infinite planes render as visible patches; point markers are not physical radii.</p>
      <p className="canvas-status" role="status" aria-live="polite">
        {canvasIssue || candidateError || pauseReason || (preparing ? 'Preparing a paused replacement.' : running ? 'Running. Inspection values refresh at 10 Hz.' : runtimeRef.current ? 'Paused. Press Run to advance the actual mechanics model.' : 'No scene is loaded.')}
      </p>
    </div>
  );
}
