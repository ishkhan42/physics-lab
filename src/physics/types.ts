import type { Quat, Scene, Shape, Vec3 } from '../../shared/scene.ts';

export interface RenderItem {
  id: string;
  entityId: string;
  label: string;
  color: string;
  shape: Shape | { kind: 'line' };
  position: Vec3;
  /** Three.js order x,y,z,w, unlike model input w,x,y,z. */
  quaternion: Quat;
  points?: Vec3[];
}
export interface Observation {
  label: string;
  value: number | string | number[];
  unit?: string;
  note?: string;
}
export interface EntityObservation {
  id: string;
  label: string;
  kind: 'body' | 'tendon' | 'connection';
  color: string;
  properties: Observation[];
}
export interface InspectionSnapshot {
  time: number;
  entities: EntityObservation[];
  notes: string[];
}
export interface AdvanceResult {
  steps: number;
  pauseReason: string | null;
}
export interface MechanicsRuntime {
  readonly scene: Scene;
  readonly time: number;
  /** Mutated reusable poses; callers must not retain as frozen inspection state. */
  frame(): RenderItem[];
  /** Independent coherent values at the current simulation time. */
  snapshot(): InspectionSnapshot;
  advance(wallSeconds: number, speed: number): AdvanceResult;
  dispose(): void;
}
