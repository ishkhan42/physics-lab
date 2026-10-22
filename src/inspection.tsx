import { useCallback, useEffect, useRef, useState } from 'react';
import type { InspectionView } from '../shared/visual-inspection.ts';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import { validateScene, type Decision, type Scene } from '../shared/scene.ts';
import type { CanvasExperiment, CanvasInspectionCapture, CanvasInspectionController } from './SimulationCanvas.tsx';
import SimulationCanvas from './SimulationCanvas.tsx';
import './styles.css';
import './inspection.css';

interface InspectionBridge {
  load(scene: unknown): Promise<void>;
  capture(time: number, view: InspectionView, focusId: string | null): Promise<CanvasInspectionCapture>;
}

declare global {
  interface Window {
    physicsLabInspection?: InspectionBridge;
  }
}

const ignoreCallback = (..._args: unknown[]): void => {};
const blockPlayback = async (): Promise<boolean> => false;

function InspectionApp() {
  const [experiment, setExperiment] = useState<CanvasExperiment | null>(null);
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null);
  const experimentRef = useRef<CanvasExperiment | null>(null);
  const controllerRef = useRef<CanvasInspectionController | null>(null);
  const pendingLoadRef = useRef<{ resolve: () => void; reject: (error: Error) => void } | null>(null);
  const handleController = useCallback((controller: CanvasInspectionController | null) => {
    controllerRef.current = controller;
  }, []);

  useEffect(() => {
    const bridge: InspectionBridge = {
      load(input) {
        if (experimentRef.current || pendingLoadRef.current) return Promise.reject(new Error('This inspection page already has a scene.'));
        let scene: Scene;
        try {
          scene = validateScene(input);
        } catch (error) {
          return Promise.reject(error);
        }
        const decision: Decision = {
          kind: 'scene', summary: 'Private visual inspection.', assumptions: [], question: null, reason: null,
          approximation: null, scene, alternative: null,
        };
        const next: CanvasExperiment = { id: 1, scene, decision };
        experimentRef.current = next;
        const { promise, resolve, reject } = Promise.withResolvers<void>();
        pendingLoadRef.current = { resolve, reject };
        setExperiment(next);
        return promise;
      },
      capture(time, view, focusId) {
        const controller = controllerRef.current;
        if (!controller) return Promise.reject(new Error('The inspection scene is not ready.'));
        return controller.capture(time, view, focusId);
      },
    };
    window.physicsLabInspection = Object.freeze(bridge);
    return () => {
      delete window.physicsLabInspection;
      const pending = pendingLoadRef.current;
      pendingLoadRef.current = null;
      pending?.reject(new Error('The inspection page was closed before the scene was ready.'));
      controllerRef.current = null;
    };
  }, []);

  const handleReady = () => {
    const pending = pendingLoadRef.current;
    if (!pending) return;
    pendingLoadRef.current = null;
    if (!controllerRef.current) {
      pending.reject(new Error('The actual renderer did not provide an inspection controller.'));
      return;
    }
    pending.resolve();
  };

  const handleFailure = (_id: number, message: string) => {
    const pending = pendingLoadRef.current;
    if (!pending) return;
    pendingLoadRef.current = null;
    pending.reject(new Error(message));
  };

  return (
    <main className="inspection-root">
      <SimulationCanvas
        experiment={experiment}
        replacementPending={false}
        onStatus={ignoreCallback}
        onReady={handleReady}
        onSnapshot={ignoreCallback}
        onFailure={handleFailure}
        onBeforeRun={blockPlayback}
        onPlaybackChange={ignoreCallback}
        playbackBlocked={false}
        runToken={0}
        clearToken={0}
        selectedEntityId={selectedEntityId}
        onSelectEntity={setSelectedEntityId}
        onInspectionController={handleController}
      />
    </main>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Inspection root element is missing.');
createRoot(root).render(<InspectionApp />);
