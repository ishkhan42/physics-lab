import assert from 'node:assert/strict';
import test from 'node:test';
import type { z } from 'zod';
import { SceneSchema, validateScene } from '../shared/scene.ts';
import type { Body, Scene, Vec3 } from '../shared/scene.ts';
import type { EntityObservation, InspectionSnapshot } from '../src/physics/types.ts';
import {
  auditSceneStructure, captureStateCheckpoint, createMotionTracker, measureDeclaredLaunchProperties,
  measureJointGeometry, measureNativeBoxBounds, measureTendonGeometry,
} from '../src/physics/evidence.ts';
import { compactInspection, toModelTable, type CompactInspection } from '../src/physics/model-evidence.ts';
import { createRuntime } from '../src/physics/mujoco.ts';
import { changingWrap } from './fixtures.ts';

const friction: Body['friction'] = { sliding: 0, torsional: 0, rolling: 0, static: null };

function fixedBody(id: string, position: Vec3): Body {
  return {
    id, label: id, parentId: null, position, orientation: [1, 0, 0, 0], shape: { kind: 'box', size: [0.2, 0.2, 0.2] },
    mass: null, heldBy: null, motion: { kind: 'fixed' }, restitution: 0, friction, color: '#67d9ce',
  };
}

function hingeBody(id: string, position: Vec3, anchor: Vec3, parentId: string | null = null, velocity = 0): Body {
  return {
    id, label: id, parentId, position, orientation: [1, 0, 0, 0], shape: { kind: 'sphere', radius: 0.1 },
    mass: 1, heldBy: null,
    motion: { kind: 'hinge', axis: [0, 0, 1], anchor, position: 0, velocity, limits: null, stiffness: 0, damping: 0, springReference: 0 },
    restitution: 0, friction, color: '#67d9ce',
  };
}

function freeBody(id: string, position: Vec3, linearVelocity: Vec3 = [0, 0, 0], angularVelocity: Vec3 = [0, 0, 0]): Body {
  return {
    id, label: id, parentId: null, position, orientation: [1, 0, 0, 0], shape: { kind: 'sphere', radius: 0.1 },
    mass: 1, heldBy: null, motion: { kind: 'free', linearVelocity, angularVelocity },
    restitution: 0, friction, color: '#67d9ce',
  };
}

function makeScene(bodies: Body[], options: Partial<Pick<z.input<typeof SceneSchema>, 'gravity' | 'ground' | 'sites' | 'tendons' | 'connections' | 'loads' | 'events'>> = {}): Scene {
  return validateScene({
    category: 'mechanics', title: 'Evidence sample', gravity: [0, 0, 0], bodies,
    sites: [], tendons: [], connections: [], loads: [], ...options,
  });
}

