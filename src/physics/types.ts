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
  visible?: boolean;
  selectable?: boolean;
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
export interface ContactObservation {
  bodyAId: string;
  bodyBId: string;
  /** Signed native contact distance in metres; negative values indicate penetration. */
  distance: number;
}
export interface InspectionSnapshot {
  time: number;
  entities: EntityObservation[];
  notes: string[];
  contacts?: ContactObservation[];
  contactsTruncated?: boolean;
  events?: { id: string; label: string; at: number; status: 'pending' | 'completed'; firedAt: number | null }[];
}
export interface AdvanceResult {
  /** Completed 1 ms steps. A budgeted call can advance native time partway through a step and return zero here. */
  steps: number;
  pauseReason: string | null;
  /** Set when this device could not keep up with the selected speed; queued wall time was discarded, never physics steps. */
  throttled?: true;
}
export interface MechanicsRuntime {
  readonly scene: Scene;
  /** Actual simulated seconds, including any completed contact substeps in a budgeted partial step. */
  readonly time: number;
  /** Mutated reusable poses; callers must not retain as frozen inspection state. */
  frame(): RenderItem[];
  /** Independent coherent values at the current simulation time. */
  snapshot(): InspectionSnapshot;
  /** Yields between native contact substeps when budgeted; one native solve cannot be preempted. Omit the budget for deterministic stepping. */
  advance(wallSeconds: number, speed: number, workBudgetMs?: number): AdvanceResult;
  reset(): void;
  dispose(): void;
}
