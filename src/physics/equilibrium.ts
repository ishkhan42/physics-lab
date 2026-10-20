import type { MainModule, MjData, MjModel } from '@mujoco/mujoco';
import type { Body, Scene, Vec3 } from '../../shared/scene.ts';
import { FIXED_TIMESTEP } from './clock.ts';
import { staticFriction } from './materials.ts';

interface RestCandidate { tree: number; dof: number; }
interface RestState {
  candidates: RestCandidate[];
  pending: Uint8Array;
  asleep: Uint8Array;
  remaining: number;
  supported: Uint8Array;
  dofLengths: Float64Array;
  up: Vec3;
  speedTolerance: number;
  accelerationTolerance: number;
}

export class ContactEquilibrium {
  readonly geometryBodies: Int32Array;
  private readonly bodyTrees: Int32Array;
  private readonly state: RestState | null;
  private readonly model: MjModel;
  private readonly mujoco: MainModule;

  constructor(mujoco: MainModule, model: MjModel, scene: Scene, bindings: readonly { id: number; body: Body }[]) {
    this.model = model;
    this.mujoco = mujoco;
    // The pinned SDK leaves these integer WASM views untyped; own copies survive later heap growth.
    const geomBodies = model.geom_bodyid as Int32Array;
    const bodyTrees = model.body_treeid as Int32Array;
    const dofAddresses = model.body_dofadr as Int32Array;
    const dofLengths = model.dof_length as Float64Array;
    this.geometryBodies = new Int32Array(geomBodies);
    this.bodyTrees = new Int32Array(bodyTrees);
    const blocked = new Set<string>();
    for (const body of scene.bodies) {
      if (body.parentId !== null) { blocked.add(body.id); blocked.add(body.parentId); }
      if (body.heldBy !== null) { blocked.add(body.id); blocked.add(body.heldBy); }
    }
    for (const load of scene.loads) {
      if (load.kind === 'gravity') for (const id of load.bodyIds) blocked.add(id);
      else blocked.add(load.bodyId);
    }
    for (const event of scene.events) if (event.action.kind !== 'load') blocked.add(event.action.bodyId);
    for (const connection of scene.connections) {
      blocked.add(connection.bodyA);
      if (connection.bodyB !== null) blocked.add(connection.bodyB);
    }
    const sites = new Map(scene.sites.map(site => [site.id, site.bodyId]));
    for (const tendon of scene.tendons) for (const part of tendon.path) {
      if (part.kind === 'wrap') blocked.add(part.bodyId);
      else if (part.kind === 'site') {
        const owner = sites.get(part.siteId);
        if (owner) blocked.add(owner);
      }
    }
    const gravity = Math.hypot(...scene.gravity);
    const speedTolerance = model.opt.sleep_tolerance;
    const candidates: RestCandidate[] = [];
    if (gravity > 0 && Number.isFinite(gravity) && speedTolerance > 0 && Number.isFinite(speedTolerance)) {
      for (const { id, body } of bindings) {
        if (blocked.has(body.id) || body.parentId !== null || body.heldBy !== null || body.motion.kind !== 'free') continue;
        if (body.motion.linearVelocity.some(value => value !== 0) || body.motion.angularVelocity.some(value => value !== 0)) continue;
        // Smooth lossless rolling and deliberately driven experiments retain ordinary integration.
        if (body.shape.kind !== 'box' || body.restitution >= 1) continue;
        const deceleration = Math.min(staticFriction(body), body.friction.sliding) * gravity;
        if (!Number.isFinite(deceleration) || deceleration * FIXED_TIMESTEP < speedTolerance) continue;
        const tree = this.bodyTrees[id], dof = dofAddresses[id];
        if (tree < 0 || dof < 0) throw new Error('A free contact body has no native tree or coordinates.');
        candidates.push({ tree, dof });
      }
    }
    this.state = candidates.length ? {
      candidates, pending: new Uint8Array(candidates.length).fill(1), remaining: candidates.length,
      asleep: new Uint8Array(candidates.length),
      supported: new Uint8Array(model.ntree), dofLengths: new Float64Array(dofLengths),
      up: [-scene.gravity[0] / gravity, -scene.gravity[1] / gravity, -scene.gravity[2] / gravity],
      speedTolerance, accelerationTolerance: gravity * 0.001,
    } : null;
    if (this.state) {
      model.opt.enableflags |= mujoco.mjtEnableBit.mjENBL_SLEEP.value;
      this.reset();
    }
  }

