import type { DoubleBuffer, MainModule, MjData, MjModel } from '@mujoco/mujoco';
import { physicalScene, validateScene } from '../../shared/scene.ts';
import type { Body, Quat, Scene, ScheduledEvent, Vec3 } from '../../shared/scene.ts';
import { FixedStepClock, FIXED_TIMESTEP } from './clock.ts';
import { compileMjcf, fixedTendonEqualityName, geomName, heldWeldName, jointName, PARTICLE_JOINT_SUFFIXES } from './mjcf.ts';
import { ContactFriction, contactSubsteps, staticFriction } from './materials.ts';
import { ContactEquilibrium } from './equilibrium.ts';
import type { AdvanceResult, ContactObservation, EntityObservation, InspectionSnapshot, MechanicsRuntime, Observation, RenderItem } from './types.ts';

const INITIAL_CONSTRAINT_TOLERANCE = 1e-4;
const PARTICLE_INERTIA_NOTE = 'Point particles have translation only; compiler-required rotational inertia is not a physical observation.';
const WARNING_LABELS: Record<number, string> = {
  0: 'inertia', 1: 'contact capacity', 2: 'constraint capacity', 3: 'position', 4: 'velocity', 5: 'acceleration', 6: 'control',
};
const COMPLETED_STEP = { advanced: true, pauseReason: null } as const;
const DEFERRED_STEP = { advanced: false, pauseReason: null } as const;
const MAX_SNAPSHOT_CONTACTS = 64;
const WRAP_ARC_SEGMENTS = 32;
const TWO_PI = 2 * Math.PI;

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
  jointReference?: { jointId: number; renderItem: RenderItem };
}
interface HeldBinding {
  body: BodyBinding;
  equalityId: number;
  geomId: number;
}

interface EventState {
  event: ScheduledEvent;
  index: number;
  firedAt: number | null;
}

// Explicit pairs bypass geometry masks, so suppress their contacts until release.
const HIDDEN_PAIR_MARGIN = -Number.MAX_VALUE;

class HeldBodyState {
  private readonly bindings: Map<string, HeldBinding>;
  private readonly heldBodyIds: Set<number>;
  private readonly initialPairMargins: Float64Array;
  private readonly model: MjModel;

  constructor(model: MjModel, bindings: HeldBinding[]) {
    this.model = model;
    this.bindings = new Map(bindings.map(binding => [binding.body.body.id, binding]));
    this.heldBodyIds = new Set(bindings.map(binding => binding.body.id));
    this.initialPairMargins = new Float64Array(model.pair_margin as ArrayLike<number>);
  }

  reset(data: MjData): void {
    this.heldBodyIds.clear();
    for (const binding of this.bindings.values()) {
      this.heldBodyIds.add(binding.body.id);
      data.eq_active[binding.equalityId] = 1;
      (this.model.geom_contype as Int32Array)[binding.geomId] = 0;
      (this.model.geom_conaffinity as Int32Array)[binding.geomId] = 0;
      (this.model.body_contype as Int32Array)[binding.body.id] = 0;
      (this.model.body_conaffinity as Int32Array)[binding.body.id] = 0;
    }
    this.updatePairMargins();
  }

  isHeld(bodyId: string): boolean {
    return this.bindings.has(bodyId) && this.heldBodyIds.has(this.bindings.get(bodyId)!.body.id);
  }

  release(data: MjData, bodyId: string): BodyBinding {
    const binding = this.bindings.get(bodyId);
    if (!binding || !this.heldBodyIds.delete(binding.body.id)) throw new Error(`Body ${bodyId} is not currently held.`);
    data.eq_active[binding.equalityId] = 0;
    (this.model.geom_contype as Int32Array)[binding.geomId] = 1;
    (this.model.geom_conaffinity as Int32Array)[binding.geomId] = 1;
    (this.model.body_contype as Int32Array)[binding.body.id] = 1;
    (this.model.body_conaffinity as Int32Array)[binding.body.id] = 1;
    this.updatePairMargins();
    return binding.body;
  }

  private updatePairMargins(): void {
    const margins = this.model.pair_margin as Float64Array;
    for (let pair = 0; pair < this.model.npair; pair++) {
      const firstBody = this.model.geom_bodyid[this.model.pair_geom1[pair]];
      const secondBody = this.model.geom_bodyid[this.model.pair_geom2[pair]];
      margins[pair] = this.heldBodyIds.has(firstBody) || this.heldBodyIds.has(secondBody)
        ? HIDDEN_PAIR_MARGIN
        : this.initialPairMargins[pair];
    }
  }
}