test('structural audit distinguishes independent world joints, fixed supports, and moving-parent coupling', () => {
  const scene = makeScene([
    fixedBody('support', [0, 0, 0]),
    hingeBody('left', [-2, 0, 1], [-2, 0, 1]),
    hingeBody('right', [2, 0, 1], [2, 0, 1]),
    freeBody('carrier', [5, 0, 1]),
    hingeBody('arm', [6, 0, 1], [6, 0.2, 1], 'carrier'),
    hingeBody('support-pivot', [0, 2, 1], [0, 2, 1], 'support'),
  ], {
    ground: null,
    sites: [
      { id: 'world-site', label: 'World site', bodyId: null, position: [-3, 0, 0] },
      { id: 'left-site', label: 'Left site', bodyId: 'left', position: [0, 0, 0] },
      { id: 'right-site', label: 'Right site', bodyId: 'right', position: [0, 0, 0] },
      { id: 'support-site', label: 'Support site', bodyId: 'support', position: [0, 0, 0] },
    ],
    connections: [
      { kind: 'weld', id: 'world-weld', label: 'World weld', bodyA: 'left', bodyB: null },
      { kind: 'weld', id: 'fixed-support', label: 'Fixed support', bodyA: 'support-pivot', bodyB: 'support' },
      { kind: 'coupling', id: 'moving-coupling', label: 'Moving coupling', bodyA: 'left', bodyB: 'right', ratio: 1, offset: 0 },
    ],
    tendons: [
      { id: 'world-tendon', label: 'World route', mode: 'spring', length: 1, stiffness: 1, damping: 0,
        path: [{ kind: 'site', siteId: 'world-site' }, { kind: 'site', siteId: 'left-site' }] },
      { id: 'moving-tendon', label: 'Moving route', mode: 'rope', length: 2,
        path: [{ kind: 'site', siteId: 'left-site' }, { kind: 'pulley', divisor: 2 }, { kind: 'site', siteId: 'right-site' }] },
      { id: 'fixed-tendon', label: 'Supported route', mode: 'spring', length: 1, stiffness: 1, damping: 0,
        path: [{ kind: 'site', siteId: 'left-site' }, { kind: 'site', siteId: 'support-site' }] },
    ],
  });
  const audit = auditSceneStructure(scene);
  const joints = new Map(audit.joints.map(joint => [joint.bodyId, joint]));
  assert.equal(joints.get('left')?.parentRelation, 'world');
  assert.equal(joints.get('right')?.parentRelation, 'world');
  assert.equal(joints.get('arm')?.parentRelation, 'moving-body');
  assert.equal(joints.get('support-pivot')?.parentRelation, 'fixed-body');
  assert.equal(audit.bodies.find(body => body.id === 'arm')?.mobility, 'moving');
  assert.equal(audit.connections.find(connection => connection.id === 'world-weld')?.relation, 'world-support');
  assert.equal(audit.connections.find(connection => connection.id === 'fixed-support')?.relation, 'fixed-body-support');
  assert.equal(audit.connections.find(connection => connection.id === 'moving-coupling')?.relation, 'moving-body-coupling');
  assert.equal(audit.tendons.find(tendon => tendon.id === 'world-tendon')?.relation, 'world-support');
  assert.equal(audit.tendons.find(tendon => tendon.id === 'moving-tendon')?.relation, 'moving-body-coupling');
  assert.equal(audit.tendons.find(tendon => tendon.id === 'fixed-tendon')?.relation, 'fixed-body-support');
  assert.deepEqual(audit.tendons.find(tendon => tendon.id === 'moving-tendon')?.route.map(part => part.kind), ['site', 'pulley', 'site']);
});

test('initial sphere penetration comes from native contact distance and names both bodies', async () => {
  const scene = validateScene({
    category: 'mechanics', title: 'Initial penetration', gravity: [0, 0, 0],
    bodies: [freeBody('probe', [0, 0, 0.06])], sites: [], tendons: [], connections: [], loads: [],
  });
  const runtime = await createRuntime(scene);
  try {
    const snapshot = runtime.snapshot();
    const contact = snapshot.contacts?.find(({ bodyAId, bodyBId }) => new Set([bodyAId, bodyBId]).has('probe')
      && new Set([bodyAId, bodyBId]).has('world-ground'));
    assert.ok(contact, 'the initial native contact should identify the probe and ground');
    assert.ok(Number.isFinite(contact.distance));
    assert.ok(contact.distance < -0.01, `expected signed penetration, got ${contact.distance}`);
    assert.equal(snapshot.contactsTruncated, false);
  } finally {
    runtime.dispose();
  }
});

