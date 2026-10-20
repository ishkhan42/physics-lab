import { z } from 'zod';
import { AppearanceSchema } from './appearance.ts';

const number = z.number().finite();
const positive = number.positive();
const nonnegative = number.nonnegative();
const restitution = number.min(0).max(1).describe('Target normal restitution: 1 for elastic, 0 for fully inelastic, strictly between 0 and 1 for partial rebound.');
const FrictionSchema = z.strictObject({
  sliding: nonnegative.default(0).describe('Kinetic/sliding friction coefficient.'),
  torsional: nonnegative.default(0).describe('Torsional friction length in metres.'),
  rolling: nonnegative.default(0).describe('Rolling friction length in metres.'),
  static: nonnegative.nullable().default(null).describe('Static friction coefficient; null means the sliding coefficient.'),
}).default({ sliding: 0, torsional: 0, rolling: 0, static: null });
const GroundSchema = z.strictObject({
  height: number.default(0),
  restitution: restitution.default(1),
  friction: FrictionSchema,
});
const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
export const Vec3Schema = z.tuple([number, number, number]);
export const QuatSchema = z.tuple([number, number, number, number]);
export type Vec3 = z.infer<typeof Vec3Schema>;
export type Quat = z.infer<typeof QuatSchema>;
const zero: Vec3 = [0, 0, 0];

export const ShapeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('sphere'), radius: positive }),
  z.strictObject({ kind: z.literal('box'), size: z.tuple([positive, positive, positive]).describe('Full side lengths along local X/Y/Z in metres, not MuJoCo half-extents.') }),
  z.strictObject({ kind: z.literal('cylinder'), radius: positive, length: positive }),
  z.strictObject({ kind: z.literal('capsule'), radius: positive, length: positive }),
  z.strictObject({ kind: z.literal('ellipsoid'), radii: z.tuple([positive, positive, positive]) }),
  z.strictObject({ kind: z.literal('plane'), size: z.tuple([positive, positive]) }),
  z.strictObject({ kind: z.literal('point') }),
]);
export type Shape = z.infer<typeof ShapeSchema>;

const joint = {
  axis: Vec3Schema.describe('World-space unit axis in the reference configuration.'),
  anchor: Vec3Schema.describe('World-space joint anchor in the reference configuration.'),
  position: number.default(0).describe('Initial joint coordinate applied AFTER the body reference pose, metres for slide and radians for hinge. Use 0 when body.position/orientation already encode the requested initial pose; never encode the same initial displacement twice.'),
  velocity: number.default(0),
  limits: z.tuple([number, number]).nullable().default(null),
  stiffness: nonnegative.default(0),
  damping: nonnegative.default(0),
  springReference: number.default(0),
};
export const MotionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('fixed') }).describe('Immobile support: no translation or rotation; mass must be null.'),
  z.strictObject({ kind: z.literal('free'), linearVelocity: Vec3Schema.default(zero), angularVelocity: Vec3Schema.default(zero) }).describe('Unconstrained rigid body with three translations and three rotations; NOT a linear guide.'),
  z.strictObject({ kind: z.literal('particle'), linearVelocity: Vec3Schema.default(zero) }).describe('Unconstrained point particle with three translations, no rotation and no collision surface.'),
  z.strictObject({ kind: z.literal('hinge'), ...joint }).describe('Exactly one rotational DOF around axis through anchor; all other relative motion constrained.'),
  z.strictObject({ kind: z.literal('slide'), ...joint }).describe('Ideal linear guide: exactly one translational DOF along axis, no rotation. Use this for motion constrained to one straight line.'),
  z.strictObject({ kind: z.literal('ball'), angularVelocity: Vec3Schema.default(zero), damping: nonnegative.default(0) }).describe('Three rotations about the body reference origin; its translation is locked relative to parent/world. No separate offset anchor field.'),
]);
export const BodySchema = z.strictObject({
  id,
  label: z.string().trim().min(1).max(100),
  parentId: id.nullable().default(null),
  position: Vec3Schema.describe('World-space reference pose. When this is the requested initial pose, use motion.position=0; a nonzero hinge/slide coordinate is applied afterward.'),
  orientation: QuatSchema.default([1, 0, 0, 0]).describe('World-space reference orientation, quaternion w,x,y,z.'),
  shape: ShapeSchema,
  mass: positive.nullable().describe('Kilograms for moving bodies, including junction particles; null only for immobile supports. An ideal massless moving junction cannot use zero mass. Disclose every positive numerical-junction mass.'),
  heldBy: id.nullable().default(null).describe('Initial physical carrying attachment to a fixed/free root carrier, not a display label. Native mass/inertia and carrier-relative pose are included; held collisions/visibility are inactive until release. A native launch exchanges momentum with the carrier.'),
  restitution: restitution.default(0),
  motion: MotionSchema,
  friction: FrictionSchema,
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#67d9ce'),
});
export type Body = z.infer<typeof BodySchema>;

