import type { DoubleBuffer, MainModule, MjData, MjModel } from '@mujoco/mujoco';
import { physicalScene, validateScene } from '../../shared/scene.ts';
import type { Body, Quat, Scene, Vec3 } from '../../shared/scene.ts';
import { FixedStepClock, FIXED_TIMESTEP } from './clock.ts';
import { compileMjcf, fixedTendonEqualityName, jointName, PARTICLE_JOINT_SUFFIXES } from './mjcf.ts';
import { ContactFriction, contactSubsteps, staticFriction } from './materials.ts';
import type { AdvanceResult, EntityObservation, InspectionSnapshot, MechanicsRuntime, Observation, RenderItem } from './types.ts';

const INITIAL_CONSTRAINT_TOLERANCE = 1e-4;
const PARTICLE_INERTIA_NOTE = 'Point particles have translation only; compiler-required rotational inertia is not a physical observation.';
const WARNING_LABELS: Record<number, string> = {
  0: 'inertia', 1: 'contact capacity', 2: 'constraint capacity', 3: 'position', 4: 'velocity', 5: 'acceleration', 6: 'control',
};
const COMPLETED_STEP = { advanced: true, pauseReason: null } as const;
const DEFERRED_STEP = { advanced: false, pauseReason: null } as const;

const wasmAsset = new URL('../../node_modules/@mujoco/mujoco/mujoco.wasm', import.meta.url);
let modulePromise: Promise<MainModule> | undefined;

function engine(): Promise<MainModule> {
  if (!modulePromise) modulePromise = import('@mujoco/mujoco').then(({ default: load }) => load({
    locateFile: (path: string) => path.endsWith('.wasm') ? wasmAsset.href : path,
  }));
  return modulePromise;
}

interface BodyBinding {
  body: Body;
  id: number;
  coordinates: { qpos: number; dof: number }[];
  renderItem: RenderItem;
}


interface TendonBinding {
  tendon: Scene['tendons'][number];
  id: number;
  equalityId: number | null;
  branches: RenderItem[];
}

interface ConnectionBinding {
  connection: Scene['connections'][number];
  bodyA: BodyBinding;
  bodyB?: BodyBinding;
  anchorA?: Vec3;
  anchorB?: Vec3;
  renderItem: RenderItem;
}

function idFor(mujoco: MainModule, model: MjModel, type: number, name: string): number {
  const id = mujoco.mj_name2id(model, type, name);
  if (id < 0) throw new Error(`The compiled model is missing ${name}.`);
  return id;
}

function rotate(q: Quat, v: Vec3): Vec3 {
  const [w, x, y, z] = q;
  const [vx, vy, vz] = v;
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [vx + w * tx + y * tz - z * ty, vy + w * ty + z * tx - x * tz, vz + w * tz + x * ty - y * tx];
}

function inverseRotate(q: Quat, v: Vec3): Vec3 {
  return rotate([q[0], -q[1], -q[2], -q[3]], v);
}


function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}


function vecAt(values: ArrayLike<number>, offset: number): Vec3 {
  return [values[offset], values[offset + 1], values[offset + 2]];
}


function setVec(target: Vec3, values: ArrayLike<number>, offset: number): void {
  target[0] = values[offset];
  target[1] = values[offset + 1];
  target[2] = values[offset + 2];
}
function setWorldPoint(target: Vec3, positions: ArrayLike<number>, quaternions: ArrayLike<number>, positionOffset: number, quaternionOffset: number, local: Vec3): void {
  const w = quaternions[quaternionOffset];
  const x = quaternions[quaternionOffset + 1];
  const y = quaternions[quaternionOffset + 2];
  const z = quaternions[quaternionOffset + 3];
  const tx = 2 * (y * local[2] - z * local[1]);
  const ty = 2 * (z * local[0] - x * local[2]);
  const tz = 2 * (x * local[1] - y * local[0]);
  target[0] = positions[positionOffset] + local[0] + w * tx + y * tz - z * ty;
  target[1] = positions[positionOffset + 1] + local[1] + w * ty + z * tx - x * tz;
  target[2] = positions[positionOffset + 2] + local[2] + w * tz + x * ty - y * tx;
}

function setThreeQuat(target: Quat, values: ArrayLike<number>, offset: number): void {
  target[0] = values[offset + 1];
  target[1] = values[offset + 2];
  target[2] = values[offset + 3];
  target[3] = values[offset];
}


function shapeLabel(body: Body): Observation {
  const shape = body.shape;
  if (shape.kind === 'sphere') return { label: 'Radius', value: shape.radius, unit: 'm' };
  if (shape.kind === 'box') return { label: 'Full side lengths', value: [...shape.size], unit: 'm' };
  if (shape.kind === 'cylinder' || shape.kind === 'capsule') return { label: 'Radius / cylindrical length', value: [shape.radius, shape.length], unit: 'm' };
  if (shape.kind === 'ellipsoid') return { label: 'Semiaxes', value: [...shape.radii], unit: 'm' };
  if (shape.kind === 'plane') return { label: 'Visible half-widths', value: [...shape.size], unit: 'm' };
  return { label: 'Geometry', value: body.motion.kind === 'particle' ? 'Point particle' : 'Point marker' };
}


function makeBodyItem(body: Body): RenderItem {
  return { id: body.id, entityId: body.id, label: body.label, color: body.color, shape: body.shape, position: [0, 0, 0], quaternion: [0, 0, 0, 1] };
}