test('motion sampling captures spin and a moving body that returns to its initial pose', async () => {
  const spinner = hingeBody('spinner', [0, 0, 2], [0, 0, 2], null, Math.PI * 2);
  const spinningRuntime = await createRuntime(makeScene([spinner], { ground: null }));
  try {
    const tracker = createMotionTracker(spinningRuntime);
    tracker.sample();
    for (let index = 0; index < 4; index++) {
      assert.equal(spinningRuntime.advance(0.25, 1).pauseReason, null);
      tracker.sample();
    }
    const spun = tracker.report().find(item => item.bodyId === 'spinner');
    assert.ok(spun);
    assert.equal(spun.samples, 5);
    assert.ok(spun.maxTranslation < 1e-8);
    assert.ok(spun.maxAngularChange > 3);
    assert.ok(spun.totalAngularChange > 6);
    const finalQuaternion = spinningRuntime.frame().find(item => item.id === 'spinner')!.quaternion;
    assert.ok(Math.abs(Math.abs(finalQuaternion[3]) - 1) < 1e-5, 'a full turn returns to the initial orientation');
  } finally {
    spinningRuntime.dispose();
  }

  const mover = freeBody('mover', [0, 0, 2], [1, 0, 0]);
  const movingRuntime = await createRuntime(makeScene([mover], {
    ground: null,
    events: [
      { id: 'reverse', label: 'Reverse', at: 0.5, action: { kind: 'impulse', bodyId: 'mover', linear: [-2, 0, 0] } },
      { id: 'restore', label: 'Restore velocity', at: 1, action: { kind: 'impulse', bodyId: 'mover', linear: [2, 0, 0] } },
    ],
  }));
  try {
    const tracker = createMotionTracker(movingRuntime);
    tracker.sample();
    for (let index = 0; index < 4; index++) {
      assert.equal(movingRuntime.advance(0.25, 1).pauseReason, null);
      tracker.sample();
    }
    const moved = tracker.report().find(item => item.bodyId === 'mover');
    assert.ok(moved);
    assert.equal(moved.samples, 5);
    assert.ok(moved.maxTranslation > 0.45);
    assert.ok(moved.totalTranslation > 0.9);
    const initial = [0, 0, 2];
    const final = movingRuntime.frame().find(item => item.id === 'mover')!.position;
    assert.ok(Math.hypot(final[0] - initial[0], final[1] - initial[1], final[2] - initial[2]) < 1e-5,
      'the body returns near its initial pose despite the sampled path');
  } finally {
    movingRuntime.dispose();
  }
});

test('native checkpoints show launch-driven motion and distinguish world from carrier-relative vectors', async () => {
  const scene = makeScene([
    fixedBody('world-carrier', [0, 0, 2]),
    { ...freeBody('world-projectile', [0.4, 0, 2]), heldBy: 'world-carrier' },
    fixedBody('body-carrier', [0, 2, 2]),
    { ...freeBody('body-projectile', [0.4, 2, 2]), heldBy: 'body-carrier' },
  ], {
    ground: null,
    events: [
      { id: 'world-shot', label: 'World shot', at: 0.1, action: { kind: 'launch', bodyId: 'world-projectile', velocity: [299.58886042637215, 0, 15.70078687288315], frame: 'world' } },
      { id: 'body-shot', label: 'Body shot', at: 0.1, action: { kind: 'launch', bodyId: 'body-projectile', velocity: [0, 300, 0], frame: 'body' } },
    ],
  });
  const declared = new Map(measureDeclaredLaunchProperties(scene).map(launch => [launch.eventId, launch]));
  const worldLaunch = declared.get('world-shot')!;
  assert.equal(worldLaunch.provenance, 'declared-scene-event');
  assert.equal(worldLaunch.velocityFrame, 'world');
  assert.ok(Math.abs(worldLaunch.speedMetersPerSecond - 300) < 1e-9);
  assert.ok(Math.abs(worldLaunch.worldXYElevationDegrees! - 3) < 1e-9);
  const bodyLaunch = declared.get('body-shot')!;
  assert.equal(bodyLaunch.velocityFrame, 'carrier-relative');
  assert.equal(bodyLaunch.worldXYElevationDegrees, null);
  assert.equal(bodyLaunch.speedMetersPerSecond, 300);
  const stopped = measureDeclaredLaunchProperties(validateScene({
    ...scene, events: [{ id: 'stop', label: 'Stop payload', at: 0.1, action: { kind: 'launch', bodyId: 'world-projectile', velocity: [0, 0, 0], frame: 'world' } }],
  }))[0];
  assert.equal(stopped.speedMetersPerSecond, 0);
  assert.equal(stopped.worldXYElevationDegrees, null);

  const runtime = await createRuntime(scene);
  try {
    const tracker = createMotionTracker(runtime);
    tracker.sample();
    const initial = captureStateCheckpoint('initial', runtime, tracker.report());
    assert.equal(initial.simulatedTime, 0);
    assert.equal(initial.provenance, 'native-runtime-frame');
    const initialWorldPosition = initial.bodies.find(body => body.bodyId === 'world-projectile')!.position;
    assert.equal(runtime.advance(0.099, 1).pauseReason, null);
    tracker.sample();
    const before = captureStateCheckpoint('before-launch', runtime, tracker.report());
    const beforeWorld = before.bodies.find(body => body.bodyId === 'world-projectile')!;
    assert.ok(beforeWorld.maxTranslation < 1e-8);
    assert.equal(runtime.snapshot().events?.find(event => event.id === 'world-shot')?.status, 'pending');

    assert.equal(runtime.advance(0.002, 1).pauseReason, null);
    tracker.sample();
    const after = captureStateCheckpoint('after-launch', runtime, tracker.report());
    const afterWorld = after.bodies.find(body => body.bodyId === 'world-projectile')!;
    const afterBody = after.bodies.find(body => body.bodyId === 'body-projectile')!;
    assert.ok(afterWorld.maxTranslation > 0.25);
    assert.ok(afterBody.position[1] > before.bodies.find(body => body.bodyId === 'body-projectile')!.position[1] + 0.25);
    assert.ok(afterWorld.position[0] > initialWorldPosition[0] + 0.25);
    assert.equal(runtime.snapshot().events?.find(event => event.id === 'world-shot')?.status, 'completed');
  } finally {
    runtime.dispose();
  }
});