  reset(): void {
    const state = this.state;
    if (!state) return;
    // Leave every controlled, jointed, lossless or explicitly moving tree awake.
    const policies = this.model.tree_sleep_policy as Int32Array;
    policies.fill(this.mujoco.mjtSleepPolicy.mjSLEEP_NEVER.value);
    state.pending.fill(1);
    state.asleep.fill(0);
    state.remaining = state.candidates.length;
    state.supported.fill(0);
  }

  prepareStep(data: MjData): void {
    const state = this.state;
    if (!state) return;
    const asleep = data.tree_asleep as Int32Array;
    const policies = this.model.tree_sleep_policy as Int32Array;
    for (let index = 0; index < state.candidates.length; index++) {
      if (state.pending[index]) continue;
      const candidate = state.candidates[index];
      const sleeping = asleep[candidate.tree] >= 0;
      if (!sleeping && (state.asleep[index] || !this.settled(data, candidate, state))) {
        // Native sleep alone does not require support; requalify every awakened or accelerating body.
        policies[candidate.tree] = this.mujoco.mjtSleepPolicy.mjSLEEP_NEVER.value;
        state.pending[index] = 1;
        state.remaining++;
      }
      state.asleep[index] = sleeping ? 1 : 0;
    }
  }

  private settled(data: MjData, candidate: RestCandidate, state: RestState): boolean {
    const acceleration = data.qacc as Float64Array;
    const velocity = data.qvel as Float64Array;
    for (let axis = 0; axis < 6; axis++) {
      const dof = candidate.dof + axis, scale = state.dofLengths[dof];
      const speed = Math.abs(velocity[dof] * scale), forceAcceleration = Math.abs(acceleration[dof] * scale);
      if (!Number.isFinite(speed) || !Number.isFinite(forceAcceleration) || speed > state.speedTolerance || forceAcceleration > state.accelerationTolerance) return false;
    }
    return true;
  }

  update(data: MjData): void {
    const state = this.state;
    if (!state || state.remaining === 0 || data.ncon === 0) return;
    state.supported.fill(0);
    // Refresh native views per call; contact accessors return owned structs that can grow the heap.
    let islands = data.tree_island as Int32Array;
    const contacts = data.contact;
    try {
      for (let index = 0; index < data.ncon; index++) {
        const contact = contacts.get(index);
        if (!contact) continue;
        try {
          if (islands.byteLength === 0) islands = data.tree_island as Int32Array;
          const first = this.bodyTrees[this.geometryBodies[contact.geom1]];
          const second = this.bodyTrees[this.geometryBodies[contact.geom2]];
          const normal = contact.frame;
          const alignment = normal[0] * state.up[0] + normal[1] * state.up[1] + normal[2] * state.up[2];
          const supportedTree = first < 0 && second >= 0 && alignment > 0.999999 ? second
            : second < 0 && first >= 0 && alignment < -0.999999 ? first : -1;
          if (supportedTree >= 0) {
            const island = islands[supportedTree];
            if (island >= 0 && island < state.supported.length) state.supported[island] = 1;
          }
        } finally { contact.delete(); }
      }
    } finally { contacts.delete(); }
    this.prepareStep(data);
    const policies = this.model.tree_sleep_policy as Int32Array;
    for (let index = 0; index < state.candidates.length; index++) {
      if (!state.pending[index]) continue;
      const candidate = state.candidates[index];
      if (!state.supported[islands[candidate.tree]]) continue;
      if (!this.settled(data, candidate, state)) continue;
      policies[candidate.tree] = this.mujoco.mjtSleepPolicy.mjSLEEP_ALLOWED.value;
      state.pending[index] = 0;
      state.remaining--;
    }
  }

  sleeping(data: MjData, bodyId: number): boolean {
    if (!this.state) return false;
    const tree = this.bodyTrees[bodyId];
    const asleep = data.tree_asleep as Int32Array;
    return tree >= 0 && asleep[tree] >= 0;
  }
}