function makeLineItem(id: string, label: string, color: string, points: number, entityId = id): RenderItem {
  return { id, entityId, label, color, shape: { kind: 'line' }, position: [0, 0, 0], quaternion: [0, 0, 0, 1], points: Array.from({ length: points }, () => [0, 0, 0] as Vec3) };
}

function coordinatesFor(mujoco: MainModule, model: MjModel, body: Body): { qpos: number; dof: number }[] {
  const names = body.motion.kind === 'particle'
    ? PARTICLE_JOINT_SUFFIXES.map(suffix => `${jointName(body.id)}${suffix}`)
    : body.motion.kind === 'fixed' ? [] : [jointName(body.id)];
  return names.map(name => {
    const id = idFor(mujoco, model, mujoco.mjtObj.mjOBJ_JOINT.value, name);
    return { qpos: model.jnt_qposadr[id], dof: model.jnt_dofadr[id] };
  });
}

function configureFixedTendonTargets(mujoco: MainModule, model: MjModel, scene: Scene): void {
  for (const tendon of scene.tendons) {
    if (tendon.mode !== 'fixed') continue;
    const tendonId = idFor(mujoco, model, mujoco.mjtObj.mjOBJ_TENDON.value, tendon.id);
    const equality = model.eq(fixedTendonEqualityName(tendon.id));
    try {
      const coefficients = equality.data as Float64Array;
      coefficients[0] = tendon.length - model.tendon_length0[tendonId];
    } finally {
      equality.delete();
    }
  }
}

function makeBodyBindings(mujoco: MainModule, model: MjModel, scene: Scene): BodyBinding[] {
  return scene.bodies.map(body => ({
    body,
    id: idFor(mujoco, model, mujoco.mjtObj.mjOBJ_BODY.value, body.id),
    coordinates: coordinatesFor(mujoco, model, body),
    renderItem: makeBodyItem(body),
  }));
}

function initializeVelocities(data: MjData, bindings: BodyBinding[]): void {
  const qpos = data.qpos;
  const qvel = data.qvel;
  for (const binding of bindings) {
    const { body, coordinates } = binding;
    const motion = body.motion;
    if (motion.kind === 'free') {
      const { dof } = coordinates[0];
      qvel[dof] = motion.linearVelocity[0];
      qvel[dof + 1] = motion.linearVelocity[1];
      qvel[dof + 2] = motion.linearVelocity[2];
      const angular = inverseRotate(body.orientation, motion.angularVelocity);
      qvel[dof + 3] = angular[0];
      qvel[dof + 4] = angular[1];
      qvel[dof + 5] = angular[2];
    } else if (motion.kind === 'particle') {
      for (let axis = 0; axis < 3; axis++) qvel[coordinates[axis].dof] = motion.linearVelocity[axis];
    } else if (motion.kind === 'hinge' || motion.kind === 'slide') {
      qpos[coordinates[0].qpos] = motion.position;
      qvel[coordinates[0].dof] = motion.velocity;
    } else if (motion.kind === 'ball') {
      const angular = inverseRotate(body.orientation, motion.angularVelocity);
      qvel[coordinates[0].dof] = angular[0];
      qvel[coordinates[0].dof + 1] = angular[1];
      qvel[coordinates[0].dof + 2] = angular[2];
    }
  }
}

function initializeImpulses(
  mujoco: MainModule,
  model: MjModel,
  data: MjData,
  scene: Scene,
  bodyIds: Map<string, number>,
  jacobianPosition: DoubleBuffer | null,
  jacobianRotation: DoubleBuffer | null,
  velocityChange: DoubleBuffer | null,
  generalizedImpulse: number[],
): void {
  if (!jacobianPosition || !jacobianRotation || !velocityChange) return;
  const nv = model.nv;
  for (const load of scene.loads) {
    if (load.kind !== 'impulse') continue;
    generalizedImpulse.fill(0);
    const bodyId = bodyIds.get(load.bodyId)!;
    mujoco.mj_jacBodyCom(model, data, jacobianPosition, jacobianRotation, bodyId);
    const positionJacobian = jacobianPosition.GetView() as Float64Array;
    const rotationJacobian = jacobianRotation.GetView() as Float64Array;
    for (let dof = 0; dof < nv; dof++) {
      generalizedImpulse[dof] =
        positionJacobian[dof] * load.linear[0] + positionJacobian[nv + dof] * load.linear[1] + positionJacobian[2 * nv + dof] * load.linear[2] +
        rotationJacobian[dof] * load.angular[0] + rotationJacobian[nv + dof] * load.angular[1] + rotationJacobian[2 * nv + dof] * load.angular[2];
    }
    mujoco.mj_solveM(model, data, velocityChange, generalizedImpulse);
    const deltaVelocity = velocityChange.GetView() as Float64Array;
    const qvel = data.qvel;
    for (let dof = 0; dof < nv; dof++) qvel[dof] += deltaVelocity[dof];
  }
}

function warningCounts(data: MjData): number[] {
  const counts: number[] = [];
  // This vector is borrowed from MjData; only get() results are owned copies.
  const warnings = data.warning;
  for (let index = 0; index < warnings.size(); index++) {
    const warning = warnings.get(index);
    counts.push(warning?.number ?? 0);
    warning?.delete();
  }
  return counts;
}