test('native child-joint link follows its moving parent without adding a body or selectable entity', async () => {
  const carrier = freeBody('carrier', [0, 0, 2], [0, 0, 0], [0, 0, 1]);
  const arm: Body = {
    ...hingeBody('arm', [1, 0, 2], [1, 0.3, 2], 'carrier'),
    shape: { kind: 'cylinder', radius: 0.05, length: 0.6 },
  };
  const scene = makeScene([carrier, arm], { ground: null });
  const runtime = await createRuntime(scene);
  try {
    const initial = runtime.frame();
    const reference = initial.find(item => item.id === 'joint-link:arm');
    assert.ok(reference);
    assert.equal(reference.shape.kind, 'line');
    assert.equal(reference.selectable, false);
    const initialAnchor = [...reference.points![0]];
    assert.equal(runtime.advance(0.2, 1).pauseReason, null);
    const frame = runtime.frame();
    const movingReference = frame.find(item => item.id === 'joint-link:arm')!;
    const movingArm = frame.find(item => item.id === 'arm')!;
    assert.ok(Math.hypot(...movingReference.points![0].map((value, index) => value - initialAnchor[index])) > 0.1,
      'the native anchor follows the moving parent instead of staying at its reference world point');
    assert.deepEqual(movingReference.points![1], movingArm.position);
    const tracker = createMotionTracker(runtime);
    tracker.sample();
    const checkpoint = captureStateCheckpoint('moving', runtime, tracker.report());
    assert.deepEqual(checkpoint.bodies.map(body => body.bodyId), ['carrier', 'arm']);
    assert.equal(runtime.scene.bodies.length, 2);
    const snapshot = runtime.snapshot();
    const bodyEntities = snapshot.entities.filter(entity => entity.kind === 'body');
    assert.equal(bodyEntities.length, 2);
    assert.equal(bodyEntities.find(entity => entity.id === 'arm')?.properties.find(property => property.label === 'Mass')?.value, 1);
    assert.equal(bodyEntities.find(entity => entity.id === 'arm')?.properties.find(property => property.label === 'Motion')?.value, 'hinge');
    assert.equal(bodyEntities.find(entity => entity.id === 'arm')?.properties.filter(property => property.label.startsWith('Joint ')).length, 2);
  } finally {
    runtime.dispose();
  }
});