export const SiteSchema = z.strictObject({
  id, label: z.string().min(1).max(100),
  bodyId: id.nullable().describe('Non-null physically attaches this site to that body and follows its pose; null fixes it in world space. A moving junction needs a body-backed site, not just a world point with the same label.'),
  position: Vec3Schema.describe('Body-local position when attached to a body; world position otherwise.'),
});
const PathSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('site'), siteId: id }),
  z.strictObject({ kind: z.literal('wrap'), bodyId: id, sideSiteId: id.nullable().default(null) }),
  z.strictObject({ kind: z.literal('pulley'), divisor: positive }),
]);
export const TendonSchema = z.strictObject({
  id, label: z.string().min(1).max(100),
  path: z.array(PathSchema).min(2).max(64).describe('One continuous cord route. A tied branch network uses separate tendons that meet at a shared site on a moving junction body; do not draw disconnected world-only paths as a substitute.'),
  mode: z.enum(['fixed', 'rope', 'spring']).describe('Rope is a tension-only maximum-length constraint and may go slack; fixed is bilateral fixed length; spring uses a rest length. Only spring uses nonzero stiffness/damping.'),
  length: positive.describe('Native path/constraint length or spring rest length in metres, not a vertical drop/projection. Derive this from actual endpoint geometry (and any wrap/pulley routing).'),
  stiffness: nonnegative.default(0), damping: nonnegative.default(0),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#f2c178'),
});
export type Tendon = z.infer<typeof TendonSchema>;
const ConnectionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('connect'), id, label: z.string().min(1).max(100), bodyA: id, bodyB: id.nullable(), anchor: Vec3Schema }).describe('Ball-point equality: keeps the attachment points coincident, constraining three translations while permitting rotation. This is NOT a slider or a distance-only spring/cable.'),
  z.strictObject({ kind: z.literal('weld'), id, label: z.string().min(1).max(100), bodyA: id, bodyB: id.nullable() }).describe('Locks all relative translation and rotation between the two bodies.'),
  z.strictObject({ kind: z.literal('coupling'), id, label: z.string().min(1).max(100), bodyA: id, bodyB: id, ratio: number, offset: number }).describe('Linear relation between two existing hinge/slide coordinates; does not create their joints.'),
]);
const LoadSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('force'), bodyId: id, vector: Vec3Schema, point: Vec3Schema.nullable().default(null) }),
  z.strictObject({ kind: z.literal('torque'), bodyId: id, vector: Vec3Schema }),
  z.strictObject({ kind: z.literal('impulse'), bodyId: id, linear: Vec3Schema, angular: Vec3Schema.default(zero) }),
  z.strictObject({ kind: z.literal('drag'), bodyId: id, coefficient: nonnegative, mediumVelocity: Vec3Schema.default(zero) }),
  z.strictObject({ kind: z.literal('gravity'), bodyIds: z.array(id).min(2).max(32), G: positive }),
]);
export const ScheduledActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('impulse'), bodyId: id, linear: Vec3Schema, angular: Vec3Schema.default(zero) }),
  z.strictObject({ kind: z.literal('launch'), bodyId: id,
    velocity: Vec3Schema.describe('Native carried-body launch with carrier reaction in either frame. Velocity is in metres per second, NOT impulse or momentum. Changing projectile mass does not multiply launch speed.'),
    frame: z.enum(['world', 'body']).default('body').describe('Both modes exchange momentum with the carrier: world is an absolute world target velocity; body is velocity relative to the post-recoil carrier point, in carrier axes.') }),
  z.strictObject({ kind: z.literal('release'), bodyId: id }),
  z.strictObject({ kind: z.literal('load'), loadIndex: z.number().int().nonnegative(), enabled: z.boolean() }),
]);
export type ScheduledAction = z.infer<typeof ScheduledActionSchema>;
export const ScheduledEventSchema = z.strictObject({
  id, label: z.string().trim().min(1).max(100), at: nonnegative, action: ScheduledActionSchema,
});
export type ScheduledEvent = z.infer<typeof ScheduledEventSchema>;
export const SceneSchema = z.strictObject({
  category: z.literal('mechanics'),
  title: z.string().trim().min(1).max(120),
  gravity: Vec3Schema,
  ground: GroundSchema.nullable().default({
    height: 0, restitution: 1, friction: { sliding: 0, torsional: 0, rolling: 0, static: null },
  }).describe('Physical ground is included by default. Use null ONLY for an explicitly requested groundless scene or a custom replacement support. Zero gravity or a noncontact experiment is not a request to remove ground.'),
  appearance: AppearanceSchema,
  bodies: z.array(BodySchema).min(1).max(128),
  sites: z.array(SiteSchema).max(512).default([]),
  tendons: z.array(TendonSchema).max(128).default([]),
  connections: z.array(ConnectionSchema).max(128).default([]),
  loads: z.array(LoadSchema).max(256).default([]),
  events: z.array(ScheduledEventSchema).max(256).default([]),
});
export type Scene = z.infer<typeof SceneSchema>;
function groundBody(ground: NonNullable<Scene['ground']>): Body {
  return {
    id: 'world-ground', label: 'Ground', parentId: null,
    heldBy: null,
    position: [0, 0, ground.height], orientation: [1, 0, 0, 0],
    shape: { kind: 'plane', size: [10, 10] }, mass: null,
    motion: { kind: 'fixed' }, restitution: ground.restitution,
    friction: ground.friction, color: '#bacbd1',
  };
}