function finiteArray(values: ArrayLike<number>): boolean {
  for (let index = 0; index < values.length; index++) if (!Number.isFinite(values[index])) return false;
  return true;
}

function nonfiniteState(data: MjData): boolean {
  return !finiteArray(data.qpos) || !finiteArray(data.qvel) || !finiteArray(data.qacc) || !finiteArray(data.xpos) || !Number.isFinite(data.time);
}

function makeTendonBindings(mujoco: MainModule, model: MjModel, scene: Scene): TendonBinding[] {
  return scene.tendons.map(tendon => {
    const id = idFor(mujoco, model, mujoco.mjtObj.mjOBJ_TENDON.value, tendon.id);
    const branchCount = 1 + tendon.path.filter(part => part.kind === 'pulley').length;
    return {
      tendon,
      id,
      equalityId: tendon.mode === 'fixed'
        ? idFor(mujoco, model, mujoco.mjtObj.mjOBJ_EQUALITY.value, fixedTendonEqualityName(tendon.id))
        : null,
      branches: Array.from({ length: branchCount }, (_, index) =>
        makeLineItem(branchCount === 1 ? tendon.id : `${tendon.id}:branch:${index + 1}`, tendon.label, tendon.color, 0, tendon.id)),
    };
  });
}

function makeConnectionBindings(scene: Scene, bodyBindings: BodyBinding[]): ConnectionBinding[] {
  const byId = new Map(bodyBindings.map(binding => [binding.body.id, binding]));
  return scene.connections.map(connection => {
    const bodyA = byId.get(connection.bodyA)!;
    const bodyB = connection.bodyB ? byId.get(connection.bodyB) : undefined;
    const anchorA = connection.kind === 'connect'
      ? inverseRotate(bodyA.body.orientation, subtract(connection.anchor, bodyA.body.position))
      : undefined;
    const anchorB = connection.kind === 'connect' && bodyB
      ? inverseRotate(bodyB.body.orientation, subtract(connection.anchor, bodyB.body.position))
      : undefined;
    return {
      connection,
      bodyA,
      bodyB,
      anchorA,
      anchorB,
      renderItem: makeLineItem(connection.id, connection.label, bodyA.body.color, 2),
    };
  });
}

function compiledBodyMaps(mujoco: MainModule, model: MjModel, scene: Scene): Map<string, number> {
  return new Map(scene.bodies.map(body => [body.id, idFor(mujoco, model, mujoco.mjtObj.mjOBJ_BODY.value, body.id)]));
}

function checkInitialConstraints(mujoco: MainModule, model: MjModel, data: MjData, scene: Scene): void {
  const equalityType = mujoco.mjtConstraint.mjCNSTR_EQUALITY.value;
  for (let row = 0; row < data.nefc; row++) {
    if (data.efc_type[row] === equalityType && Math.abs(data.efc_pos[row]) > INITIAL_CONSTRAINT_TOLERANCE) {
      throw new Error('Initial body poses and joint coordinates violate a declared equality connection or fixed tendon length.');
    }
  }
  for (const tendon of scene.tendons) {
    if (tendon.mode === 'spring') continue;
    const tendonId = idFor(mujoco, model, mujoco.mjtObj.mjOBJ_TENDON.value, tendon.id);
    const length = data.ten_length[tendonId];
    if (tendon.mode === 'fixed' && Math.abs(length - tendon.length) > INITIAL_CONSTRAINT_TOLERANCE) {
      throw new Error(`Fixed tendon ${tendon.label} does not start at its declared length.`);
    }
    if (tendon.mode === 'rope' && length > tendon.length + INITIAL_CONSTRAINT_TOLERANCE) {
      throw new Error(`Rope ${tendon.label} starts beyond its maximum length.`);
    }
  }
}

class MuJoCoRuntime implements MechanicsRuntime {
  readonly scene: Scene;
  private readonly mujoco: MainModule;
  private readonly model: MjModel;
  private readonly data: MjData;
  private readonly buffers: DoubleBuffer[];
  private readonly velocityBuffer: DoubleBuffer;
  private velocityView: Float64Array | null = null;
  private readonly clock = new FixedStepClock(FIXED_TIMESTEP);
  private readonly bodyBindings: BodyBinding[];
  private readonly tendonBindings: TendonBinding[];
  private readonly connectionBindings: ConnectionBinding[];
  private readonly bodyById: Map<string, BodyBinding>;
  private readonly renderItems: RenderItem[];
  private readonly warningBaseline: number[];
  private readonly initialQpos: Float64Array;
  private readonly initialQvel: Float64Array;
  private readonly contactMaterials: ContactFriction;
  private readonly contactForces: Float64Array;
  private readonly substeps: number;
  private readonly geometryBodies: Int32Array;
  private disposed = false;
  private constraintObservationsValid = false;