test('native oriented box bounds use full side lengths and show a touching ground face', async () => {
  const angle = Math.PI / 4;
  const block: Body = {
    ...freeBody('angled-block', [0, 0, 0.25]),
    shape: { kind: 'box', size: [2, 1, 0.5] },
    orientation: [Math.cos(angle / 2), 0, 0, Math.sin(angle / 2)],
  };
  const runtime = await createRuntime(makeScene([block], { gravity: [0, 0, -9.81] }));
  try {
    const bound = measureNativeBoxBounds(runtime).find(item => item.bodyId === 'angled-block')!;
    assert.ok(Math.abs(bound.worldAabb.min[0] + 1.0606601717798214) < 1e-9);
    assert.ok(Math.abs(bound.worldAabb.max[0] - 1.0606601717798214) < 1e-9);
    assert.ok(Math.abs(bound.worldAabb.min[1] + 1.0606601717798214) < 1e-9);
    assert.ok(Math.abs(bound.worldAabb.max[1] - 1.0606601717798214) < 1e-9);
    assert.ok(Math.abs(bound.worldAabb.min[2]) < 1e-9);
    assert.ok(Math.abs(bound.worldAabb.max[2] - 0.5) < 1e-9);
    const contact = runtime.snapshot().contacts?.find(item =>
      (item.bodyAId === 'angled-block' && item.bodyBId === 'world-ground')
      || (item.bodyBId === 'angled-block' && item.bodyAId === 'world-ground'));
    assert.ok(contact, 'native contact should identify the touching box and ground');
    assert.ok(Math.abs(contact.distance) < 1e-6);
  } finally {
    runtime.dispose();
  }
});

test('native geometry measures an inclined reference pose at joint zero, independent of coordinate labels', async () => {
  const bob = hingeBody('bob', [0.5, 0, 2 - Math.sqrt(3) / 2], [0, 0, 2]);
  assert.equal(bob.motion.kind, 'hinge');
  if (bob.motion.kind !== 'hinge') throw new Error('Invalid fixture.');
  bob.motion.axis = [0, 1, 0];
  for (const gravity of [[0, 0, -9.81], [0, 0, 0]] satisfies Vec3[]) {
    const runtime = await createRuntime(validateScene({ ...makeScene([bob], { ground: null }), gravity }));
    try {
      const initial = measureJointGeometry(runtime)[0];
      assert.ok(Math.abs(initial.anchorToBodyOriginMeters - 1) < 1e-10);
      assert.deepEqual(initial.worldAnchor, [0, 0, 2]);
      if (gravity[2]) assert.ok(Math.abs(initial.angleFromGravityDegrees! - 30) < 1e-9);
      else assert.equal(initial.angleFromGravityDegrees, null);
      for (let step = 0; step < 20; step++) assert.equal(runtime.advance(0.025, 1).pauseReason, null);
      const final = measureJointGeometry(runtime)[0];
      assert.ok(Math.abs(final.anchorToBodyOriginMeters - 1) < 1e-9);
      assert.ok(Math.abs(initial.worldBodyOrigin[0] - 0.5) < 1e-10, 'initial evidence must not mutate with native frames');
      if (gravity[2]) assert.ok(final.angleFromGravityDegrees! < 10);
    } finally { runtime.dispose(); }
  }
});

