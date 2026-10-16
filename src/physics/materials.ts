import type { MainModule, MjData, MjModel } from '@mujoco/mujoco';
import type { Body, Scene } from '../../shared/scene.ts';
import { FIXED_TIMESTEP } from './clock.ts';

export const CONTACT_SUBSTEPS = 16;
export const CONTACT_TIMESTEP = FIXED_TIMESTEP / CONTACT_SUBSTEPS;
export const CONTACT_STIFFNESS = 1e6;
export const CONTACT_IMPEDANCE = '0.9999 0.9999 0.001 0.5 2';
export const FRICTION_REFERENCE = '0.002 1';
const STICKING_SPEED = 0.001;

export function contactSubsteps(scene: Scene): number {
  let colliders = 0;
  let moving = false;
  for (const body of scene.bodies) {
    if (body.shape.kind === 'point') continue;
    colliders++;
    moving ||= body.motion.kind !== 'fixed';
  }
  return moving && colliders > 1 ? CONTACT_SUBSTEPS : 1;
}

export function staticFriction(body: Body): number {
  return body.friction.static ?? body.friction.sliding;
}

export function contactDamping(restitution: number): number {
  if (restitution === 1) return 0;
  const limit = 1 / CONTACT_TIMESTEP;
  if (restitution === 0) return limit;
  let low = 0;
  let high = limit / (2 * Math.sqrt(CONTACT_STIFFNESS));
  // Unilateral spring/damper contact releases when the normal force reaches zero.
  for (let iteration = 0; iteration < 48; iteration++) {
    const ratio = (low + high) / 2;
    const rebound = Math.abs(ratio - 1) < 1e-8 ? Math.exp(-2) : Math.exp(ratio < 1
      ? -2 * ratio * Math.acos(ratio) / Math.sqrt(1 - ratio * ratio)
      : -2 * ratio * Math.acosh(ratio) / Math.sqrt(ratio * ratio - 1));
    if (rebound > restitution) low = ratio;
    else high = ratio;
  }
  return Math.min(limit, (low + high) * Math.sqrt(CONTACT_STIFFNESS));
}

export interface MaterialPair {
  first: Body;
  second: Body;
  restitution: number;
  static: number;
  sliding: number;
  torsional: number;
  rolling: number;
}

export function materialPairs(scene: Scene): MaterialPair[] {
  if (scene.bodies.every(body => staticFriction(body) === body.friction.sliding)) return [];
  const bodies = new Map(scene.bodies.map(body => [body.id, body]));
  const family = new Map<string, string | null>();
  const weldRoot = (body: Body): string | null => {
    if (family.has(body.id)) return family.get(body.id)!;
    const root = body.motion.kind !== 'fixed' ? body.id : body.parentId ? weldRoot(bodies.get(body.parentId)!) : null;
    family.set(body.id, root);
    return root;
  };
  const parentFamily = new Map<string, string | null>();
  for (const body of scene.bodies) {
    weldRoot(body);
    if (body.motion.kind !== 'fixed') parentFamily.set(body.id, body.parentId ? weldRoot(bodies.get(body.parentId)!) : null);
  }
  const pairs: MaterialPair[] = [];
  for (let first = 0; first < scene.bodies.length; first++) for (let second = first + 1; second < scene.bodies.length; second++) {
    const a = scene.bodies[first];
    const b = scene.bodies[second];
    if (a.shape.kind === 'point' || b.shape.kind === 'point') continue;
    const aFamily = family.get(a.id)!;
    const bFamily = family.get(b.id)!;
    if (aFamily === bFamily) continue;
    if (aFamily !== null && bFamily !== null
      && (parentFamily.get(aFamily) === bFamily || parentFamily.get(bFamily) === aFamily)) continue;
    const restitution = Math.min(a.restitution, b.restitution);
    const staticCoefficient = Math.max(staticFriction(a), staticFriction(b));
    const sliding = Math.max(a.friction.sliding, b.friction.sliding);
    const torsional = Math.max(a.friction.torsional, b.friction.torsional);
    const rolling = Math.max(a.friction.rolling, b.friction.rolling);
    if (staticCoefficient === sliding) continue;
    pairs.push({ first: a, second: b, restitution, static: staticCoefficient, sliding, torsional, rolling });
  }
  return pairs;
}