  constructor(
    mujoco: MainModule,
    model: MjModel,
    data: MjData,
    scene: Scene,
    bodyBindings: BodyBinding[],
    tendonBindings: TendonBinding[],
    connectionBindings: ConnectionBinding[],
    warningBaseline: number[],
    buffers: DoubleBuffer[],
  ) {
    this.mujoco = mujoco;
    this.model = model;
    this.data = data;
    this.buffers = buffers;
    this.velocityBuffer = new mujoco.DoubleBuffer(6);
    buffers.push(this.velocityBuffer);
    this.scene = scene;
    this.bodyBindings = bodyBindings;
    this.bodyById = new Map(bodyBindings.map(binding => [binding.body.id, binding]));
    this.tendonBindings = tendonBindings;
    this.connectionBindings = connectionBindings;
    const tendonItems = tendonBindings.flatMap(binding => binding.branches);
    this.renderItems = bodyBindings.map(binding => binding.renderItem)
      .concat(tendonItems, connectionBindings.map(binding => binding.renderItem));
    this.warningBaseline = warningBaseline;
    this.contactMaterials = new ContactFriction(mujoco, model, bodyBindings);
    this.contactForces = new Float64Array(model.nbody * 3);
    this.substeps = contactSubsteps(scene);
    this.geometryBodies = new Int32Array(model.geom_bodyid as ArrayLike<number>);
    const refreshReason = this.refreshCurrentState();
    if (refreshReason) throw new Error(refreshReason);
    this.initialQpos = data.qpos.slice();
    this.initialQvel = data.qvel.slice();
    this.updateFrame();
  }

  get time(): number {
    this.assertLive();
    return this.data.time;
  }

  frame(): RenderItem[] {
    this.assertLive();
    this.updateFrame();
    return this.renderItems;
  }