test('massless fixed supports report their actual world pose, not an undefined inertial origin', async () => {
  const support = fixedBody('support', [1, 2, 3]);
  support.orientation = [Math.SQRT1_2, 0, Math.SQRT1_2, 0];
  const scene = makeScene([support, freeBody('load', [1, 2, 1])], {
    ground: null,
    sites: [
      { id: 'top', label: 'Top', bodyId: 'support', position: [0.2, 0, 0] },
      { id: 'bottom', label: 'Bottom', bodyId: 'load', position: [0, 0, 0] },
    ],
    tendons: [{ id: 'cord', label: 'Cord', mode: 'fixed', length: 1.8, path: [{ kind: 'site', siteId: 'top' }, { kind: 'site', siteId: 'bottom' }] }],
  });
  const runtime = await createRuntime(scene);
  try {
    for (let step = 0; step < 2; step++) {
      const position = runtime.snapshot().entities.find(entity => entity.id === 'support')!.properties.find(property => property.label === 'Position')!.value;
      assert.deepEqual(position, [1, 2, 3]);
      const endpoint = runtime.frame().find(item => item.entityId === 'cord')!.points![0];
      assert.ok(Math.abs(endpoint[0] - 1) < 1e-10 && Math.abs(endpoint[1] - 2) < 1e-10 && Math.abs(endpoint[2] - 2.8) < 1e-10);
      assert.equal(runtime.advance(0.025, 1).pauseReason, null);
    }
  } finally { runtime.dispose(); }
});

test('initial carrying evidence reflects native attachment, loaded mass and launch reaction', async () => {
  for (const fixed of [false, true]) {
    const carrier = fixed ? fixedBody('carrier', [0, 0, 0]) : { ...freeBody('carrier', [0, 0, 0]), mass: 1000 };
    const payload = { ...freeBody('payload', [0.4, 0, 0]), mass: 10, heldBy: 'carrier' };
    const scene = makeScene([carrier, payload], {
      ground: null,
      events: [{ id: 'fire', label: 'Launch', at: 0, action: { kind: 'launch', bodyId: 'payload', velocity: [10, 0, 0], frame: 'world' } }],
    });
    const structure = auditSceneStructure(scene);
    assert.equal(structure.carrying[0]?.relation, fixed ? 'fixed-body-support' : 'moving-body-coupling');
    assert.equal(structure.carrying[0]?.release?.kind, 'launch');
    assert.equal(structure.bodies.find(body => body.id === 'payload')?.mobility, fixed ? 'fixed' : 'moving');
    assert.ok(!structure.joints.some(joint => joint.bodyId === 'payload'), 'a held body is not an independent world-jointed mechanism');
    const runtime = await createRuntime(scene);
    try {
      const property = (id: string, label: string) => runtime.snapshot().entities.find(entity => entity.id === id)!.properties.find(item => item.label === label)!.value;
      if (!fixed) assert.equal(property('carrier', 'Loaded mass'), 1010);
      assert.equal(runtime.frame().find(item => item.id === 'payload')?.visible, false);
      assert.equal(runtime.advance(0.025, 1).pauseReason, null);
      const carrierVelocity = property('carrier', 'Velocity') as Vec3;
      const payloadVelocity = property('payload', 'Velocity') as Vec3;
      assert.ok(Math.abs(payloadVelocity[0] - 10) < 1e-8);
      assert.ok(Math.abs(carrierVelocity[0] - (fixed ? 0 : -0.1)) < 1e-8);
      assert.equal(runtime.snapshot().events?.[0]?.status, 'completed');
      assert.notEqual(runtime.frame().find(item => item.id === 'payload')?.visible, false);
      if (!fixed) assert.ok(Math.abs(1000 * carrierVelocity[0] + 10 * payloadVelocity[0]) < 1e-8);
    } finally { runtime.dispose(); }
  }
});

