import assert from 'node:assert/strict';
import test from 'node:test';
import { validateScene } from '../shared/scene.ts';
import type { Body, Scene, Vec3 } from '../shared/scene.ts';
import { createRuntime } from '../src/physics/mujoco.ts';
import type { InspectionSnapshot, MechanicsRuntime } from '../src/physics/types.ts';

const zeroFriction: Body['friction'] = { sliding: 0, torsional: 0, rolling: 0, static: null };
type SphereOptions = Partial<Pick<Body, 'mass' | 'restitution' | 'friction'>>;

function sphere(id: string, position: Vec3, velocity: Vec3, options: SphereOptions = {}): Body {
  return {
    id, label: id, parentId: null, position, orientation: [1, 0, 0, 0],
    heldBy: null,
    shape: { kind: 'sphere', radius: 0.1 }, mass: options.mass ?? 1,
    motion: { kind: 'free', linearVelocity: velocity, angularVelocity: [0, 0, 0] },
    restitution: options.restitution ?? 0, friction: options.friction ?? zeroFriction, color: '#67d9ce',
  };
}

function friction(sliding: number, staticCoefficient: number | null = null): Body['friction'] {
  return { sliding, torsional: 0, rolling: 0, static: staticCoefficient };
}

function ground(restitution = 1, sliding = 0, staticCoefficient: number | null = null, height = 0): NonNullable<Scene['ground']> {
  return { height, restitution, friction: friction(sliding, staticCoefficient) };
}

function contactScene(bodies: Body[], gravity: Vec3 = [0, 0, 0], groundConfig?: Scene['ground'], loads: Scene['loads'] = []): Scene {
  return validateScene({
    category: 'mechanics', title: 'Contact experiment', gravity, bodies,
    sites: [], tendons: [], connections: [], loads,
    ...(groundConfig === undefined ? {} : { ground: groundConfig }),
  });
}

function value(snapshot: InspectionSnapshot, entityId: string, label: string): number | string | number[] {
  const entity = snapshot.entities.find(item => item.id === entityId);
  assert.ok(entity, `missing inspected entity ${entityId}`);
  const property = entity.properties.find(item => item.label === label);
  assert.ok(property, `missing ${label} for ${entityId}`);
  return property.value;
}

function vector(runtime: MechanicsRuntime, entityId: string, label: string): number[] {
  const result = value(runtime.snapshot(), entityId, label);
  assert.ok(Array.isArray(result), `${label} for ${entityId} must be a vector`);
  return result;
}

function advanceFor(runtime: MechanicsRuntime, simulatedSeconds: number, speed = 1): void {
  const target = runtime.time + simulatedSeconds;
  while (runtime.time < target - 1e-10) {
    const result = runtime.advance(Math.min(0.01, (target - runtime.time) / speed), speed);
    assert.equal(result.pauseReason, null);
    assert.ok(result.steps > 0);
  }
}