  snapshot(): InspectionSnapshot {
    this.assertLive();
    this.readContactForces();
    const entities: EntityObservation[] = [];
    const positions = this.data.xipos;
    const quaternions = this.data.xquat;
    const qpos = this.data.qpos;
    const qvel = this.data.qvel;
    for (const binding of this.bodyBindings) {
      const { body, id } = binding;
      const velocity = this.worldVelocity(id);
      const properties: Observation[] = [
        { label: 'Motion', value: body.motion.kind },
        { label: 'Shape', value: body.shape.kind },
        shapeLabel(body),
        { label: 'Position', value: vecAt(positions, id * 3), unit: 'm' },
        { label: 'Velocity', value: vecAt(velocity, 3), unit: 'm/s' },
      ];
      if (body.mass !== null) {
        properties.push({ label: 'Mass', value: this.model.body_mass[id], unit: 'kg' });
        const mass = this.model.body_mass[id];
        properties.push({ label: 'Linear momentum', value: [mass * velocity[3], mass * velocity[4], mass * velocity[5]], unit: 'kg·m/s' });
        properties.push({ label: 'Translational kinetic energy', value: mass * (velocity[3] ** 2 + velocity[4] ** 2 + velocity[5] ** 2) / 2, unit: 'J' });
        if (this.scene.gravity.some(value => value !== 0)) properties.push({
          label: 'Uniform-gravity potential (world origin)', unit: 'J',
          value: -mass * (this.scene.gravity[0] * positions[id * 3] + this.scene.gravity[1] * positions[id * 3 + 1] + this.scene.gravity[2] * positions[id * 3 + 2]),
        });
        if (body.motion.kind !== 'particle') {
          const inertiaOffset = id * 3;
          const inertia = this.model.body_inertia;
          properties.push({ label: 'Principal moments of inertia', value: [inertia[inertiaOffset], inertia[inertiaOffset + 1], inertia[inertiaOffset + 2]], unit: 'kg·m²' });
        }
      }
      if (body.shape.kind !== 'point') {
        properties.push({ label: 'Orientation (w,x,y,z)', value: [quaternions[id * 4], quaternions[id * 4 + 1], quaternions[id * 4 + 2], quaternions[id * 4 + 3]] });
        properties.push({ label: 'Angular velocity', value: vecAt(velocity, 0), unit: 'rad/s' });
      }
      if (body.motion.kind === 'hinge' || body.motion.kind === 'slide') {
        const coordinate = binding.coordinates[0];
        const angular = body.motion.kind === 'hinge';
        const unit = angular ? 'rad' : 'm';
        properties.push({ label: angular ? 'Joint angle' : 'Joint position', value: qpos[coordinate.qpos], unit });
        properties.push({ label: 'Joint rate', value: qvel[coordinate.dof], unit: angular ? 'rad/s' : 'm/s' });
        if (body.motion.limits) properties.push({ label: 'Joint limits', value: [...body.motion.limits], unit });
        if (body.motion.stiffness > 0) {
          properties.push({ label: 'Spring stiffness', value: body.motion.stiffness, unit: angular ? 'N·m/rad' : 'N/m' });
          properties.push({ label: 'Spring reference', value: body.motion.springReference, unit });
        }
        if (body.motion.damping > 0) properties.push({ label: 'Joint damping', value: body.motion.damping, unit: angular ? 'N·m·s/rad' : 'N·s/m' });
        if (body.motion.stiffness > 0 || body.motion.damping > 0) properties.push({
          label: angular ? 'Joint spring/damping torque' : 'Joint spring/damping force',
          value: -body.motion.stiffness * (qpos[coordinate.qpos] - body.motion.springReference) - body.motion.damping * qvel[coordinate.dof],
          unit: angular ? 'N·m' : 'N',
        });
      } else if (body.motion.kind === 'ball' && body.motion.damping > 0) {
        properties.push({ label: 'Rotational damping', value: body.motion.damping, unit: 'N·m·s/rad' });
      }
      if (body.shape.kind !== 'point') {
        properties.push({ label: 'Target restitution', value: body.restitution });
        properties.push({ label: 'Static friction coefficient', value: staticFriction(body) });
        properties.push({ label: 'Sliding friction coefficient', value: body.friction.sliding });
        properties.push({ label: 'Contact force', value: this.constraintObservationsValid ? vecAt(this.contactForces, id * 3) : 'Unavailable', unit: 'N' });
      }
      if (body.friction.torsional > 0) properties.push({ label: 'Torsional friction length', value: body.friction.torsional, unit: 'm' });
      if (body.friction.rolling > 0) properties.push({ label: 'Rolling friction length', value: body.friction.rolling, unit: 'm' });
      for (const load of this.scene.loads) {
        if (load.kind === 'gravity') {
          if (body.motion.kind === 'particle' && load.bodyIds.includes(body.id)) properties.push({ label: 'Mutual gravity G', value: load.G, unit: 'N·m²/kg²' });
          continue;
        }
        if (load.bodyId !== body.id) continue;
        if (load.kind === 'force') {
          properties.push({ label: 'Declared force', value: [...load.vector], unit: 'N' });
          if (load.point) properties.push({ label: 'Force point (body-local)', value: [...load.point], unit: 'm' });
        } else if (load.kind === 'torque') {
          properties.push({ label: 'Declared torque', value: [...load.vector], unit: 'N·m' });
        } else if (load.kind === 'impulse') {
          properties.push({ label: 'Initial linear impulse', value: [...load.linear], unit: 'N·s' });
          properties.push({ label: 'Initial angular impulse', value: [...load.angular], unit: 'N·m·s' });
        } else {
          properties.push({ label: 'Drag coefficient', value: load.coefficient, unit: 'N·s/m' });
          properties.push({ label: 'Medium velocity', value: [...load.mediumVelocity], unit: 'm/s' });
        }
      }
      entities.push({ id: body.id, label: body.label, kind: 'body', color: body.color, properties });
    }
    for (const binding of this.tendonBindings) {
      const { tendon, id } = binding;
      const length = this.data.ten_length[id];
      const velocity = this.data.ten_velocity[id];
      const route = tendon.path.map(part => {
        if (part.kind === 'site') return part.siteId;
        if (part.kind === 'wrap') return `wrap:${part.bodyId}${part.sideSiteId ? ` (${part.sideSiteId})` : ''}`;
        return `pulley:${part.divisor}`;
      }).join(' → ');
      const properties: Observation[] = [
        { label: 'Mode', value: tendon.mode },
        { label: 'Routing', value: route },
        { label: 'Length', value: length, unit: 'm' },
        { label: 'Length rate', value: velocity, unit: 'm/s' },
      ];
      if (tendon.mode === 'spring') {
        const extension = length - tendon.length;
        properties.push({ label: 'Rest length', value: tendon.length, unit: 'm' });
        properties.push({ label: 'Extension', value: extension, unit: 'm' });
        properties.push({ label: 'Stiffness', value: tendon.stiffness, unit: 'N/m' });
        properties.push({ label: 'Damping', value: tendon.damping, unit: 'N·s/m' });
        properties.push({ label: 'Axial force', value: tendon.stiffness * extension + tendon.damping * velocity, unit: 'N' });
      } else {
        if (tendon.mode === 'fixed') properties.push({ label: 'Target length', value: tendon.length, unit: 'm' });
        const tension = this.constraintObservationsValid ? this.tendonTension(binding) : null;
        if (tension !== null) properties.push({ label: 'Tension', value: tension, unit: 'N' });
        if (tendon.mode === 'rope') properties.push({ label: 'Maximum length', value: tendon.length, unit: 'm' });
      }
      entities.push({ id: tendon.id, label: tendon.label, kind: 'tendon', color: tendon.color, properties });
    }
    for (const binding of this.connectionBindings) {
      const { connection } = binding;
      const properties: Observation[] = [
        { label: 'Type', value: connection.kind },
        { label: 'Bodies', value: `${connection.bodyA} — ${connection.bodyB ?? 'world'}` },
      ];
      if (connection.kind === 'connect') properties.push({ label: 'Reference anchor', value: [...connection.anchor], unit: 'm' });
      if (connection.kind === 'coupling') {
        const motionA = this.bodyById.get(connection.bodyA)!.body.motion;
        const motionB = this.bodyById.get(connection.bodyB)!.body.motion;
        const unitA = motionA.kind === 'hinge' ? 'rad' : 'm';
        const unitB = motionB.kind === 'hinge' ? 'rad' : 'm';
        properties.push({ label: 'Ratio', value: connection.ratio, unit: `${unitB}/${unitA}` });
        properties.push({ label: 'Offset', value: connection.offset, unit: unitB });
      }
      entities.push({ id: connection.id, label: connection.label, kind: 'connection', color: binding.bodyA.body.color, properties });
    }
    const notes: string[] = [
      'Contact restitution is a numerical target; pair restitution uses the minimum and friction the maximum.',
      'Contact forces are instantaneous, not averaged; compliant contact can have small numerical jitter.',
      `Native timestep ${FIXED_TIMESTEP / this.substeps} s; static/kinetic switching tolerance 0.001 m/s. Energy rows distinguish kinetic components and uniform gravity, not a universal conserved total.`,
    ];
    if (this.scene.bodies.some(body => body.motion.kind === 'particle')) notes.push(PARTICLE_INERTIA_NOTE);
    if (!this.constraintObservationsValid) notes.push('Constraint-force observations are unavailable after a singular or numerically invalid step.');
    return { time: this.data.time, entities, notes };
  }