test('branched cord evidence distinguishes vertical drops from path lengths at release', async () => {
  const knot: Body = { ...freeBody('knot', [0, 0, 1.25]), shape: { kind: 'point' }, mass: 0.01, motion: { kind: 'particle', linearVelocity: [0, 0, 0] } };
  const bob = freeBody('bob', [0, 0.25, 1]);
  const upperLength = Math.hypot(0.2, 0.75), lowerLength = Math.hypot(0.25, 0.25);
  const scene = makeScene([knot, bob], {
    gravity: [0, 0, -9.81], ground: null,
    sites: [
      { id: 'left', label: 'Left support', bodyId: null, position: [-0.2, 0, 2] },
      { id: 'right', label: 'Right support', bodyId: null, position: [0.2, 0, 2] },
      { id: 'join', label: 'Shared junction', bodyId: 'knot', position: [0, 0, 0] },
      { id: 'end', label: 'Bob attachment', bodyId: 'bob', position: [0, 0, 0] },
    ],
    tendons: [
      { id: 'upper_left', label: 'Left cord', path: [{ kind: 'site', siteId: 'left' }, { kind: 'site', siteId: 'join' }], mode: 'rope', length: upperLength, stiffness: 0, damping: 0, color: '#f2c178' },
      { id: 'upper_right', label: 'Right cord', path: [{ kind: 'site', siteId: 'right' }, { kind: 'site', siteId: 'join' }], mode: 'rope', length: upperLength, stiffness: 0, damping: 0, color: '#f2c178' },
      { id: 'lower', label: 'Lower cord', path: [{ kind: 'site', siteId: 'join' }, { kind: 'site', siteId: 'end' }], mode: 'rope', length: lowerLength, stiffness: 0, damping: 0, color: '#f2c178' },
    ],
  });
  assert.equal(auditSceneStructure(scene).tendons.find(tendon => tendon.id === 'lower')?.relation, 'moving-body-coupling');
  const runtime = await createRuntime(scene);
  try {
    const initial = measureTendonGeometry(runtime, runtime.snapshot());
    const lower = initial.find(tendon => tendon.tendonId === 'lower')!;
    assert.ok(Math.abs(lower.nativePathLengthMeters - lowerLength) < 1e-10);
    assert.ok(initial.every(tendon => Math.abs(tendon.signedPathLengthResidualMeters) < 1e-10));
    assert.ok(Math.abs(lower.straightSpan!.worldZSeparationMeters - 0.25) < 1e-10);
    assert.ok(Math.abs(lower.straightSpan!.angleFromWorldVerticalDegrees! - 45) < 1e-9);
    assert.ok(initial.filter(tendon => tendon.tendonId !== 'lower').every(tendon => Math.abs(tendon.straightSpan!.worldZSeparationMeters - 0.75) < 1e-10));
    for (let step = 0; step < 20; step++) assert.equal(runtime.advance(0.025, 1).pauseReason, null);
    const final = measureTendonGeometry(runtime, runtime.snapshot());
    assert.ok(final.every(tendon => tendon.signedPathLengthResidualMeters > 0 && tendon.signedPathLengthResidualMeters < 0.005), 'regularized ropes retain their bounded spans without pretending to be exact');
    assert.ok(Math.hypot(...final.find(tendon => tendon.tendonId === 'lower')!.straightSpan!.end.map((value, index) => value - lower.straightSpan!.end[index])) > 0.02);
    assert.deepEqual(lower.straightSpan!.end, [0, 0.25, 1], 'initial geometry must not mutate with native frames');
  } finally { runtime.dispose(); }
});

test('wrapped cord evidence retains native route length without inventing a straight inclination', async () => {
  const runtime = await createRuntime(changingWrap());
  try {
    const path = runtime.frame().find(item => item.entityId === 'spring')!.points!;
    assert.ok(path.length > 2);
    const geometry = measureTendonGeometry(runtime, runtime.snapshot()).find(tendon => tendon.tendonId === 'spring')!;
    const first = path[0], last = path.at(-1)!;
    const chord = Math.hypot(last[0] - first[0], last[1] - first[1], last[2] - first[2]);
    assert.ok(geometry.nativePathLengthMeters > chord + 0.001);
    assert.notEqual(geometry.signedPathLengthResidualMeters, chord - geometry.declaredLengthMeters);
    assert.equal(geometry.straightSpan, null);
  } finally { runtime.dispose(); }
});