export function physicalScene(scene: Scene): Scene {
  if (scene.ground === null) return scene;
  return validateScene({ ...scene, bodies: [...scene.bodies, groundBody(scene.ground)], ground: null });
}

export function hasGroundPlane(scene: Scene): boolean {
  return scene.ground !== null || scene.bodies.some(body => body.shape.kind === 'plane'
    && body.motion.kind === 'fixed' && body.orientation[1] ** 2 + body.orientation[2] ** 2 < 1e-10);
}
export const ProviderSchema = z.enum(['openai', 'anthropic', 'openrouter', 'openai-codex']);
export type Provider = z.infer<typeof ProviderSchema>;
const decisionFields = {
  summary: z.string().trim().min(1).max(3000),
  assumptions: z.array(z.string().min(1).max(600)).max(40),
  question: z.string().min(1).max(2000).nullable(),
  reason: z.string().min(1).max(3000).nullable(),
  approximation: z.null().default(null),
  scene: z.null(),
  alternative: z.strictObject({
    label: z.string().trim().min(1).max(60),
    description: z.string().trim().min(1).max(1600),
  }).nullable().default(null),
};
export const DecisionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...decisionFields, kind: z.literal('scene'), question: z.null(), reason: z.null(),
    approximation: z.string().trim().min(1).max(1200).nullable().default(null),
    scene: SceneSchema, alternative: z.null().default(null),
  }),
  z.strictObject({ ...decisionFields, kind: z.literal('clarify'), question: z.string().min(1).max(2000) }),
  z.strictObject({ ...decisionFields, kind: z.literal('unsupported'), reason: z.string().min(1).max(3000) }),
]);
export type Decision = z.infer<typeof DecisionSchema>;