  advance(wallSeconds: number, speed: number, workBudgetMs = Infinity): AdvanceResult {
    this.assertLive();
    const visible = typeof document === 'undefined' || !document.hidden;
    // Unfinished fixed steps stay queued in the clock when the caller's work budget runs out; none are skipped.
    const deadline = performance.now() + workBudgetMs;
    let stepped = 0;
    const result = this.clock.advance(wallSeconds, speed, () => {
      if (stepped > 0 && performance.now() > deadline) return DEFERRED_STEP;
      stepped += 1;
      return this.step();
    }, visible);
    if (result.steps > 0) {
      const refreshReason = this.refreshCurrentState();
      if (refreshReason) result.pauseReason = result.pauseReason ? `${result.pauseReason} ${refreshReason}` : refreshReason;
    }
    return result;
  }

  reset(): void {
    this.assertLive();
    this.mujoco.mj_resetData(this.model, this.data);
    this.data.qpos.set(this.initialQpos);
    this.data.qvel.set(this.initialQvel);
    this.clock.reset();
    this.warningBaseline.fill(0);
    const reason = this.refreshCurrentState();
    if (reason) throw new Error(reason);
    this.updateFrame();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.data.delete();
    this.model.delete();
    for (const buffer of this.buffers) buffer.delete();
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('The MuJoCo runtime has been disposed.');
  }

  private updateFrame(): void {
    const xpos = this.data.xpos;
    const xquat = this.data.xquat;
    for (const binding of this.bodyBindings) {
      const { id, renderItem } = binding;
      setVec(renderItem.position, xpos, id * 3);
      setThreeQuat(renderItem.quaternion, xquat, id * 4);
    }
    const wrapPositions = this.data.wrap_xpos;
    const wrapAddresses = this.data.ten_wrapadr;
    const wrapObjects = this.data.wrap_obj;
    for (const binding of this.tendonBindings) {
      let branchIndex = 0;
      let pointIndex = 0;
      let points = binding.branches[0].points!;
      const end = wrapAddresses[binding.id] + this.data.ten_wrapnum[binding.id];
      for (let index = wrapAddresses[binding.id]; index < end; index++) {
        if (wrapObjects[index] === -2) {
          points.length = pointIndex;
          const next = binding.branches[++branchIndex];
          if (!next) throw new Error('Native cable branches do not match the compiled model.');
          points = next.points!;
          pointIndex = 0;
        } else {
          if (!points[pointIndex]) points[pointIndex] = [0, 0, 0];
          setVec(points[pointIndex++], wrapPositions, index * 3);
        }
      }
      points.length = pointIndex;
      if (branchIndex + 1 !== binding.branches.length) throw new Error('Native cable branch data is incomplete.');
    }
    for (const binding of this.connectionBindings) {
      const { connection, bodyA, bodyB, renderItem } = binding;
      const points = renderItem.points!;
      if (connection.kind === 'connect') {
        setWorldPoint(points[0], xpos, xquat, bodyA.id * 3, bodyA.id * 4, binding.anchorA!);
        if (bodyB && binding.anchorB) {
          setWorldPoint(points[1], xpos, xquat, bodyB.id * 3, bodyB.id * 4, binding.anchorB);
        } else {
          setVec(points[1], connection.anchor, 0);
        }
      } else {
        setVec(points[0], xpos, bodyA.id * 3);
        if (bodyB) setVec(points[1], xpos, bodyB.id * 3);
        else {
          points[1][0] = 0;
          points[1][1] = 0;
          points[1][2] = 0;
        }
      }
    }
  }

  private step(): { advanced: boolean; pauseReason: string | null } {
    for (let substep = 0; substep < this.substeps; substep++) {
      this.mujoco.mj_step1(this.model, this.data);
      this.contactMaterials.update(this.data);
      this.clearCustomForces();
      const singular = this.gravitySingularity();
      if (singular) {
        this.constraintObservationsValid = false;
        return { advanced: substep > 0, pauseReason: singular };
      }
      this.constraintObservationsValid = false;
      this.applyLoads();
      this.mujoco.mj_step2(this.model, this.data);
    }
    const warning = this.newWarning();
    if (warning) return { advanced: true, pauseReason: warning };
    if (nonfiniteState(this.data)) return { advanced: true, pauseReason: 'MuJoCo produced a non-finite state; simulation paused.' };
    return COMPLETED_STEP;
  }

  private clearCustomForces(): void {
    this.data.xfrc_applied.fill(0);
    this.data.qfrc_applied.fill(0);
  }

  private addWrench(bodyId: number, fx: number, fy: number, fz: number, tx: number, ty: number, tz: number): void {
    const applied = this.data.xfrc_applied;
    const offset = bodyId * 6;
    applied[offset] += fx;
    applied[offset + 1] += fy;
    applied[offset + 2] += fz;
    applied[offset + 3] += tx;
    applied[offset + 4] += ty;
    applied[offset + 5] += tz;
  }

  private worldVelocity(bodyId: number): Float64Array {
    this.mujoco.mj_objectVelocity(this.model, this.data, this.mujoco.mjtObj.mjOBJ_BODY.value, bodyId, this.velocityBuffer, 0);
    if (!this.velocityView || this.velocityView.byteLength === 0) this.velocityView = this.velocityBuffer.GetView() as Float64Array;
    return this.velocityView;
  }