function near(actual: number, expected: number, tolerance: number, label: string): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${actual}`);
}

test('the default ground is rendered and inspectable; ground:null allows free flight', async () => {
  const defaultScene = contactScene([sphere('probe', [0, 0, 0.12], [0, 0, 0])], [0, 0, -9.81]);
  assert.equal(defaultScene.ground?.height, 0);
  assert.equal(defaultScene.ground?.restitution, 1);
  const grounded = await createRuntime(defaultScene);
  try {
    assert.equal(grounded.scene.ground, null);
    const renderedGround = grounded.frame().find(item => item.entityId === 'world-ground');
    assert.ok(renderedGround, 'expanded ground must be rendered');
    assert.equal(renderedGround.label, 'Ground');
    assert.equal(renderedGround.shape.kind, 'plane');
    const inspectedGround = grounded.snapshot().entities.find(item => item.id === 'world-ground');
    assert.ok(inspectedGround, 'expanded ground must be available in inspection');
    assert.equal(inspectedGround.label, 'Ground');
    assert.equal(value(grounded.snapshot(), 'world-ground', 'Shape'), 'plane');
    near(vector(grounded, 'world-ground', 'Position')[2], 0, 1e-8, 'ground height');
    advanceFor(grounded, 0.2);
    near(vector(grounded, 'probe', 'Position')[2], 0.1, 0.015, 'resting sphere height');
    assert.ok(Math.abs(vector(grounded, 'probe', 'Velocity')[2]) < 0.12, 'resting sphere should settle');
    near(vector(grounded, 'probe', 'Contact force')[2], 9.81, 0.08, 'ground supports the sphere weight');
    near(vector(grounded, 'world-ground', 'Contact force')[2], -9.81, 0.08, 'equal and opposite ground reaction');
  } finally {
    grounded.dispose();
  }

  const free = await createRuntime(contactScene([sphere('free', [0, 0, 0.15], [0, 0, -1])], [0, 0, 0], null));
  try {
    assert.equal(free.scene.ground, null);
    assert.equal(free.frame().some(item => item.entityId === 'world-ground'), false);
    assert.equal(free.snapshot().entities.some(item => item.id === 'world-ground'), false);
    advanceFor(free, 0.3);
    near(vector(free, 'free', 'Position')[2], -0.15, 0.003, 'ungrounded free-flight height');
    near(vector(free, 'free', 'Velocity')[2], -1, 1e-8, 'ungrounded free-flight speed');
  } finally {
    free.dispose();
  }
});

test('default-ground balls with e=1 and e=0 share the same fall, then rebound versus settle', async () => {
  const runtime = await createRuntime(contactScene([
    sphere('elastic', [-1, 0, 1.5], [0, 0, 0], { restitution: 1 }),
    sphere('inelastic', [1, 0, 1.5], [0, 0, 0], { restitution: 0 }),
  ], [0, 0, -9.81]));
  try {
    advanceFor(runtime, 0.35);
    const before = runtime.snapshot();
    const elasticFallSpeed = (value(before, 'elastic', 'Velocity') as number[])[2];
    const inelasticFallSpeed = (value(before, 'inelastic', 'Velocity') as number[])[2];
    assert.ok(elasticFallSpeed < 0 && inelasticFallSpeed < 0);
    near(elasticFallSpeed, inelasticFallSpeed, 0.01, 'equal pre-impact fall speeds');

    advanceFor(runtime, 0.45);
    const after = runtime.snapshot();
    const elasticHeight = (value(after, 'elastic', 'Position') as number[])[2];
    const elasticVerticalSpeed = (value(after, 'elastic', 'Velocity') as number[])[2];
    const inelasticHeight = (value(after, 'inelastic', 'Position') as number[])[2];
    const inelasticVerticalSpeed = (value(after, 'inelastic', 'Velocity') as number[])[2];
    assert.ok(elasticHeight > 0.3 && elasticVerticalSpeed > 0.2, 'the e=1 ball should be in its first upward rebound');
    near(inelasticHeight, 0.1, 0.02, 'e=0 resting height after settling');
    assert.ok(Math.abs(inelasticVerticalSpeed) < 0.12, 'the e=0 ball should have settled');
  } finally {
    runtime.dispose();
  }
});

test('sphere-plane restitution follows the lower pair coefficient at a selected impact speed', async () => {
  for (const [coefficient, tolerance] of [[0, 0.015], [0.5, 0.04], [1, 0.01]] as const) {
    const runtime = await createRuntime(contactScene([
      sphere('ball', [0, 0, 0.22], [0, 0, -1.5], { restitution: 1 }),
    ], [0, 0, 0], ground(coefficient)));
    try {
      advanceFor(runtime, 0.04);
      const incomingSpeed = -vector(runtime, 'ball', 'Velocity')[2];
      near(incomingSpeed, 1.5, 0.002, `pre-impact speed for e=${coefficient}`);
      advanceFor(runtime, 0.2);
      const reboundSpeed = vector(runtime, 'ball', 'Velocity')[2];
      const observed = reboundSpeed / incomingSpeed;
      near(observed, coefficient, tolerance, `measured pair restitution for sphere e=1 / ground e=${coefficient}`);
    } finally {
      runtime.dispose();
    }
  }
});

test('an isolated unequal-mass elastic sphere collision preserves momentum and kinetic energy', async () => {
  const runtime = await createRuntime(contactScene([
    sphere('light', [-0.5, 0, 0.5], [2, 0, 0], { mass: 1, restitution: 1 }),
    sphere('heavy', [0.5, 0, 0.5], [0, 0, 0], { mass: 3, restitution: 1 }),
  ], [0, 0, 0], null));
  try {
    advanceFor(runtime, 0.35);
    const before = runtime.snapshot();
    const lightBefore = (value(before, 'light', 'Velocity') as number[])[0];
    const heavyBefore = (value(before, 'heavy', 'Velocity') as number[])[0];
    advanceFor(runtime, 0.2);
    const after = runtime.snapshot();
    const lightAfter = (value(after, 'light', 'Velocity') as number[])[0];
    const heavyAfter = (value(after, 'heavy', 'Velocity') as number[])[0];
    const momentumBefore = lightBefore + 3 * heavyBefore;
    const momentumAfter = lightAfter + 3 * heavyAfter;
    const energyBefore = 0.5 * (lightBefore ** 2 + 3 * heavyBefore ** 2);
    const energyAfter = 0.5 * (lightAfter ** 2 + 3 * heavyAfter ** 2);
    near(momentumAfter, momentumBefore, 0.02, 'collision momentum');
    near(energyAfter, energyBefore, 0.08, 'elastic collision kinetic energy');
    near(lightAfter, -1, 0.08, 'light-sphere post-impact velocity');
    near(heavyAfter, 1, 0.04, 'heavy-sphere post-impact velocity');
  } finally {
    runtime.dispose();
  }
});

test('sliding friction removes horizontal momentum at approximately mu*g while a frictionless sphere coasts', async () => {
  const makeRunner = (sliding: number) => contactScene([
    sphere('runner', [0, 0, 0.1], [2, 0, 0], { restitution: 0, friction: friction(sliding) }),
  ], [0, 0, -9.81], ground(0));
  const withoutFriction = await createRuntime(makeRunner(0));
  try {
    advanceFor(withoutFriction, 0.04);
    assert.ok(vector(withoutFriction, 'runner', 'Velocity')[0] > 1.98, 'frictionless horizontal speed should remain nearly constant');
  } finally {
    withoutFriction.dispose();
  }

  const withFriction = await createRuntime(makeRunner(0.5));
  try {
    advanceFor(withFriction, 0.04);
    const speed = vector(withFriction, 'runner', 'Velocity')[0];
    const measuredDeceleration = (2 - speed) / 0.04;
    near(measuredDeceleration, 0.5 * 9.81, 0.3, 'early sliding deceleration before the sphere rolls');
  } finally {
    withFriction.dispose();
  }
});

test('static friction holds a sub-threshold load while kinetic friction slows a moving body', async () => {
  const surfaceFriction = friction(0.2, 0.8);
  const held = await createRuntime(contactScene([
    { ...sphere('held', [0, 0, 0.1], [0, 0, 0], { mass: 1, friction: surfaceFriction }), shape: { kind: 'box', size: [1, 1, 0.2] } },
  ], [0, 0, -9.81], ground(0), [
    { kind: 'force', bodyId: 'held', vector: [4, 0, 0], point: null },
  ]));
  try {
    advanceFor(held, 0.2);
    near(vector(held, 'held', 'Position')[0], 0, 0.001, 'statically held horizontal position');
    assert.ok(Math.abs(vector(held, 'held', 'Velocity')[0]) < 0.005, 'static friction should balance the sub-threshold force');
  } finally {
    held.dispose();
  }

  const moving = await createRuntime(contactScene([
    sphere('moving', [0, 0, 0.1], [1, 0, 0], { mass: 1, friction: surfaceFriction }),
  ], [0, 0, -9.81], ground(0)));
  try {
    advanceFor(moving, 0.03);
    const speed = vector(moving, 'moving', 'Velocity')[0];
    near((1 - speed) / 0.03, 0.2 * 9.81, 0.9, 'early kinetic deceleration before rolling');
  } finally {
    moving.dispose();
  }
});

test('a tangentially sliding e=1 impact still rebounds while friction reduces tangential speed', async () => {
  const runtime = await createRuntime(contactScene([
    sphere('glancing', [0, 0, 0.15], [1, 0, -1], { restitution: 1, friction: friction(0.8) }),
  ], [0, 0, 0], ground(1)));
  try {
    advanceFor(runtime, 0.03);
    const incoming = vector(runtime, 'glancing', 'Velocity');
    advanceFor(runtime, 0.2);
    const outgoing = vector(runtime, 'glancing', 'Velocity');
    assert.ok(outgoing[2] > 0.8, 'normal rebound should preserve e=1');
    assert.ok(outgoing[0] < incoming[0] - 0.2, 'tangential contact friction should reduce horizontal speed');
  } finally {
    runtime.dispose();
  }
});

test('contact trajectories do not change with playback speed or publication cadence', async () => {
  const scene = contactScene([
    sphere('ball', [0, 0, 1.1], [1, 0, -1], { restitution: 0.5, friction: friction(0.3, 0.5) }),
  ], [0, 0, -9.81]);
  const results: { position: number[]; velocity: number[]; angular: number[] }[] = [];
  for (const speed of [0.1, 1, 10]) {
    const runtime = await createRuntime(scene);
    try {
      advanceFor(runtime, 0.6, speed);
      results.push({
        position: vector(runtime, 'ball', 'Position'),
        velocity: vector(runtime, 'ball', 'Velocity'),
        angular: vector(runtime, 'ball', 'Angular velocity'),
      });
    } finally {
      runtime.dispose();
    }
  }
  for (const result of results.slice(1)) for (const quantity of ['position', 'velocity', 'angular'] as const) {
    result[quantity].forEach((component, axis) => near(component, results[0][quantity][axis], 1e-5, `${quantity} axis ${axis}`));
  }
});