interface FrictionPair {
  index: number;
  static: number;
  sliding: number;
}

export class ContactFriction {
  private readonly pairs: FrictionPair[] = [];
  private readonly lookup: Int32Array;
  private readonly slip: Float64Array;
  private readonly touched: Int32Array;
  private frictionView: Float64Array | null = null;
  private readonly mujoco: MainModule;
  private readonly model: MjModel;

  constructor(mujoco: MainModule, model: MjModel, bodies: readonly { id: number; body: Body }[]) {
    this.mujoco = mujoco;
    this.model = model;
    if (model.npair > 0) {
      const byId = new Map(bodies.map(binding => [binding.id, binding.body]));
      for (let index = 0; index < model.npair; index++) {
        const a = byId.get(model.geom_bodyid[model.pair_geom1[index]])!;
        const b = byId.get(model.geom_bodyid[model.pair_geom2[index]])!;
        const staticCoefficient = Math.max(staticFriction(a), staticFriction(b));
        const sliding = Math.max(a.friction.sliding, b.friction.sliding);
        if (staticCoefficient !== sliding) this.pairs.push({ index, static: staticCoefficient, sliding });
      }
    }
    this.lookup = new Int32Array(this.pairs.length ? model.ngeom * model.ngeom : 0).fill(-1);
    this.slip = new Float64Array(this.pairs.length).fill(-1);
    this.touched = new Int32Array(this.pairs.length);
    this.pairs.forEach((pair, index) => {
      const first = model.pair_geom1[pair.index];
      const second = model.pair_geom2[pair.index];
      this.lookup[first * model.ngeom + second] = index;
      this.lookup[second * model.ngeom + first] = index;
    });
  }

  private updateCoefficients(data: MjData): void {
    if (!this.pairs.length || !data.ncon) return;
    let count = 0;
    // The WASM contact accessor returns owned copies; modify model pair arrays, not the copies.
    const contacts = data.contact;
    try {
      for (let index = 0; index < data.ncon; index++) {
        const contact = contacts.get(index);
        if (!contact) continue;
        try {
          const pair = this.lookup[contact.geom1 * this.model.ngeom + contact.geom2];
          if (pair < 0 || contact.efc_address < 0 || contact.dim < 3) continue;
          const speed = Math.hypot(data.efc_vel[contact.efc_address + 1], data.efc_vel[contact.efc_address + 2]);
          if (this.slip[pair] < 0) this.touched[count++] = pair;
          this.slip[pair] = Math.max(this.slip[pair], speed);
        } finally {
          contact.delete();
        }
      }
    } finally {
      contacts.delete();
    }
    if (!this.frictionView || this.frictionView.byteLength === 0) this.frictionView = this.model.pair_friction as Float64Array;
    let changed = false;
    for (let index = 0; index < count; index++) {
      const slot = this.touched[index];
      const pair = this.pairs[slot];
      const coefficient = this.slip[slot] < STICKING_SPEED ? pair.static : pair.sliding;
      this.slip[slot] = -1;
      const offset = pair.index * 5;
      if (this.frictionView[offset] !== coefficient) {
        this.frictionView[offset] = coefficient;
        this.frictionView[offset + 1] = coefficient;
        changed = true;
      }
    }
    if (changed) {
      this.mujoco.mj_fwdPosition(this.model, data);
      this.mujoco.mj_fwdVelocity(this.model, data);
    }
  }

  update(data: MjData): void {
    this.updateCoefficients(data);
    const type = data.efc_type;
    const id = data.efc_id;
    const parameters = data.efc_KBIP;
    const elliptic = this.mujoco.mjtConstraint.mjCNSTR_CONTACT_ELLIPTIC.value;
    let changed = false;
    // Tangential damping must remain active even for an undamped elastic normal contact.
    for (let row = 1; row < data.nefc; row++) {
      if (type[row] !== elliptic || type[row - 1] !== elliptic || id[row] !== id[row - 1]) continue;
      if (parameters[row * 4 + 1] !== 1000) {
        parameters[row * 4 + 1] = 1000;
        changed = true;
      }
    }
    if (changed) this.mujoco.mj_referenceConstraint(this.model, data);
  }
}
