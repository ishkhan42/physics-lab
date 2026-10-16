import { z } from 'zod';

const number = z.number().finite();
const positive = number.positive();
const nonnegative = number.nonnegative();
const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
export const Vec3Schema = z.tuple([number, number, number]);
export const QuatSchema = z.tuple([number, number, number, number]);
export type Vec3 = z.infer<typeof Vec3Schema>;
export type Quat = z.infer<typeof QuatSchema>;
const zero: Vec3 = [0, 0, 0];

export const ShapeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('sphere'), radius: positive }),
  z.strictObject({ kind: z.literal('box'), size: z.tuple([positive, positive, positive]) }),
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
  position: number.default(0),
  velocity: number.default(0),
  limits: z.tuple([number, number]).nullable().default(null),
  stiffness: nonnegative.default(0),
  damping: nonnegative.default(0),
  springReference: number.default(0),
};
export const MotionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('fixed') }),
  z.strictObject({ kind: z.literal('free'), linearVelocity: Vec3Schema.default(zero), angularVelocity: Vec3Schema.default(zero) }),
  z.strictObject({ kind: z.literal('particle'), linearVelocity: Vec3Schema.default(zero) }),
  z.strictObject({ kind: z.literal('hinge'), ...joint }),
  z.strictObject({ kind: z.literal('slide'), ...joint }),
  z.strictObject({ kind: z.literal('ball'), angularVelocity: Vec3Schema.default(zero), damping: nonnegative.default(0) }),
]);
export const BodySchema = z.strictObject({
  id,
  label: z.string().trim().min(1).max(100),
  parentId: id.nullable().default(null),
  position: Vec3Schema.describe('World-space reference pose; joint position then applies the initial DOF coordinate.'),
  orientation: QuatSchema.default([1, 0, 0, 0]).describe('World-space reference orientation, quaternion w,x,y,z.'),
  shape: ShapeSchema,
  mass: positive.nullable().describe('Kilograms for moving bodies; null for immobile supports.'),
  motion: MotionSchema,
  friction: z.strictObject({
    sliding: nonnegative,
    torsional: nonnegative.describe('Torsional friction length in metres, not a second sliding coefficient.'),
    rolling: nonnegative.describe('Rolling friction length in metres.'),
  }).default({ sliding: 0, torsional: 0, rolling: 0 }),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#67d9ce'),
});
export type Body = z.infer<typeof BodySchema>;

export const SiteSchema = z.strictObject({
  id, label: z.string().min(1).max(100), bodyId: id.nullable(),
  position: Vec3Schema.describe('Body-local position when attached to a body; world position otherwise.'),
});
const PathSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('site'), siteId: id }),
  z.strictObject({ kind: z.literal('wrap'), bodyId: id, sideSiteId: id.nullable().default(null) }),
  z.strictObject({ kind: z.literal('pulley'), divisor: positive }),
]);
export const TendonSchema = z.strictObject({
  id, label: z.string().min(1).max(100),
  path: z.array(PathSchema).min(2).max(64),
  mode: z.enum(['fixed', 'rope', 'spring']).describe('Only spring mode uses stiffness/damping; fixed and rope require both to be zero.'),
  length: positive.describe('Fixed/maximum length, or spring rest length, in metres.'),
  stiffness: nonnegative.default(0), damping: nonnegative.default(0),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#f2c178'),
});
export type Tendon = z.infer<typeof TendonSchema>;
const ConnectionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('connect'), id, label: z.string().min(1).max(100), bodyA: id, bodyB: id.nullable(), anchor: Vec3Schema }),
  z.strictObject({ kind: z.literal('weld'), id, label: z.string().min(1).max(100), bodyA: id, bodyB: id.nullable() }),
  z.strictObject({ kind: z.literal('coupling'), id, label: z.string().min(1).max(100), bodyA: id, bodyB: id, ratio: number, offset: number }),
]);
const LoadSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('force'), bodyId: id, vector: Vec3Schema, point: Vec3Schema.nullable().default(null) }),
  z.strictObject({ kind: z.literal('torque'), bodyId: id, vector: Vec3Schema }),
  z.strictObject({ kind: z.literal('impulse'), bodyId: id, linear: Vec3Schema, angular: Vec3Schema.default(zero) }),
  z.strictObject({ kind: z.literal('drag'), bodyId: id, coefficient: nonnegative, mediumVelocity: Vec3Schema.default(zero) }),
  z.strictObject({ kind: z.literal('gravity'), bodyIds: z.array(id).min(2).max(32), G: positive }),
]);
export const SceneSchema = z.strictObject({
  category: z.literal('mechanics'),
  title: z.string().trim().min(1).max(120),
  gravity: Vec3Schema,
  bodies: z.array(BodySchema).min(1).max(128),
  sites: z.array(SiteSchema).max(512).default([]),
  tendons: z.array(TendonSchema).max(128).default([]),
  connections: z.array(ConnectionSchema).max(128).default([]),
  loads: z.array(LoadSchema).max(256).default([]),
});
export type Scene = z.infer<typeof SceneSchema>;
export const DecisionSchema = z.strictObject({
  kind: z.enum(['scene', 'clarify', 'unsupported']),
  summary: z.string().trim().min(1).max(3000),
  assumptions: z.array(z.string().min(1).max(600)).max(40),
  question: z.string().min(1).max(2000).nullable(),
  reason: z.string().min(1).max(3000).nullable(),
  scene: SceneSchema.nullable(),
  alternative: z.strictObject({
    label: z.string().trim().min(1).max(60),
    description: z.string().trim().min(1).max(1600),
  }).nullable().default(null),
});
export type Decision = z.infer<typeof DecisionSchema>;
export const ProviderSchema = z.enum(['openai', 'anthropic', 'openrouter']);
export type Provider = z.infer<typeof ProviderSchema>;
export const AssemblyRequestSchema = z.strictObject({
  provider: ProviderSchema,
  model: z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/),
  description: z.string().trim().min(3).max(16000),
  clarification: z.array(z.strictObject({ question: z.string().min(1).max(2000), answer: z.string().trim().min(1).max(4000) })).max(12).default([]),
});
export type AssemblyRequest = z.infer<typeof AssemblyRequestSchema>;