export function validateScene(input: unknown): Scene {
  const scene = SceneSchema.parse(input);
  const issues: z.core.$ZodIssue[] = [];
  const issue = (path: (string | number)[], message: string) => issues.push({ code: 'custom', path, message });
  const validateFriction = (friction: Body['friction'], path: (string | number)[]) => {
    if (friction.static !== null && friction.static < friction.sliding) {
      issue([...path, 'static'], 'Static friction must be greater than or equal to sliding friction.');
    }
  };
  if (scene.bodies.length + (scene.ground === null ? 0 : 1) > 128) {
    issue(['bodies'], 'The scene including its ground has a maximum of 128 bodies.');
  }
  const bodies = new Map(scene.bodies.map(body => [body.id, body]));
  if (scene.ground !== null) bodies.set('world-ground', groundBody(scene.ground));
  const sites = new Set(scene.sites.map(site => site.id));
  const names = new Set<string>();
  for (const [group, entries] of [['bodies', scene.bodies], ['sites', scene.sites], ['tendons', scene.tendons], ['connections', scene.connections], ['events', scene.events]] as const) {
    entries.forEach((item, i) => {
      if (item.id === 'world' || (scene.ground !== null && item.id === 'world-ground') || names.has(item.id)) {
        issue([group, i, 'id'], 'Entity IDs must be unique and cannot be world or the reserved world-ground.');
      }
      names.add(item.id);
    });
  }
  const heldBodies = scene.bodies.filter(body => body.heldBy !== null);
  const heldByCarrier = new Map<string, Body[]>();
  const heldCarrierFor = new Map<string, string>();
  for (const [index, body] of scene.bodies.entries()) {
    if (body.heldBy === null) continue;
    const path = ['bodies', index, 'heldBy'] as (string | number)[];
    const carrier = bodies.get(body.heldBy);
    if (!carrier || carrier.id === body.id) {
      issue(path, 'A carried body needs a different existing carrier.');
      continue;
    }
    if (body.motion.kind !== 'free' || body.shape.kind === 'point' || body.shape.kind === 'plane') {
      issue(path, 'A carried body must be a solid free rigid root.');
    }
    if (body.motion.kind === 'free'
      && (body.motion.linearVelocity.some(value => value !== 0) || body.motion.angularVelocity.some(value => value !== 0))) {
      issue(path, 'A carried body derives its initial velocity from the carrier; its own initial linear and angular velocities must be zero.');
    }
    if (!['fixed', 'free'].includes(carrier.motion.kind) || carrier.shape.kind === 'point' || carrier.shape.kind === 'plane') {
      issue(path, 'Carriers must be fixed or free solid roots.');
    }
    if (carrier.heldBy !== null) issue(path, 'Nested carried-body groups are not supported.');
    heldCarrierFor.set(body.id, carrier.id);
    const group = heldByCarrier.get(carrier.id) ?? [];
    group.push(body);
    heldByCarrier.set(carrier.id, group);
  }
  scene.bodies.forEach((body, i) => {
    const path = ['bodies', i] as (string | number)[];
    validateFriction(body.friction, [...path, 'friction']);
    if (body.parentId && !bodies.has(body.parentId)) issue([...path, 'parentId'], 'Parent body does not exist.');
    if (Math.abs(Math.hypot(...body.orientation) - 1) > 1e-5) issue([...path, 'orientation'], 'Orientation must be a normalized w,x,y,z quaternion.');
    if (body.motion.kind !== 'fixed' && body.mass === null) issue([...path, 'mass'], 'A moving body needs a positive mass.');
    if (body.motion.kind === 'fixed' && body.mass !== null) issue([...path, 'mass'], 'An immobile support has no dynamic mass; use null.');
    if (['fixed', 'free', 'particle'].includes(body.motion.kind) && body.parentId !== null) issue([...path, 'parentId'], 'Fixed, free and particle bodies are world-root bodies; use a connection for coupling.');
    if (body.shape.kind === 'plane' && body.motion.kind !== 'fixed') issue([...path, 'shape'], 'An infinite support plane must be fixed.');
    if (body.motion.kind === 'particle' && body.shape.kind !== 'point') issue([...path, 'shape'], 'A point particle must not acquire a collision surface.');
    if (body.shape.kind === 'point' && !['particle', 'fixed'].includes(body.motion.kind)) issue([...path, 'shape'], 'Point markers have no rigid-body rotation or collision shape.');
    if (body.shape.kind === 'point' && (body.restitution !== 0 || body.friction.sliding > 0
      || (body.friction.static ?? 0) > 0 || body.friction.torsional > 0 || body.friction.rolling > 0)) {
      issue([...path, 'shape'], 'Contact materials require a collision surface; a point marker or particle has none.');
    }
    if (body.motion.kind === 'hinge' || body.motion.kind === 'slide') {
      if (Math.abs(Math.hypot(...body.motion.axis) - 1) > 1e-5) issue([...path, 'motion', 'axis'], 'Joint axis must be a unit vector.');
      if (body.motion.limits && (body.motion.limits[0] >= body.motion.limits[1] || body.motion.position < body.motion.limits[0] || body.motion.position > body.motion.limits[1])) issue([...path, 'motion', 'limits'], 'Limits must be ordered and include the initial coordinate.');
    }
    const chain = new Set([body.id]);
    let parent = body.parentId;
    while (parent && bodies.has(parent)) {
      if (chain.has(parent)) { issue([...path, 'parentId'], 'Body parenting must not contain a cycle.'); break; }
      chain.add(parent); parent = bodies.get(parent)!.parentId;
    }
  });
  if (scene.ground !== null) validateFriction(scene.ground.friction, ['ground', 'friction']);
  scene.sites.forEach((site, i) => { if (site.bodyId && !bodies.has(site.bodyId)) issue(['sites', i, 'bodyId'], 'Attachment body does not exist.'); });
  if (scene.connections.length + scene.tendons.length + heldBodies.length > 128) issue(['connections'], 'The combined connection, tendon, and held-body constraint budget is 128.');
  scene.tendons.forEach((tendon, i) => {
    if (tendon.mode !== 'spring' && (tendon.stiffness !== 0 || tendon.damping !== 0)) issue(['tendons', i, 'mode'], 'Fixed and maximum-length cables do not include elastic stiffness or damping; use a spring model for those properties.');
    if (tendon.path[0]?.kind !== 'site' || tendon.path.at(-1)?.kind !== 'site') issue(['tendons', i, 'path'], 'A routed path begins and ends with attachment sites.');
    if (tendon.mode === 'spring' && tendon.stiffness <= 0) issue(['tendons', i, 'stiffness'], 'A spring needs positive stiffness.');
    tendon.path.forEach((part, j) => {
      if (part.kind === 'site' && !sites.has(part.siteId)) issue(['tendons', i, 'path', j], 'Routing site does not exist.');
      if (part.kind === 'wrap') {
        const wrapped = bodies.get(part.bodyId);
        if (!wrapped || !['sphere', 'cylinder'].includes(wrapped.shape.kind)) issue(['tendons', i, 'path', j], 'Cable wraps need an existing sphere or cylinder.');
        if (part.sideSiteId && !sites.has(part.sideSiteId)) issue(['tendons', i, 'path', j], 'Wrap side site does not exist.');
      }
    });
  });
  scene.connections.forEach((connection, i) => {
    const a = bodies.get(connection.bodyA); const b = connection.bodyB ? bodies.get(connection.bodyB) : null;
    if (!a || (connection.bodyB && !b)) issue(['connections', i], 'Connected bodies must exist.');
    if (connection.bodyA === connection.bodyB) issue(['connections', i], 'A body cannot be connected to itself.');
    if (connection.kind === 'coupling' && (!a || !b || !['hinge', 'slide'].includes(a.motion.kind) || !['hinge', 'slide'].includes(b.motion.kind) || connection.ratio === 0)) issue(['connections', i], 'A coordinate coupling needs two scalar hinge/slide joints and a nonzero ratio.');
  });
  scene.loads.forEach((load, i) => {
    if (load.kind === 'gravity') {
      if (new Set(load.bodyIds).size !== load.bodyIds.length) issue(['loads', i], 'A gravity group must not repeat a particle.');
      for (const bodyId of load.bodyIds) if (bodies.get(bodyId)?.motion.kind !== 'particle') issue(['loads', i], 'Mutual gravity uses explicit point particles.');
      for (let a = 0; a < load.bodyIds.length; a++) for (let b = a + 1; b < load.bodyIds.length; b++) {
        const pa = bodies.get(load.bodyIds[a])?.position; const pb = bodies.get(load.bodyIds[b])?.position;
        if (pa && pb && Math.hypot(...pa.map((v, axis) => v - pb[axis])) < 1e-8) issue(['loads', i], 'Coincident point masses make inverse-square gravity singular.');
      }
    } else {
      const body = bodies.get(load.bodyId);
      if (!body || body.motion.kind === 'fixed') issue(['loads', i], 'Loads need an existing moving body.');
      if (body?.motion.kind === 'particle') {
        const rotational = (load.kind === 'torque' && Math.hypot(...load.vector) > 0)
          || (load.kind === 'impulse' && Math.hypot(...load.angular) > 0)
          || (load.kind === 'force' && load.point !== null && Math.hypot(...load.point) > 0);
        if (rotational) issue(['loads', i], 'A point particle has no rotational degrees of freedom or off-center application point; use a rigid solid for this load.');
      }
    }
  });
  const carriedRoots = new Set(heldByCarrier.keys());
  const isCarriedGroupBody = (bodyId: string | null) => bodyId !== null && (carriedRoots.has(bodyId) || heldCarrierFor.has(bodyId));
  const siteBodies = new Map(scene.sites.map(site => [site.id, site.bodyId]));
  scene.connections.forEach((connection, i) => {
    if (isCarriedGroupBody(connection.bodyA) || isCarriedGroupBody(connection.bodyB)) {
      issue(['connections', i], 'Carried rigid groups cannot participate in user-declared connections.');
    }
  });
  scene.tendons.forEach((tendon, i) => tendon.path.forEach((part, j) => {
    const bodyId = part.kind === 'wrap' ? part.bodyId : part.kind === 'site' ? siteBodies.get(part.siteId) ?? null : null;
    if (isCarriedGroupBody(bodyId)) issue(['tendons', i, 'path', j], 'Carried rigid groups cannot participate in user-declared tendons.');
  }));
  scene.bodies.forEach((body, i) => {
    if (isCarriedGroupBody(body.id)) return;
    let parent = body.parentId;
    for (let depth = 0; parent && bodies.has(parent) && depth < bodies.size; depth++) {
      if (isCarriedGroupBody(parent)) {
        issue(['bodies', i, 'parentId'], 'Carried rigid groups cannot have articulated descendants.');
        break;
      }
      parent = bodies.get(parent)!.parentId;
    }
  });
  const heldAt = new Set(heldBodies.map(body => body.id));
  scene.events.map((event, index) => ({ event, index })).sort((a, b) => a.event.at - b.event.at || a.index - b.index).forEach(({ event, index }) => {
    const path = ['events', index, 'action'] as (string | number)[];
    const action = event.action;
    if (action.kind === 'impulse') {
      const body = bodies.get(action.bodyId);
      if (!body || body.motion.kind === 'fixed') issue(path, 'A scheduled impulse needs an existing moving body.');
      if (heldAt.has(action.bodyId)) issue(path, 'A scheduled impulse cannot target a body while it is carried; release it first.');
      if (body?.motion.kind === 'particle' && Math.hypot(...action.angular) > 0) {
        issue(path, 'A point particle has no rotational degrees of freedom; use a rigid solid for this impulse.');
      }
    } else if (action.kind === 'load') {
      if (!scene.loads[action.loadIndex] || scene.loads[action.loadIndex].kind === 'impulse') {
        issue(path, 'A load event must reference an existing continuous force, torque, drag, or gravity load.');
      }
    } else {
      const body = bodies.get(action.bodyId);
      if (!body || !heldAt.has(action.bodyId)) {
        issue(path, 'A launch or release event must target a body that is still carried at that time.');
      } else {
        heldAt.delete(action.bodyId);
      }
    }
  });
  if (issues.length) throw new z.ZodError(issues);
  return scene;
}

export function validateDecision(input: unknown): Decision {
  const decision = DecisionSchema.parse(input);
  if (decision.scene) decision.scene = validateScene(decision.scene);
  return decision;
}