  private readContactForces(): void {
    this.contactForces.fill(0);
    if (!this.constraintObservationsValid || !this.data.ncon) return;
    const contacts = this.data.contact;
    const geomBodies = this.geometryBodies;
    try {
      for (let index = 0; index < this.data.ncon; index++) {
        const contact = contacts.get(index);
        if (!contact) continue;
        try {
          this.mujoco.mj_contactForce(this.model, this.data, index, this.velocityBuffer);
          const force = this.velocityBuffer.GetView() as Float64Array;
          const frame = contact.frame;
          for (let axis = 0; axis < 3; axis++) {
            const component = frame[axis] * force[0] + frame[3 + axis] * force[1] + frame[6 + axis] * force[2];
            this.contactForces[geomBodies[contact.geom1] * 3 + axis] -= component;
            this.contactForces[geomBodies[contact.geom2] * 3 + axis] += component;
          }
        } finally {
          contact.delete();
        }
      }
    } finally {
      contacts.delete();
    }
  }

  private applyLoads(): void {
    const xpos = this.data.xpos;
    const xipos = this.data.xipos;
    const xquat = this.data.xquat;
    for (const load of this.scene.loads) {
      if (load.kind === 'impulse') continue;
      if (load.kind === 'gravity') {
        for (let a = 0; a < load.bodyIds.length; a++) for (let b = a + 1; b < load.bodyIds.length; b++) {
          const first = this.bodyById.get(load.bodyIds[a])!;
          const second = this.bodyById.get(load.bodyIds[b])!;
          const firstOffset = first.id * 3;
          const secondOffset = second.id * 3;
          const dx = xipos[secondOffset] - xipos[firstOffset];
          const dy = xipos[secondOffset + 1] - xipos[firstOffset + 1];
          const dz = xipos[secondOffset + 2] - xipos[firstOffset + 2];
          const distanceSquared = dx * dx + dy * dy + dz * dz;
          const scale = load.G * first.body.mass! * second.body.mass! / (distanceSquared * Math.sqrt(distanceSquared));
          const fx = dx * scale;
          const fy = dy * scale;
          const fz = dz * scale;
          this.addWrench(first.id, fx, fy, fz, 0, 0, 0);
          this.addWrench(second.id, -fx, -fy, -fz, 0, 0, 0);
        }
      } else if (load.kind === 'drag') {
        const id = this.bodyById.get(load.bodyId)!.id;
        const velocity = this.worldVelocity(id);
        this.addWrench(id, load.coefficient * (load.mediumVelocity[0] - velocity[3]), load.coefficient * (load.mediumVelocity[1] - velocity[4]), load.coefficient * (load.mediumVelocity[2] - velocity[5]), 0, 0, 0);
      } else if (load.kind === 'torque') {
        const id = this.bodyById.get(load.bodyId)!.id;
        this.addWrench(id, 0, 0, 0, load.vector[0], load.vector[1], load.vector[2]);
      } else {
        const id = this.bodyById.get(load.bodyId)!.id;
        let tx = 0;
        let ty = 0;
        let tz = 0;
        if (load.point) {
          const position = id * 3;
          const rotation = id * 4;
          const w = xquat[rotation];
          const x = xquat[rotation + 1];
          const y = xquat[rotation + 2];
          const z = xquat[rotation + 3];
          const px = load.point[0];
          const py = load.point[1];
          const pz = load.point[2];
          const rx = 2 * (y * pz - z * py);
          const ry = 2 * (z * px - x * pz);
          const rz = 2 * (x * py - y * px);
          const worldX = xpos[position] + px + w * rx + y * rz - z * ry;
          const worldY = xpos[position + 1] + py + w * ry + z * rx - x * rz;
          const worldZ = xpos[position + 2] + pz + w * rz + x * ry - y * rx;
          const armX = worldX - xipos[position];
          const armY = worldY - xipos[position + 1];
          const armZ = worldZ - xipos[position + 2];
          tx = armY * load.vector[2] - armZ * load.vector[1];
          ty = armZ * load.vector[0] - armX * load.vector[2];
          tz = armX * load.vector[1] - armY * load.vector[0];
        }
        this.addWrench(id, load.vector[0], load.vector[1], load.vector[2], tx, ty, tz);
      }
    }
  }

  private gravitySingularity(): string | null {
    const xipos = this.data.xipos;
    for (const load of this.scene.loads) {
      if (load.kind !== 'gravity') continue;
      for (let a = 0; a < load.bodyIds.length; a++) for (let b = a + 1; b < load.bodyIds.length; b++) {
        const first = this.bodyById.get(load.bodyIds[a])!;
        const second = this.bodyById.get(load.bodyIds[b])!;
        const firstOffset = first.id * 3;
        const secondOffset = second.id * 3;
        const dx = xipos[firstOffset] - xipos[secondOffset];
        const dy = xipos[firstOffset + 1] - xipos[secondOffset + 1];
        const dz = xipos[firstOffset + 2] - xipos[secondOffset + 2];
        if (dx * dx + dy * dy + dz * dz === 0) return 'Mutual gravity became singular at coincident particles; simulation paused.';
      }
    }
    return null;
  }