interface TendonBinding {
  tendon: Scene['tendons'][number];
  id: number;
  equalityId: number | null;
  branches: RenderItem[];
  branchDivisors: number[];
  pointPools: Vec3[][];
  pointCounts: number[];
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
function makeTendonItem(id: string, tendon: Scene['tendons'][number]): RenderItem {
  const item = makeLineItem(id, tendon.label, tendon.color, 0, tendon.id);
  item.tendon = {
    mode: tendon.mode,
    length: 0,
    restLength: tendon.length,
    force: null,
    wrapped: [],
    ...(tendon.visual ? { visual: tendon.visual } : {}),
  };
  return item;
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
  return scene.bodies.map(body => {
    const jointId = body.motion.kind === 'hinge' || body.motion.kind === 'ball'
      ? idFor(mujoco, model, mujoco.mjtObj.mjOBJ_JOINT.value, jointName(body.id))
      : undefined;
    const renderItem = jointId === undefined ? undefined : {
      ...makeLineItem(`joint-link:${body.id}`, `${body.label} joint link`, body.color, 2, body.id),
      selectable: false,
    };
    return {
      body,
      id: idFor(mujoco, model, mujoco.mjtObj.mjOBJ_BODY.value, body.id),
      coordinates: coordinatesFor(mujoco, model, body),
      renderItem: makeBodyItem(body),
      ...(jointId === undefined ? {} : { jointReference: { jointId, renderItem: renderItem! } }),
    };
  });
}
function makeHeldBindings(mujoco: MainModule, model: MjModel, bindings: BodyBinding[]): HeldBinding[] {
  return bindings.filter(binding => binding.body.heldBy !== null).map(body => ({
    body,
    equalityId: idFor(mujoco, model, mujoco.mjtObj.mjOBJ_EQUALITY.value, heldWeldName(body.body.id)),
    geomId: idFor(mujoco, model, mujoco.mjtObj.mjOBJ_GEOM.value, geomName(body.body.id)),
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

function applyGeneralizedImpulse(
  mujoco: MainModule,
  model: MjModel,
  data: MjData,
  bodyId: number,
  linear: Vec3,
  angular: Vec3,
  jacobianPosition: DoubleBuffer | null,
  jacobianRotation: DoubleBuffer | null,
  velocityChange: DoubleBuffer | null,
  generalizedImpulse: number[],
): void {
  if (!jacobianPosition || !jacobianRotation || !velocityChange) return;
  generalizedImpulse.fill(0);
  const nv = model.nv;
  mujoco.mj_jacBodyCom(model, data, jacobianPosition, jacobianRotation, bodyId);
  const positionJacobian = jacobianPosition.GetView() as Float64Array;
  const rotationJacobian = jacobianRotation.GetView() as Float64Array;
  for (let dof = 0; dof < nv; dof++) {
    generalizedImpulse[dof] =
      positionJacobian[dof] * linear[0] + positionJacobian[nv + dof] * linear[1] + positionJacobian[2 * nv + dof] * linear[2] +
      rotationJacobian[dof] * angular[0] + rotationJacobian[nv + dof] * angular[1] + rotationJacobian[2 * nv + dof] * angular[2];
  }
  mujoco.mj_solveM(model, data, velocityChange, generalizedImpulse);
  const deltaVelocity = velocityChange.GetView() as Float64Array;
  const qvel = data.qvel;
  for (let dof = 0; dof < nv; dof++) qvel[dof] += deltaVelocity[dof];
}

interface RigidAggregate {
  mass: number;
  center: Vec3;
  momentum: Vec3;
  angularMomentum: Vec3;
  inertia: number[];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function bodyInertiaWorld(model: MjModel, data: MjData, bodyId: number): number[] {
  const rotation = data.ximat;
  const moments = model.body_inertia;
  const rotationOffset = bodyId * 9;
  const inertiaOffset = bodyId * 3;
  const inertia = new Array<number>(9).fill(0);
  for (let row = 0; row < 3; row++) for (let column = 0; column < 3; column++) {
    for (let axis = 0; axis < 3; axis++) {
      inertia[row * 3 + column] += rotation[rotationOffset + row * 3 + axis]
        * moments[inertiaOffset + axis] * rotation[rotationOffset + column * 3 + axis];
    }
  }
  return inertia;
}

function rigidAggregate(
  mujoco: MainModule,
  model: MjModel,
  data: MjData,
  members: BodyBinding[],
  velocityBuffer: DoubleBuffer,
): RigidAggregate {
  let mass = 0;
  const centerMass: Vec3 = [0, 0, 0];
  const momentum: Vec3 = [0, 0, 0];
  const angularMomentum: Vec3 = [0, 0, 0];
  const positions = data.xipos;
  for (const member of members) {
    const bodyId = member.id;
    const bodyMass = model.body_mass[bodyId];
    if (bodyMass === 0) continue;
    const offset = bodyId * 3;
    const position: Vec3 = [positions[offset], positions[offset + 1], positions[offset + 2]];
    mujoco.mj_objectVelocity(model, data, mujoco.mjtObj.mjOBJ_BODY.value, bodyId, velocityBuffer, 0);
    const velocity = velocityBuffer.GetView() as Float64Array;
    const angular: Vec3 = [velocity[0], velocity[1], velocity[2]];
    const linear: Vec3 = [velocity[3], velocity[4], velocity[5]];
    const bodyMomentum: Vec3 = [bodyMass * linear[0], bodyMass * linear[1], bodyMass * linear[2]];
    const inertia = bodyInertiaWorld(model, data, bodyId);
    const orbital = cross(position, bodyMomentum);
    mass += bodyMass;
    for (let axis = 0; axis < 3; axis++) {
      centerMass[axis] += bodyMass * position[axis];
      momentum[axis] += bodyMomentum[axis];
      angularMomentum[axis] += orbital[axis]
        + inertia[axis * 3] * angular[0] + inertia[axis * 3 + 1] * angular[1] + inertia[axis * 3 + 2] * angular[2];
    }
  }
  if (!(mass > 0) || !Number.isFinite(mass)) throw new Error('A free carried group needs positive finite native mass.');
  const center: Vec3 = [centerMass[0] / mass, centerMass[1] / mass, centerMass[2] / mass];
  const inertia = new Array<number>(9).fill(0);
  for (const member of members) {
    const bodyId = member.id;
    const bodyMass = model.body_mass[bodyId];
    if (bodyMass === 0) continue;
    const offset = bodyId * 3;
    const dx = positions[offset] - center[0];
    const dy = positions[offset + 1] - center[1];
    const dz = positions[offset + 2] - center[2];
    const distanceSquared = dx * dx + dy * dy + dz * dz;
    const bodyInertia = bodyInertiaWorld(model, data, bodyId);
    const arm: Vec3 = [dx, dy, dz];
    for (let row = 0; row < 3; row++) for (let column = 0; column < 3; column++) {
      const delta = row === column ? distanceSquared : 0;
      inertia[row * 3 + column] += bodyInertia[row * 3 + column] + bodyMass * (delta - arm[row] * arm[column]);
    }
  }
  return { mass, center, momentum, angularMomentum, inertia };
}

function solveSymmetric3(matrix: number[], rightHandSide: Vec3): Vec3 {
  const [a, b, c, d, e, f, g, h, i] = matrix;
  const determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  let scale = 0;
  for (const value of matrix) scale = Math.max(scale, Math.abs(value));
  if (!(determinant > Number.EPSILON * scale ** 3 * 16)) throw new Error('The carried group has a singular mass response.');
  return [
    ((e * i - f * h) * rightHandSide[0] + (c * h - b * i) * rightHandSide[1] + (b * f - c * e) * rightHandSide[2]) / determinant,
    ((f * g - d * i) * rightHandSide[0] + (a * i - c * g) * rightHandSide[1] + (c * d - a * f) * rightHandSide[2]) / determinant,
    ((d * h - e * g) * rightHandSide[0] + (b * g - a * h) * rightHandSide[1] + (a * e - b * d) * rightHandSide[2]) / determinant,
  ];
}

function setFreeVelocity(data: MjData, binding: BodyBinding, linear: Vec3, angular: Vec3): void {
  if (binding.body.motion.kind !== 'free') throw new Error(`Body ${binding.body.id} is not a free rigid body.`);
  const dof = binding.coordinates[0].dof;
  const qvel = data.qvel;
  qvel[dof] = linear[0];
  qvel[dof + 1] = linear[1];
  qvel[dof + 2] = linear[2];
  const quaternion = data.xquat;
  const orientation: Quat = [quaternion[binding.id * 4], quaternion[binding.id * 4 + 1], quaternion[binding.id * 4 + 2], quaternion[binding.id * 4 + 3]];
  const localAngular = inverseRotate(orientation, angular);
  qvel[dof + 3] = localAngular[0];
  qvel[dof + 4] = localAngular[1];
  qvel[dof + 5] = localAngular[2];
}
function initializeHeldVelocities(
  mujoco: MainModule,
  model: MjModel,
  data: MjData,
  bindings: BodyBinding[],
  bodyById: Map<string, BodyBinding>,
  velocityBuffer: DoubleBuffer,
): void {
  const positions = data.xipos;
  for (const binding of bindings) {
    const carrierId = binding.body.heldBy;
    if (carrierId === null) continue;
    const carrier = bodyById.get(carrierId)!;
    mujoco.mj_objectVelocity(model, data, mujoco.mjtObj.mjOBJ_BODY.value, carrier.id, velocityBuffer, 0);
    const velocity = velocityBuffer.GetView() as Float64Array;
    const angular: Vec3 = [velocity[0], velocity[1], velocity[2]];
    const arm = subtract(vecAt(positions, binding.id * 3), vecAt(positions, carrier.id * 3));
    const rotational = cross(angular, arm);
    setFreeVelocity(data, binding, [
      velocity[3] + rotational[0],
      velocity[4] + rotational[1],
      velocity[5] + rotational[2],
    ], angular);
  }
}


function applyAggregateImpulse(
  mujoco: MainModule,
  model: MjModel,
  data: MjData,
  members: BodyBinding[],
  target: BodyBinding,
  linearImpulse: Vec3,
  angularImpulse: Vec3,
  velocityBuffer: DoubleBuffer,
): void {
  const aggregate = rigidAggregate(mujoco, model, data, members, velocityBuffer);
  const targetPosition = vecAt(data.xipos, target.id * 3);
  const positionMoment = cross(targetPosition, linearImpulse);
  const newMomentum: Vec3 = [
    aggregate.momentum[0] + linearImpulse[0],
    aggregate.momentum[1] + linearImpulse[1],
    aggregate.momentum[2] + linearImpulse[2],
  ];
  const newAngularMomentum: Vec3 = [
    aggregate.angularMomentum[0] + positionMoment[0] + angularImpulse[0],
    aggregate.angularMomentum[1] + positionMoment[1] + angularImpulse[1],
    aggregate.angularMomentum[2] + positionMoment[2] + angularImpulse[2],
  ];
  const centerMoment = cross(aggregate.center, newMomentum);
  const angularVelocity = solveSymmetric3(aggregate.inertia, [
    newAngularMomentum[0] - centerMoment[0],
    newAngularMomentum[1] - centerMoment[1],
    newAngularMomentum[2] - centerMoment[2],
  ]);
  const linearVelocity: Vec3 = [newMomentum[0] / aggregate.mass, newMomentum[1] / aggregate.mass, newMomentum[2] / aggregate.mass];
  const positions = data.xipos;
  for (const member of members) {
    const offset = member.id * 3;
    const arm: Vec3 = [positions[offset] - aggregate.center[0], positions[offset + 1] - aggregate.center[1], positions[offset + 2] - aggregate.center[2]];
    const rotational = cross(angularVelocity, arm);
    setFreeVelocity(data, member, [
      linearVelocity[0] + rotational[0],
      linearVelocity[1] + rotational[1],
      linearVelocity[2] + rotational[2],
    ], angularVelocity);
  }
}

function initializeImpulses(
  mujoco: MainModule,
  model: MjModel,
  data: MjData,
  scene: Scene,
  bodyById: Map<string, BodyBinding>,
  heldByCarrier: Map<string, BodyBinding[]>,
  jacobianPosition: DoubleBuffer | null,
  jacobianRotation: DoubleBuffer | null,
  velocityChange: DoubleBuffer | null,
  velocityBuffer: DoubleBuffer,
  generalizedImpulse: number[],
): void {
  for (const load of scene.loads) {
    if (load.kind !== 'impulse') continue;
    const target = bodyById.get(load.bodyId)!;
    const carrierId = target.body.heldBy ?? load.bodyId;
    const carrier = bodyById.get(carrierId)!;
    const payloads = heldByCarrier.get(carrierId);
    if (payloads?.length) {
      if (carrier.body.motion.kind === 'free') {
        applyAggregateImpulse(mujoco, model, data, [carrier, ...payloads], target, load.linear, load.angular, velocityBuffer);
      }
    } else {
      applyGeneralizedImpulse(mujoco, model, data, target.id, load.linear, load.angular,
        jacobianPosition, jacobianRotation, velocityChange, generalizedImpulse);
      }
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
    const branchDivisors = [1];
    for (const part of tendon.path) if (part.kind === 'pulley') branchDivisors.push(part.divisor);
    return {
      tendon,
      id,
      equalityId: tendon.mode === 'fixed'
        ? idFor(mujoco, model, mujoco.mjtObj.mjOBJ_EQUALITY.value, fixedTendonEqualityName(tendon.id))
        : null,
      branchDivisors,
      pointPools: branchDivisors.map(() => []),
      pointCounts: branchDivisors.map(() => 0),
      branches: branchDivisors.map((_, index) =>
        makeTendonItem(branchDivisors.length === 1 ? tendon.id : `${tendon.id}:branch:${index + 1}`, tendon)),
    };
  });
}
function resetTendonPaths(binding: TendonBinding): void {
  for (let branchIndex = 0; branchIndex < binding.branches.length; branchIndex++) {
    binding.pointCounts[branchIndex] = 0;
  }
}

function appendTendonPoint(binding: TendonBinding, branchIndex: number, x: number, y: number, z: number, wrapped: boolean): void {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    throw new Error('Native tendon path contains a non-finite point.');
  }
  const item = binding.branches[branchIndex]!;
  const points = item.points!;
  const index = binding.pointCounts[branchIndex]!;
  const pool = binding.pointPools[branchIndex]!;
  const point = pool[index] ?? (pool[index] = [0, 0, 0] as Vec3);
  point[0] = x;
  point[1] = y;
  point[2] = z;
  if (index) item.tendon!.wrapped[index - 1] = wrapped;
  points[index] = point;
  binding.pointCounts[branchIndex] = index + 1;
}

// MuJoCo records tangent endpoints; interpolate only consecutive points tagged with the same wrapping geom.
function appendTendonWrapArc(
  binding: TendonBinding, branchIndex: number, mujoco: MainModule, model: MjModel, data: MjData,
  geomId: number, startIndex: number, endIndex: number, incomingIndex: number, outgoingIndex: number,
): void {
  if (geomId < 0 || geomId >= model.ngeom) throw new Error(`Native tendon wrap references invalid geom ${geomId}.`);
  const type = model.geom_type[geomId];
  if (type !== mujoco.mjtGeom.mjGEOM_SPHERE.value && type !== mujoco.mjtGeom.mjGEOM_CYLINDER.value) {
    throw new Error(`Native tendon wrap geom ${geomId} is not a sphere or cylinder.`);
  }
  const radius = model.geom_size[geomId * 3];
  if (!(radius > 0 && Number.isFinite(radius))) throw new Error(`Native tendon wrap geom ${geomId} has an invalid radius.`);
  const center = data.geom_xpos;
  const xmat = data.geom_xmat;
  const positions = data.wrap_xpos;
  const centerOffset = geomId * 3;
  const matrixOffset = geomId * 9;
  const startOffset = startIndex * 3;
  const endOffset = endIndex * 3;
  const incomingOffset = incomingIndex * 3;
  const outgoingOffset = outgoingIndex * 3;
  if (incomingIndex < 0 || outgoingIndex < 0 || outgoingOffset + 2 >= positions.length) {
    throw new Error(`Native tendon wrap geom ${geomId} is missing a tangent endpoint.`);
  }
  const cx = center[centerOffset], cy = center[centerOffset + 1], cz = center[centerOffset + 2];
  const x0 = positions[startOffset], y0 = positions[startOffset + 1], z0 = positions[startOffset + 2];
  const x1 = positions[endOffset], y1 = positions[endOffset + 1], z1 = positions[endOffset + 2];
  const ix = positions[incomingOffset], iy = positions[incomingOffset + 1], iz = positions[incomingOffset + 2];
  const ox = positions[outgoingOffset], oy = positions[outgoingOffset + 1], oz = positions[outgoingOffset + 2];
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(cz)
    || !Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(z0)
    || !Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(z1)
    || !Number.isFinite(ix) || !Number.isFinite(iy) || !Number.isFinite(iz)
    || !Number.isFinite(ox) || !Number.isFinite(oy) || !Number.isFinite(oz)) {
    throw new Error(`Native tendon wrap geom ${geomId} has non-finite tangent data.`);
  }

  if (type === mujoco.mjtGeom.mjGEOM_SPHERE.value) {
    const r0x = x0 - cx, r0y = y0 - cy, r0z = z0 - cz;
    const r1x = x1 - cx, r1y = y1 - cy, r1z = z1 - cz;
    const r0Length = Math.hypot(r0x, r0y, r0z);
    const r1Length = Math.hypot(r1x, r1y, r1z);
    if (!(r0Length > 1e-12 && r1Length > 1e-12) || !Number.isFinite(r0Length) || !Number.isFinite(r1Length)) {
      throw new Error(`Native tendon wrap geom ${geomId} has a degenerate contact point.`);
    }
    const ux = r0x / r0Length, uy = r0y / r0Length, uz = r0z / r0Length;
    const wx = r1x / r1Length, wy = r1y / r1Length, wz = r1z / r1Length;
    let tx = x0 - ix, ty = y0 - iy, tz = z0 - iz;
    let tangentProjection = tx * ux + ty * uy + tz * uz;
    tx -= tangentProjection * ux;
    ty -= tangentProjection * uy;
    tz -= tangentProjection * uz;
    let incomingLength = Math.hypot(tx, ty, tz);
    let oxTangent = ox - x1, oyTangent = oy - y1, ozTangent = oz - z1;
    tangentProjection = oxTangent * wx + oyTangent * wy + ozTangent * wz;
    oxTangent -= tangentProjection * wx;
    oyTangent -= tangentProjection * wy;
    ozTangent -= tangentProjection * wz;
    let outgoingLength = Math.hypot(oxTangent, oyTangent, ozTangent);
    if (!(incomingLength > 1e-12) && !(outgoingLength > 1e-12)) {
      throw new Error(`Native tendon wrap geom ${geomId} has no usable incoming or outgoing tangent.`);
    }
    let nx: number, ny: number, nz: number;
    if (incomingLength > 1e-12) {
      tx /= incomingLength;
      ty /= incomingLength;
      tz /= incomingLength;
      nx = uy * tz - uz * ty;
      ny = uz * tx - ux * tz;
      nz = ux * ty - uy * tx;
    } else {
      oxTangent /= outgoingLength;
      oyTangent /= outgoingLength;
      ozTangent /= outgoingLength;
      nx = wy * ozTangent - wz * oyTangent;
      ny = wz * oxTangent - wx * ozTangent;
      nz = wx * oyTangent - wy * oxTangent;
    }
    const normalLength = Math.hypot(nx, ny, nz);
    if (!(normalLength > 1e-12)) throw new Error(`Native tendon wrap geom ${geomId} has no stable arc plane.`);
    nx /= normalLength;
    ny /= normalLength;
    nz /= normalLength;
    if (outgoingLength > 1e-12) {
      const vx1 = ny * wz - nz * wy, vy1 = nz * wx - nx * wz, vz1 = nx * wy - ny * wx;
      const outgoingAlignment = oxTangent * vx1 + oyTangent * vy1 + ozTangent * vz1;
      if (outgoingAlignment < -1e-6) throw new Error(`Native tendon wrap geom ${geomId} has inconsistent tangent directions.`);
    }
    const vx = ny * uz - nz * uy, vy = nz * ux - nx * uz, vz = nx * uy - ny * ux;
    const sine = nx * (uy * wz - uz * wy) + ny * (uz * wx - ux * wz) + nz * (ux * wy - uy * wx);
    const cosine = Math.max(-1, Math.min(1, ux * wx + uy * wy + uz * wz));
    let angle: number;
    if (sine === 0 && cosine < 0) angle = Math.PI;
    else if (sine === 0 && cosine > 0) angle = 0;
    else {
      angle = Math.atan2(sine, cosine);
      if (angle < 0) angle += TWO_PI;
    }
    for (let step = 1; step <= WRAP_ARC_SEGMENTS; step++) {
      if (step === WRAP_ARC_SEGMENTS) {
        appendTendonPoint(binding, branchIndex, x1, y1, z1, true);
      } else {
        const t = step / WRAP_ARC_SEGMENTS;
        const theta = angle * t;
        const cosineTheta = Math.cos(theta), sineTheta = Math.sin(theta);
        appendTendonPoint(binding, branchIndex,
          cx + radius * (ux * cosineTheta + vx * sineTheta),
          cy + radius * (uy * cosineTheta + vy * sineTheta),
          cz + radius * (uz * cosineTheta + vz * sineTheta), true);
      }
    }
    return;
  }

  const ax = xmat[matrixOffset + 2], ay = xmat[matrixOffset + 5], az = xmat[matrixOffset + 8];
  const axisLength = Math.hypot(ax, ay, az);
  if (!(axisLength > 1e-12) || !Number.isFinite(axisLength)) throw new Error(`Native tendon wrap geom ${geomId} has an invalid cylinder axis.`);
  const axisX = ax / axisLength, axisY = ay / axisLength, axisZ = az / axisLength;
  const d0x = x0 - cx, d0y = y0 - cy, d0z = z0 - cz;
  const d1x = x1 - cx, d1y = y1 - cy, d1z = z1 - cz;
  const axial0 = d0x * axisX + d0y * axisY + d0z * axisZ;
  const axial1 = d1x * axisX + d1y * axisY + d1z * axisZ;
  const r0x = d0x - axial0 * axisX, r0y = d0y - axial0 * axisY, r0z = d0z - axial0 * axisZ;
  const r1x = d1x - axial1 * axisX, r1y = d1y - axial1 * axisY, r1z = d1z - axial1 * axisZ;
  const r0Length = Math.hypot(r0x, r0y, r0z), r1Length = Math.hypot(r1x, r1y, r1z);
  if (!(r0Length > 1e-12 && r1Length > 1e-12) || !Number.isFinite(r0Length) || !Number.isFinite(r1Length)) {
    throw new Error(`Native tendon wrap geom ${geomId} has a degenerate contact point.`);
  }
  const ux = r0x / r0Length, uy = r0y / r0Length, uz = r0z / r0Length;
  const wx = r1x / r1Length, wy = r1y / r1Length, wz = r1z / r1Length;
  const dx = axisY * uz - axisZ * uy, dy = axisZ * ux - axisX * uz, dz = axisX * uy - axisY * ux;
  const endDx = axisY * wz - axisZ * wy, endDy = axisZ * wx - axisX * wz, endDz = axisX * wy - axisY * wx;
  const incomingDirection = (x0 - ix) * dx + (y0 - iy) * dy + (z0 - iz) * dz;
  const outgoingDirection = (ox - x1) * endDx + (oy - y1) * endDy + (oz - z1) * endDz;
  if (Math.abs(incomingDirection) <= 1e-12 && Math.abs(outgoingDirection) <= 1e-12) {
    throw new Error(`Native tendon wrap geom ${geomId} has no usable incoming or outgoing tangent.`);
  }
  if (Math.abs(incomingDirection) > 1e-12 && Math.abs(outgoingDirection) > 1e-12
    && incomingDirection * outgoingDirection < 0) {
    throw new Error(`Native tendon wrap geom ${geomId} has inconsistent tangent directions.`);
  }
  const direction = Math.abs(incomingDirection) > 1e-12 ? incomingDirection : outgoingDirection;
  const sine = axisX * (uy * wz - uz * wy) + axisY * (uz * wx - ux * wz) + axisZ * (ux * wy - uy * wx);
  const cosine = Math.max(-1, Math.min(1, ux * wx + uy * wy + uz * wz));
  let angle: number;
  if (sine === 0 && cosine < 0) angle = direction > 0 ? Math.PI : -Math.PI;
  else if (sine === 0 && cosine > 0) angle = 0;
  else {
    angle = Math.atan2(sine, cosine);
    if (direction > 0 && angle < 0) angle += TWO_PI;
    else if (direction < 0 && angle > 0) angle -= TWO_PI;
  }
  for (let step = 1; step <= WRAP_ARC_SEGMENTS; step++) {
    if (step === WRAP_ARC_SEGMENTS) {
      appendTendonPoint(binding, branchIndex, x1, y1, z1, true);
    } else {
      const t = step / WRAP_ARC_SEGMENTS;
      const theta = angle * t;
      const cosineTheta = Math.cos(theta), sineTheta = Math.sin(theta);
      const radialX = radius * (ux * cosineTheta + dx * sineTheta);
      const radialY = radius * (uy * cosineTheta + dy * sineTheta);
      const radialZ = radius * (uz * cosineTheta + dz * sineTheta);
      const axial = axial0 + (axial1 - axial0) * t;
      appendTendonPoint(binding, branchIndex,
        cx + axisX * axial + radialX, cy + axisY * axial + radialY, cz + axisZ * axial + radialZ, true);
    }
  }
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
  private readonly jacobianPosition: DoubleBuffer | null;
  private readonly jacobianRotation: DoubleBuffer | null;
  private readonly velocityChange: DoubleBuffer | null;
  private readonly generalizedImpulse: number[];
  private velocityView: Float64Array | null = null;
  private readonly clock = new FixedStepClock(FIXED_TIMESTEP);
  private readonly bodyBindings: BodyBinding[];
  private readonly tendonBindings: TendonBinding[];
  private readonly connectionBindings: ConnectionBinding[];
  private readonly bodyById: Map<string, BodyBinding>;
  private readonly initialHeldByCarrier = new Map<string, BodyBinding[]>();
  private readonly heldByCarrier = new Map<string, BodyBinding[]>();
  private readonly heldBodies: HeldBodyState;
  private readonly eventStates: EventState[];
  private readonly eventOrder: EventState[];
  private eventCursor = 0;
  private nativeSteps = 0;
  private pendingSubstep = 0;
  private pendingStepPrepared = false;
  private nativeStepsThisAdvance = 0;
  private nativeWorkDeadline = Infinity;
  private observationRefreshPending = false;
  private readonly loadEnabled: Uint8Array;
  private readonly renderItems: RenderItem[];
  private readonly warningBaseline: number[];
  private readonly initialQpos: Float64Array;
  private readonly initialQvel: Float64Array;
  private readonly contactMaterials: ContactFriction;
  private readonly contactForces: Float64Array;
  private readonly substeps: number;
  private readonly nativeTimestep: number;
  private readonly geometryBodies: Int32Array;
  private readonly equilibrium: ContactEquilibrium;
  private readonly bodyNamesById: string[];
  private disposed = false;
  private constraintObservationsValid = false;

  constructor(
    mujoco: MainModule,
    model: MjModel,
    data: MjData,
    scene: Scene,
    bodyBindings: BodyBinding[],
    equilibrium: ContactEquilibrium,
    heldBodies: HeldBodyState,
    tendonBindings: TendonBinding[],
    connectionBindings: ConnectionBinding[],
    warningBaseline: number[],
    buffers: DoubleBuffer[],
    velocityBuffer: DoubleBuffer,
    jacobianPosition: DoubleBuffer | null,
    jacobianRotation: DoubleBuffer | null,
    velocityChange: DoubleBuffer | null,
    generalizedImpulse: number[],
  ) {
    this.mujoco = mujoco;
    this.model = model;
    this.data = data;
    this.buffers = buffers;
    this.velocityBuffer = velocityBuffer;
    this.jacobianPosition = jacobianPosition;
    this.jacobianRotation = jacobianRotation;
    this.velocityChange = velocityChange;
    this.generalizedImpulse = generalizedImpulse;
    this.scene = scene;
    this.bodyBindings = bodyBindings;
    this.equilibrium = equilibrium;
    this.bodyById = new Map(bodyBindings.map(binding => [binding.body.id, binding]));
    this.heldBodies = heldBodies;
    for (const binding of bodyBindings) {
      const carrierId = binding.body.heldBy;
      if (carrierId === null) continue;
      const group = this.initialHeldByCarrier.get(carrierId) ?? [];
      group.push(binding);
      this.initialHeldByCarrier.set(carrierId, group);
    }
    this.resetHeldGroups();
    this.eventStates = scene.events.map((event, index) => ({ event, index, firedAt: null }));
    this.eventOrder = this.eventStates.slice().sort((a, b) => a.event.at - b.event.at || a.index - b.index);
    this.loadEnabled = new Uint8Array(scene.loads.length).fill(1);
    this.tendonBindings = tendonBindings;
    this.connectionBindings = connectionBindings;
    this.warningBaseline = warningBaseline;
    const tendonItems = tendonBindings.flatMap(binding => binding.branches);
    this.renderItems = bodyBindings.map(binding => binding.renderItem)
      .concat(bodyBindings.flatMap(binding => binding.jointReference ? [binding.jointReference.renderItem] : []),
        tendonItems, connectionBindings.map(binding => binding.renderItem));
    this.contactMaterials = new ContactFriction(mujoco, model, bodyBindings);
    this.contactForces = new Float64Array(model.nbody * 3);
    this.substeps = contactSubsteps(scene);
    this.nativeTimestep = FIXED_TIMESTEP / this.substeps;
    this.geometryBodies = equilibrium.geometryBodies;
    this.bodyNamesById = new Array(model.nbody).fill('world');
    for (const binding of bodyBindings) this.bodyNamesById[binding.id] = binding.body.id;
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
    if (this.observationRefreshPending) {
      const refreshReason = this.refreshCurrentState();
      if (refreshReason) throw new Error(refreshReason);
    }
    const contactEvidence = this.readContactForces();
    const entities: EntityObservation[] = [];
    const positions = this.data.xipos;
    const hasSleepingBodies = this.bodyBindings.some(binding => this.equilibrium.sleeping(this.data, binding.id));
    const quaternions = this.data.xquat;
    const qpos = this.data.qpos;
    const qvel = this.data.qvel;
    for (const binding of this.bodyBindings) {
      const { body, id } = binding;
      const velocity = this.worldVelocity(id);
      const sleeping = this.equilibrium.sleeping(this.data, id);
      const properties: Observation[] = [
        { label: 'Motion', value: body.motion.kind },
        { label: 'Shape', value: body.shape.kind },
        shapeLabel(body),
        // Massless fixed bodies have no meaningful inertial center; use their actual world origin.
        { label: 'Position', value: vecAt(body.motion.kind === 'fixed' ? this.data.xpos : positions, id * 3), unit: 'm' },
        { label: 'Velocity', value: vecAt(velocity, 3), unit: 'm/s' },
      ];
      if (sleeping) properties.push({ label: 'Activity', value: 'Resting · wakes on contact' });
      if (this.heldBodies.isHeld(body.id)) {
        const departure = this.eventStates.find(state => state.firedAt === null
          && (state.event.action.kind === 'launch' || state.event.action.kind === 'release')
          && state.event.action.bodyId === body.id);
        properties.push({ label: 'Activity', value: departure?.event.action.kind === 'launch' ? 'Waiting for launch' : 'Waiting for release' });
      }
      if (body.mass !== null) {
        properties.push({ label: 'Mass', value: this.model.body_mass[id], unit: 'kg' });
        const mass = this.model.body_mass[id];
        const carried = this.heldByCarrier.get(body.id);
        if (carried) {
          let loadedMass = mass;
          for (const payload of carried) loadedMass += this.model.body_mass[payload.id];
          properties.push({ label: 'Loaded mass', value: loadedMass, unit: 'kg' });
          properties.push({ label: 'Carried objects', value: carried.length });
        }
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
        if (!sleeping && !(hasSleepingBodies && body.motion.kind === 'fixed')) properties.push({ label: 'Contact force', value: this.constraintObservationsValid ? vecAt(this.contactForces, id * 3) : 'Unavailable', unit: 'N' });
      }
      if (body.friction.torsional > 0) properties.push({ label: 'Torsional friction length', value: body.friction.torsional, unit: 'm' });
      if (body.friction.rolling > 0) properties.push({ label: 'Rolling friction length', value: body.friction.rolling, unit: 'm' });
      for (let loadIndex = 0; loadIndex < this.scene.loads.length; loadIndex++) {
        const load = this.scene.loads[loadIndex];
        if (load.kind === 'gravity') {
          if (body.motion.kind === 'particle' && load.bodyIds.includes(body.id)) {
            properties.push({ label: 'Mutual gravity G', value: load.G, unit: 'N·m²/kg²' });
            if (this.eventStates.length) properties.push({ label: 'Load state', value: this.loadEnabled[loadIndex] ? 'Enabled' : 'Disabled' });
          }
          continue;
        }
        if (load.bodyId !== body.id) continue;
        if (this.eventStates.length && load.kind !== 'impulse') {
          properties.push({ label: 'Load state', value: this.loadEnabled[loadIndex] ? 'Enabled' : 'Disabled' });
        }
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
    if (this.scene.tendons.some(tendon => tendon.mode !== 'spring')) notes.push('Cords use numerical constraints: slight stretch can occur during motion, so measured length can differ from its target or maximum.');
    if (hasSleepingBodies) notes.push('Settled frictional boxes can sleep at the native 0.001 m/s tolerance. Resting contact forces and incomplete fixed-support totals are not shown; contact with an awake object wakes the connected island and requires renewed equilibrium before sleeping again.');
    if (this.eventStates.some(state => {
      const ticks = state.event.at / this.nativeTimestep;
      return !Number.isSafeInteger(Math.round(ticks)) || Math.abs(ticks - Math.round(ticks)) > 1e-9;
    })) notes.push(`Scheduled actions apply at the first native-step boundary at or after their time (${this.nativeTimestep} s); Fired at records the actual boundary.`);
    if (!this.constraintObservationsValid) notes.push('Constraint-force observations are unavailable after a singular or numerically invalid step.');
    return {
      time: this.data.time,
      entities,
      notes,
      contacts: contactEvidence.contacts,
      contactsTruncated: contactEvidence.truncated,
      ...(this.eventStates.length ? { events: this.eventStates.map(state => ({
        id: state.event.id,
        label: state.event.label,
        at: state.event.at,
        status: state.firedAt === null ? 'pending' as const : 'completed' as const,
        firedAt: state.firedAt,
      })) } : {}),
    };
  }

  advance(wallSeconds: number, speed: number, workBudgetMs = Infinity): AdvanceResult {
    this.assertLive();
    const visible = typeof document === 'undefined' || !document.hidden;
    this.nativeWorkDeadline = performance.now() + workBudgetMs;
    this.nativeStepsThisAdvance = 0;
    let result: AdvanceResult;
    let nativePause = false;
    try {
      // The clock commits a 1 ms step only after all native substeps finish; partial time stays visible in `time`.
      result = this.clock.advance(wallSeconds, speed, () => {
        const stepResult = this.step();
        nativePause ||= stepResult.pauseReason !== null;
        return stepResult;
      }, visible);
    } finally {
      this.nativeWorkDeadline = Infinity;
      this.nativeStepsThisAdvance = 0;
    }
    if (this.pendingSubstep > 0) {
      const refreshReason = this.refreshPartialState();
      this.observationRefreshPending = !refreshReason && !nativePause;
      if (refreshReason && refreshReason !== result.pauseReason) {
        result.pauseReason = result.pauseReason ? `${result.pauseReason} ${refreshReason}` : refreshReason;
      }
    } else if (result.steps > 0) {
      const refreshReason = this.refreshCurrentState();
      if (refreshReason) result.pauseReason = result.pauseReason ? `${result.pauseReason} ${refreshReason}` : refreshReason;
    }
    return result;
  }

  reset(): void {
    this.assertLive();
    this.equilibrium.reset();
    this.mujoco.mj_resetData(this.model, this.data);
    this.data.qpos.set(this.initialQpos);
    this.data.qvel.set(this.initialQvel);
    this.heldBodies.reset(this.data);
    this.resetHeldGroups();
    this.contactMaterials.reset();
    this.loadEnabled.fill(1);
    this.eventCursor = 0;
    this.nativeSteps = 0;
    this.pendingSubstep = 0;
    this.pendingStepPrepared = false;
    this.nativeStepsThisAdvance = 0;
    this.observationRefreshPending = false;
    for (const state of this.eventStates) state.firedAt = null;
    this.contactForces.fill(0);
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
  private resetHeldGroups(): void {
    this.heldByCarrier.clear();
    for (const [carrierId, bodies] of this.initialHeldByCarrier) this.heldByCarrier.set(carrierId, bodies.slice());
  }

  private updateFrame(): void {
    const xpos = this.data.xpos;
    const xquat = this.data.xquat;
    for (const binding of this.bodyBindings) {
      const { id, renderItem, jointReference } = binding;
      setVec(renderItem.position, xpos, id * 3);
      setThreeQuat(renderItem.quaternion, xquat, id * 4);
      if (this.heldBodies.isHeld(binding.body.id)) {
        renderItem.visible = false;
        if (jointReference) jointReference.renderItem.visible = false;
      } else {
        if (renderItem.visible === false) delete renderItem.visible;
        if (jointReference?.renderItem.visible === false) delete jointReference.renderItem.visible;
      }
    }
    const anchors = this.data.xanchor;
    for (const binding of this.bodyBindings) {
      const reference = binding.jointReference;
      if (!reference) continue;
      const points = reference.renderItem.points!;
      setVec(points[0], anchors, reference.jointId * 3);
      setVec(points[1], xpos, binding.id * 3);
    }
    const wrapPositions = this.data.wrap_xpos;
    const wrapAddresses = this.data.ten_wrapadr;
    const wrapObjects = this.data.wrap_obj;
    for (const binding of this.tendonBindings) {
      const { tendon } = binding;
      const length = this.data.ten_length[binding.id];
      const velocity = this.data.ten_velocity[binding.id];
      const generalizedForce = tendon.mode === 'spring'
        ? tendon.stiffness * (length - tendon.length) + tendon.damping * velocity
        : this.constraintObservationsValid ? this.tendonTension(binding) : null;
      for (let branch = 0; branch < binding.branches.length; branch++) {
        const state = binding.branches[branch]!.tendon!;
        state.length = length;
        state.restLength = tendon.length;
        state.force = generalizedForce === null ? null : generalizedForce / binding.branchDivisors[branch]!;
      }
      resetTendonPaths(binding);
      let branchIndex = 0;
      let previousIndex = -1;
      const start = wrapAddresses[binding.id];
      const end = start + this.data.ten_wrapnum[binding.id];
      for (let index = start; index < end; index++) {
        const geomId = wrapObjects[index];
        if (geomId === -2) {
          if (!binding.branches[++branchIndex]) throw new Error('Native cable branches do not match the compiled model.');
          previousIndex = -1;
          continue;
        }
        if (!Number.isInteger(geomId) || geomId < -2) throw new Error('Native cable wrap data contains an invalid object tag.');
        if (previousIndex >= start && wrapObjects[previousIndex] === geomId && geomId >= 0) {
          const incomingIndex = previousIndex - 1;
          const outgoingIndex = index + 1;
          if (incomingIndex < start || outgoingIndex >= end
            || wrapObjects[incomingIndex] !== -1 || wrapObjects[outgoingIndex] !== -1) {
            throw new Error(`Native tendon wrap geom ${geomId} is missing a site tangent endpoint.`);
          }
          appendTendonWrapArc(binding, branchIndex, this.mujoco, this.model, this.data,
            geomId, previousIndex, index, incomingIndex, outgoingIndex);
          previousIndex = index;
          continue;
        }
        if (geomId >= 0 && (index + 1 >= end || wrapObjects[index + 1] !== geomId)) {
          throw new Error(`Native tendon wrap geom ${geomId} has an unpaired contact point.`);
        }
        appendTendonPoint(binding, branchIndex, wrapPositions[index * 3],
          wrapPositions[index * 3 + 1], wrapPositions[index * 3 + 2], false);
        previousIndex = index;
      }
      if (branchIndex + 1 !== binding.branches.length) throw new Error('Native cable branch data is incomplete.');
      for (let branch = 0; branch < binding.branches.length; branch++) {
        binding.branches[branch]!.points!.length = binding.pointCounts[branch]!;
        binding.branches[branch]!.tendon!.wrapped.length = Math.max(0, binding.pointCounts[branch]! - 1);
      }
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
    while (this.pendingSubstep < this.substeps) {
      if (this.nativeStepsThisAdvance > 0 && performance.now() > this.nativeWorkDeadline) return DEFERRED_STEP;
      this.mujoco.mj_step1(this.model, this.data);
      if (this.pendingStepPrepared) this.pendingStepPrepared = false;
      else this.equilibrium.prepareStep(this.data);
      this.processDueEvents();
      this.contactMaterials.update(this.data);
      this.clearCustomForces();
      const singular = this.gravitySingularity();
      if (singular) {
        this.constraintObservationsValid = false;
        return { advanced: false, pauseReason: singular };
      }
      this.constraintObservationsValid = false;
      this.applyLoads();
      this.mujoco.mj_step2(this.model, this.data);
      // Integer ticks prevent accumulated time error from delaying a scheduled action.
      this.data.time = ++this.nativeSteps * this.nativeTimestep;
      this.pendingSubstep++;
      this.nativeStepsThisAdvance++;
    }
    this.pendingSubstep = 0;
    if (this.eventCursor < this.eventOrder.length && this.eventOrder[this.eventCursor].event.at <= this.data.time) {
      this.mujoco.mj_step1(this.model, this.data);
      this.processDueEvents();
    }
    const warning = this.newWarning();
    if (warning) return { advanced: true, pauseReason: warning };
    if (nonfiniteState(this.data)) return { advanced: true, pauseReason: 'MuJoCo produced a non-finite state; simulation paused.' };
    this.equilibrium.update(this.data);
    return COMPLETED_STEP;
  }
  private processDueEvents(): void {
    if (this.eventCursor === this.eventOrder.length) return;
    const now = this.data.time;
    while (this.eventCursor < this.eventOrder.length) {
      const state = this.eventOrder[this.eventCursor];
      if (state.event.at > now) break;
      this.applyScheduledAction(state.event.action);
      state.firedAt = now;
      this.eventCursor++;
      this.mujoco.mj_step1(this.model, this.data);
    }
  }
  private applyScheduledAction(action: ScheduledEvent['action']): void {
    if (action.kind === 'load') {
      this.loadEnabled[action.loadIndex] = action.enabled ? 1 : 0;
    } else if (action.kind === 'impulse') {
      const target = this.bodyById.get(action.bodyId)!;
      const payloads = this.heldByCarrier.get(action.bodyId);
      if (payloads?.length && target.body.motion.kind === 'free') {
        applyAggregateImpulse(this.mujoco, this.model, this.data, [target, ...payloads], target,
          action.linear, action.angular, this.velocityBuffer);
      } else {
        applyGeneralizedImpulse(this.mujoco, this.model, this.data, target.id, action.linear, action.angular,
          this.jacobianPosition, this.jacobianRotation, this.velocityChange, this.generalizedImpulse);
      }
    } else if (action.kind === 'release') {
      this.releaseHeldBody(action.bodyId);
    } else {
      this.launchBody(action.bodyId, action.velocity, action.frame);
    }
  }

  private releaseHeldBody(bodyId: string): void {
    const binding = this.bodyById.get(bodyId)!;
    const carrierId = binding.body.heldBy!;
    this.heldBodies.release(this.data, bodyId);
    const group = this.heldByCarrier.get(carrierId)!;
    const index = group.findIndex(payload => payload.body.id === bodyId);
    if (index < 0) throw new Error(`Body ${bodyId} is missing from its carried group.`);
    group.splice(index, 1);
  }

  private launchBody(bodyId: string, velocity: Vec3, frame: 'world' | 'body'): void {
    const payload = this.bodyById.get(bodyId)!;
    const carrier = this.bodyById.get(payload.body.heldBy!)!;
    const carrierVelocity = this.worldVelocity(carrier.id);
    const carrierAngular: Vec3 = [carrierVelocity[0], carrierVelocity[1], carrierVelocity[2]];
    const carrierLinear: Vec3 = [carrierVelocity[3], carrierVelocity[4], carrierVelocity[5]];
    const positions = this.data.xipos;
    const arm = subtract(vecAt(positions, payload.id * 3), vecAt(positions, carrier.id * 3));
    const carriedRotation = cross(carrierAngular, arm);
    let launchVelocity: Vec3;
    let relativeVelocity: Vec3 | null = null;
    if (frame === 'world') {
      launchVelocity = velocity;
    } else {
      relativeVelocity = rotate([
        this.data.xquat[carrier.id * 4],
        this.data.xquat[carrier.id * 4 + 1],
        this.data.xquat[carrier.id * 4 + 2],
        this.data.xquat[carrier.id * 4 + 3],
      ], velocity);
      launchVelocity = [
        carrierLinear[0] + carriedRotation[0] + relativeVelocity[0],
        carrierLinear[1] + carriedRotation[1] + relativeVelocity[1],
        carrierLinear[2] + carriedRotation[2] + relativeVelocity[2],
      ];
    }
    if (carrier.body.motion.kind === 'free') {
      const held = this.heldByCarrier.get(carrier.body.id)!;
      const members = [carrier, ...held];
      const remaining = members.filter(member => member !== payload);
      this.launchFromFreeCarrier(members, remaining, payload, launchVelocity, carrierAngular, relativeVelocity);
    } else {
      setFreeVelocity(this.data, payload, launchVelocity, carrierAngular);
    }
    this.releaseHeldBody(bodyId);
  }

  private launchFromFreeCarrier(
    members: BodyBinding[],
    remaining: BodyBinding[],
    payload: BodyBinding,
    launchVelocity: Vec3,
    launchAngular: Vec3,
    relativeVelocity: Vec3 | null,
  ): void {
    const before = rigidAggregate(this.mujoco, this.model, this.data, members, this.velocityBuffer);
    const after = rigidAggregate(this.mujoco, this.model, this.data, remaining, this.velocityBuffer);
    const mass = this.model.body_mass[payload.id];
    const position = vecAt(this.data.xipos, payload.id * 3);
    const projectileInertia = bodyInertiaWorld(this.model, this.data, payload.id);
    const spin: Vec3 = [
      projectileInertia[0] * launchAngular[0] + projectileInertia[1] * launchAngular[1] + projectileInertia[2] * launchAngular[2],
      projectileInertia[3] * launchAngular[0] + projectileInertia[4] * launchAngular[1] + projectileInertia[5] * launchAngular[2],
      projectileInertia[6] * launchAngular[0] + projectileInertia[7] * launchAngular[1] + projectileInertia[8] * launchAngular[2],
    ];
    if (relativeVelocity) {
      // Muzzle speed is relative to the carrier after recoil, not its previous velocity.
      const arm = subtract(position, after.center);
      const centerMoment = cross(after.center, before.momentum);
      const baseAngular = solveSymmetric3(after.inertia, [
        before.angularMomentum[0] - spin[0] - centerMoment[0],
        before.angularMomentum[1] - spin[1] - centerMoment[1],
        before.angularMomentum[2] - spin[2] - centerMoment[2],
      ]);
      const rotational = cross(baseAngular, arm);
      const response = new Array<number>(9);
      for (let column = 0; column < 3; column++) {
        const basis: Vec3 = [0, 0, 0];
        basis[column] = 1;
        const correction = cross(arm, solveSymmetric3(after.inertia, cross(arm, basis)));
        for (let row = 0; row < 3; row++) response[row * 3 + column] = (row === column ? 1 + mass / after.mass : 0) - mass * correction[row];
      }
      launchVelocity = solveSymmetric3(response, [
        relativeVelocity[0] + before.momentum[0] / after.mass + rotational[0],
        relativeVelocity[1] + before.momentum[1] / after.mass + rotational[1],
        relativeVelocity[2] + before.momentum[2] / after.mass + rotational[2],
      ]);
    }
    const projectileMomentum: Vec3 = [mass * launchVelocity[0], mass * launchVelocity[1], mass * launchVelocity[2]];
    const orbital = cross(position, projectileMomentum);
    const remainingMomentum: Vec3 = [
      before.momentum[0] - projectileMomentum[0],
      before.momentum[1] - projectileMomentum[1],
      before.momentum[2] - projectileMomentum[2],
    ];
    const remainingAngularMomentum = [
      before.angularMomentum[0] - orbital[0] - spin[0],
      before.angularMomentum[1] - orbital[1] - spin[1],
      before.angularMomentum[2] - orbital[2] - spin[2],
    ] as Vec3;
    const remainingCenterMoment = cross(after.center, remainingMomentum);
    const remainingAngular = solveSymmetric3(after.inertia, [
      remainingAngularMomentum[0] - remainingCenterMoment[0],
      remainingAngularMomentum[1] - remainingCenterMoment[1],
      remainingAngularMomentum[2] - remainingCenterMoment[2],
    ]);
    const remainingLinear: Vec3 = [
      remainingMomentum[0] / after.mass,
      remainingMomentum[1] / after.mass,
      remainingMomentum[2] / after.mass,
    ];
    const positions = this.data.xipos;
    for (const member of remaining) {
      const offset = member.id * 3;
      const arm: Vec3 = [positions[offset] - after.center[0], positions[offset + 1] - after.center[1], positions[offset + 2] - after.center[2]];
      const rotational = cross(remainingAngular, arm);
      setFreeVelocity(this.data, member, [
        remainingLinear[0] + rotational[0],
        remainingLinear[1] + rotational[1],
        remainingLinear[2] + rotational[2],
      ], remainingAngular);
    }
    setFreeVelocity(this.data, payload, launchVelocity, launchAngular);
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

  private readContactForces(): { contacts: ContactObservation[]; truncated: boolean } {
    this.contactForces.fill(0);
    const observations: ContactObservation[] = [];
    let truncated = false;
    if (!this.data.ncon) return { contacts: observations, truncated };
    const contacts = this.data.contact;
    const geomBodies = this.geometryBodies;
    try {
      for (let index = 0; index < this.data.ncon; index++) {
        const contact = contacts.get(index);
        if (!contact) continue;
        try {
          if (Number.isFinite(contact.dist) && observations.length < MAX_SNAPSHOT_CONTACTS) {
            observations.push({
              bodyAId: this.bodyNamesById[geomBodies[contact.geom1]] ?? 'world',
              bodyBId: this.bodyNamesById[geomBodies[contact.geom2]] ?? 'world',
              distance: contact.dist,
            });
          } else {
            truncated = true;
          }
          if (!this.constraintObservationsValid) continue;
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
    return { contacts: observations, truncated };
  }

  private applyLoads(): void {
    const xpos = this.data.xpos;
    const xipos = this.data.xipos;
    const xquat = this.data.xquat;
    for (let loadIndex = 0; loadIndex < this.scene.loads.length; loadIndex++) {
      if (!this.loadEnabled[loadIndex]) continue;
      const load = this.scene.loads[loadIndex];
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
    for (let loadIndex = 0; loadIndex < this.scene.loads.length; loadIndex++) {
      if (!this.loadEnabled[loadIndex]) continue;
      const load = this.scene.loads[loadIndex];
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

  private refreshPartialState(): string | null {
    this.observationRefreshPending = false;
    this.constraintObservationsValid = false;
    if (nonfiniteState(this.data)) return 'MuJoCo produced a non-finite state; simulation paused.';
    if (this.eventCursor < this.eventOrder.length && this.eventOrder[this.eventCursor].event.at <= this.data.time) {
      this.mujoco.mj_step1(this.model, this.data);
      this.equilibrium.prepareStep(this.data);
      this.processDueEvents();
      this.pendingStepPrepared = true;
    } else {
      this.mujoco.mj_fwdPosition(this.model, this.data);
    }
    const singular = this.gravitySingularity();
    if (singular) return singular;
    const warning = this.newWarning();
    if (warning) return warning;
    if (nonfiniteState(this.data)) return 'MuJoCo produced a non-finite state; simulation paused.';
    return null;
  }
  private refreshCurrentState(): string | null {
    this.observationRefreshPending = false;
    this.constraintObservationsValid = false;
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
    const bodyBindings = makeBodyBindings(mujoco, model, scene);
    const equilibrium = new ContactEquilibrium(mujoco, model, scene, bodyBindings);
    data = new mujoco.MjData(model);
    const bodyById = new Map(bodyBindings.map(binding => [binding.body.id, binding]));
    const heldBodyState = new HeldBodyState(model, makeHeldBindings(mujoco, model, bodyBindings));
    heldBodyState.reset(data);
    const heldByCarrier = new Map<string, BodyBinding[]>();
    for (const binding of bodyBindings) {
      const carrierId = binding.body.heldBy;
      if (carrierId === null) continue;
      const group = heldByCarrier.get(carrierId) ?? [];
      group.push(binding);
      heldByCarrier.set(carrierId, group);
    }
    const velocityBuffer = new mujoco.DoubleBuffer(6);
    buffers.push(velocityBuffer);
    const jacobianPosition = model.nv ? new mujoco.DoubleBuffer(3 * model.nv) : null;
    if (jacobianPosition) buffers.push(jacobianPosition);
    const jacobianRotation = model.nv ? new mujoco.DoubleBuffer(3 * model.nv) : null;
    if (jacobianRotation) buffers.push(jacobianRotation);
    const velocityChange = model.nv ? new mujoco.DoubleBuffer(model.nv) : null;
    if (velocityChange) buffers.push(velocityChange);
    const generalizedImpulse = new Array<number>(model.nv).fill(0);
    const warningBaseline = warningCounts(data);
    initializeVelocities(data, bodyBindings);
    // Startup needs kinematics/inertia, not repeated force solves; the constructor solves once after all inputs.
    mujoco.mj_fwdPosition(model, data);
    mujoco.mj_fwdVelocity(model, data);
    if (heldByCarrier.size) {
      initializeHeldVelocities(mujoco, model, data, bodyBindings, bodyById, velocityBuffer);
      mujoco.mj_fwdVelocity(model, data);
    }
    checkInitialConstraints(mujoco, model, data, scene);
    initializeImpulses(mujoco, model, data, scene, bodyById, heldByCarrier,
      jacobianPosition, jacobianRotation, velocityChange, velocityBuffer, generalizedImpulse);
    const tendonBindings = makeTendonBindings(mujoco, model, scene);
    const connectionBindings = makeConnectionBindings(scene, bodyBindings);
    const runtime = new MuJoCoRuntime(mujoco, model, data, scene, bodyBindings, equilibrium, heldBodyState,
      tendonBindings, connectionBindings, warningBaseline, buffers, velocityBuffer,
      jacobianPosition, jacobianRotation, velocityChange, generalizedImpulse);
    return runtime;
  } catch (error) {
    data?.delete();
    model?.delete();
    for (const buffer of buffers) buffer.delete();
    throw error;
  }
}