export function validateScene(input: unknown): Scene {
  const scene = SceneSchema.parse(input);
  const issues: z.core.$ZodIssue[] = [];
  const issue = (path: (string | number)[], message: string) => issues.push({ code: 'custom', path, message });
  const bodies = new Map(scene.bodies.map(body => [body.id, body]));
  const sites = new Map(scene.sites.map(site => [site.id, site]));
  const names = new Set<string>();
  for (const [group, entries] of [['bodies', scene.bodies], ['sites', scene.sites], ['tendons', scene.tendons], ['connections', scene.connections]] as const) {
    entries.forEach((item, i) => {
      if (item.id === 'world' || names.has(item.id)) issue([group, i, 'id'], 'Entity IDs must be unique and cannot be world.');
      names.add(item.id);
    });
  }
  scene.bodies.forEach((body, i) => {
    const path = ['bodies', i] as (string | number)[];
    if (body.parentId && !bodies.has(body.parentId)) issue([...path, 'parentId'], 'Parent body does not exist.');
    if (Math.abs(Math.hypot(...body.orientation) - 1) > 1e-5) issue([...path, 'orientation'], 'Orientation must be a normalized w,x,y,z quaternion.');
    if (body.motion.kind !== 'fixed' && body.mass === null) issue([...path, 'mass'], 'A moving body needs a positive mass.');
    if (body.motion.kind === 'fixed' && body.mass !== null) issue([...path, 'mass'], 'An immobile support has no dynamic mass; use null.');
    if (['fixed', 'free', 'particle'].includes(body.motion.kind) && body.parentId !== null) issue([...path, 'parentId'], 'Fixed, free and particle bodies are world-root bodies; use a connection for coupling.');
    if (body.shape.kind === 'plane' && body.motion.kind !== 'fixed') issue([...path, 'shape'], 'An infinite support plane must be fixed.');
    if (body.motion.kind === 'particle' && body.shape.kind !== 'point') issue([...path, 'shape'], 'A point particle must not acquire a collision surface.');
    if (body.shape.kind === 'point' && !['particle', 'fixed'].includes(body.motion.kind)) issue([...path, 'shape'], 'Point markers have no rigid-body rotation or collision shape.');
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
  scene.sites.forEach((site, i) => { if (site.bodyId && !bodies.has(site.bodyId)) issue(['sites', i, 'bodyId'], 'Attachment body does not exist.'); });
  if (scene.connections.length + scene.tendons.length > 128) issue(['connections'], 'The combined constraint/tendon budget is 128.');
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
  if (issues.length) throw new z.ZodError(issues);
  return scene;
}

export function validateDecision(input: unknown): Decision {
  const decision = DecisionSchema.parse(input);
  const valid = decision.kind === 'scene'
    ? decision.scene !== null && decision.question === null && decision.reason === null && decision.alternative === null
    : decision.kind === 'clarify'
      ? decision.scene === null && decision.question !== null
      : decision.scene === null && decision.reason !== null;
  if (!valid) throw new z.ZodError([{ code: 'custom', path: ['kind'], message: 'Only a complete scene without unresolved questions, limitations or alternatives may be ready. Other decisions must not include a scene.' }]);
  if (decision.scene) decision.scene = validateScene(decision.scene);
  return decision;
}