  private newWarning(): string | null {
    const warnings = this.data.warning;
    for (let index = 0; index < this.warningBaseline.length; index++) {
      const warning = warnings.get(index);
      const count = warning?.number ?? 0;
      warning?.delete();
      if (count > this.warningBaseline[index]) {
        this.warningBaseline[index] = count;
        return `MuJoCo reported a new ${WARNING_LABELS[index] ?? 'numerical'} warning; simulation paused.`;
      }
    }
    return null;
  }

  private refreshCurrentState(): string | null {
    this.mujoco.mj_step1(this.model, this.data);
    this.contactMaterials.update(this.data);
    this.clearCustomForces();
    const singular = this.gravitySingularity();
    if (singular) {
      this.constraintObservationsValid = false;
      return singular;
    }
    this.applyLoads();
    this.mujoco.mj_forwardSkip(this.model, this.data, this.mujoco.mjtStage.mjSTAGE_VEL.value, 0);
    const warning = this.newWarning();
    if (warning) return warning;
    if (nonfiniteState(this.data)) return 'MuJoCo produced a non-finite state; simulation paused.';
    this.constraintObservationsValid = true;
    return null;
  }

  private tendonTension(binding: TendonBinding): number | null {
    const constraintType = binding.equalityId === null
      ? this.mujoco.mjtConstraint.mjCNSTR_LIMIT_TENDON.value
      : this.mujoco.mjtConstraint.mjCNSTR_EQUALITY.value;
    const constraintId = binding.equalityId ?? binding.id;
    let row = -1;
    for (let index = 0; index < this.data.nefc; index++) {
      if (this.data.efc_type[index] === constraintType && this.data.efc_id[index] === constraintId) {
        row = index;
        break;
      }
    }
    if (row < 0) return binding.tendon.mode === 'rope' ? 0 : null;
    const tendonAdr = this.model.ten_J_rowadr[binding.id];
    const tendonNnz = this.model.ten_J_rownnz[binding.id];
    if (tendonNnz === 0) return null;
    const tendonColumns = this.model.ten_J_colind;
    const tendonValues = this.data.ten_J;
    const rowNnz = this.data.efc_J_rownnz[row];
    const efcRowAddress = this.data.efc_J_rowadr[row];
    const efcColumns = this.data.efc_J_colind;
    const efcValues = this.data.efc_J;
    const sparse = this.mujoco.mj_isSparse(this.model) !== 0;
    let dot = 0;
    let normSquared = 0;
    for (let tendonOffset = 0; tendonOffset < tendonNnz; tendonOffset++) {
      const tendonIndex = tendonAdr + tendonOffset;
      const column = tendonColumns[tendonIndex];
      const tendonValue = tendonValues[tendonIndex];
      normSquared += tendonValue * tendonValue;
      if (!sparse) {
        dot += efcValues[row * this.model.nv + column] * tendonValue;
      } else {
        for (let rowOffset = 0; rowOffset < rowNnz; rowOffset++) {
          const efcIndex = efcRowAddress + rowOffset;
          if (efcColumns[efcIndex] === column) dot += efcValues[efcIndex] * tendonValue;
        }
      }
    }
    if (normSquared === 0) return null;
    const orientation = dot / normSquared;
    if (Math.abs(orientation) < 0.5) return null;
    const tension = -orientation * this.data.efc_force[row];
    return binding.tendon.mode === 'rope' ? Math.max(0, tension) : tension;
  }

}

export async function createRuntime(input: Scene): Promise<MechanicsRuntime> {
  const scene = physicalScene(validateScene(input));
  const mujoco = await engine();
  let model: MjModel | undefined;
  let data: MjData | undefined;
  const buffers: DoubleBuffer[] = [];
  try {
    model = mujoco.MjModel.from_xml_string(compileMjcf(scene));
    configureFixedTendonTargets(mujoco, model, scene);
    data = new mujoco.MjData(model);
    const bodyBindings = makeBodyBindings(mujoco, model, scene);
    const bodyIds = compiledBodyMaps(mujoco, model, scene);
    const jacobianPosition = model.nv ? new mujoco.DoubleBuffer(3 * model.nv) : null;
    if (jacobianPosition) buffers.push(jacobianPosition);
    const jacobianRotation = model.nv ? new mujoco.DoubleBuffer(3 * model.nv) : null;
    if (jacobianRotation) buffers.push(jacobianRotation);
    const velocityChange = model.nv ? new mujoco.DoubleBuffer(model.nv) : null;
    if (velocityChange) buffers.push(velocityChange);
    const warningBaseline = warningCounts(data);
    initializeVelocities(data, bodyBindings);
    mujoco.mj_forward(model, data);
    checkInitialConstraints(mujoco, model, data, scene);
    initializeImpulses(mujoco, model, data, scene, bodyIds, jacobianPosition, jacobianRotation, velocityChange, new Array<number>(model.nv).fill(0));
    mujoco.mj_forward(model, data);
    const tendonBindings = makeTendonBindings(mujoco, model, scene);
    const connectionBindings = makeConnectionBindings(scene, bodyBindings);
    const runtime = new MuJoCoRuntime(mujoco, model, data, scene, bodyBindings, tendonBindings, connectionBindings, warningBaseline, buffers);
    return runtime;
  } catch (error) {
    data?.delete();
    model?.delete();
    for (const buffer of buffers) buffer.delete();
    throw error;
  }
}