test('compact inspections retain ordered metadata, measurements and the original entity order', () => {
  const snapshot: InspectionSnapshot = {
    time: 0.125,
    entities: [
      {
        id: 'first', label: 'First', kind: 'body', color: '#112233',
        properties: [
          { label: 'Mass', value: 1.0000000000000002, unit: 'kg', note: 'native' },
          { label: 'Mass', value: 1000, unit: 'g' },
          { label: 'Position', value: [0.10000000000000002, 2, -3], unit: 'm' },
          { label: 'Contact force', value: 'Unavailable', unit: 'N' },
        ],
      },
      {
        id: 'cord', label: 'Cord', kind: 'tendon', color: '#445566',
        properties: [
          { label: 'Tension', value: 0, unit: 'N' },
          { label: 'Mode', value: 'rope' },
        ],
      },
      {
        id: 'last', label: 'Last', kind: 'body', color: '#778899',
        properties: [
          { label: 'Mass', value: 2.0000000000000004, unit: 'kg', note: 'native' },
          { label: 'Mass', value: 2000, unit: 'g' },
          { label: 'Position', value: [4, 5, 6], unit: 'm' },
          { label: 'Contact force', value: [0, 0, 0], unit: 'N' },
        ],
      },
    ],
    notes: ['Keep every native note.'],
    contacts: [{ bodyAId: 'first', bodyBId: 'world-ground', distance: -0.000000123456789 }],
    contactsTruncated: true,
    events: [{ id: 'launch', label: 'Launch', at: 0.1, status: 'pending', firedAt: null }],
  };
  const original = structuredClone(snapshot);
  const compact = compactInspection(snapshot);
  assert.deepEqual(compact.entityTables.map(table => table.rows.map(row => row[0])), [[0, 2], [1]]);
  const [firstTable, cordTable] = compact.entityTables;
  assert.ok(firstTable && cordTable);
  assert.deepEqual(firstTable.observationColumns.map(column => column.label), ['Mass', 'Mass', 'Position', 'Contact force']);
  assert.equal(Object.hasOwn(firstTable.observationColumns[0]!, 'unit'), true);
  assert.equal(cordTable.observationColumns[0]?.unit, 'N');
  assert.equal(Object.hasOwn(cordTable.observationColumns[1]!, 'unit'), false);
  assert.deepEqual(firstTable.rows[0]?.slice(5), [1.0000000000000002, 1000, [0.10000000000000002, 2, -3], 'Unavailable']);
  assert.deepEqual(firstTable.rows[1]?.slice(5), [2.0000000000000004, 2000, [4, 5, 6], [0, 0, 0]]);

  const restoredEntities: (EntityObservation | undefined)[] = Array(snapshot.entities.length);
  for (const table of compact.entityTables) {
    for (const [index, id, label, kind, color, ...values] of table.rows) {
      restoredEntities[index] = {
        id, label, kind, color,
        properties: table.observationColumns.map((descriptor, propertyIndex) => ({
          ...descriptor,
          value: values[propertyIndex],
        })),
      };
    }
  }
  const { entityTables: _entityTables, ...inspection } = compact;
  const restored: InspectionSnapshot = {
    ...inspection,
    entities: Array.from({ length: restoredEntities.length }, (_, index) => {
      const entity = restoredEntities[index];
      assert.ok(entity);
      return entity;
    }),
  };
  assert.deepEqual(restored, snapshot);
  assert.deepEqual(snapshot, original);
});

test('fixed-record model tables keep every column and reject later optional keys', () => {
  const records = [
    { bodyId: 'first', position: [0.10000000000000002, 2, 3], optional: null },
    { bodyId: 'second', position: [4, 5, 6], optional: 'Unavailable' },
  ];
  const table = toModelTable(records);
  const restored = table.rows.map(row => Object.fromEntries(table.columns.map((column, index) => [column, row[index]])));
  assert.deepEqual(restored, records);
  assert.throws(() => toModelTable([{ bodyId: 'first' }, { bodyId: 'second', laterOptional: 1 }]), Error);
});
