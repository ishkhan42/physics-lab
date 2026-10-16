import assert from 'node:assert/strict';
import test from 'node:test';
import { validateScene } from '../shared/scene.ts';
import { createRuntime } from '../src/physics/mujoco.ts';

const identity = [1, 0, 0, 0] as const;

function fixedBody(id: string, position: number[], shape: unknown) {
  return { id, label: `${id} & <frame> "quoted"`, parentId: null, position, shape, mass: null, motion: { kind: 'fixed' }, color: '#67d9ce' };
}

test('compiles every native primitive and safely escapes model and object labels', async () => {
  const primitives = [
    ['sphere', { kind: 'sphere', radius: 0.1 }],
    ['box', { kind: 'box', size: [0.2, 0.3, 0.4] }],
    ['cylinder', { kind: 'cylinder', radius: 0.1, length: 0.5 }],
    ['capsule', { kind: 'capsule', radius: 0.1, length: 0.5 }],
    ['ellipsoid', { kind: 'ellipsoid', radii: [0.1, 0.2, 0.3] }],
    ['plane', { kind: 'plane', size: [2, 3] }],
    ['marker', { kind: 'point' }],
  ] as const;
  const scene = validateScene({
    category: 'mechanics', title: 'Primitives & <trusted> "MJCF"', gravity: [0, 0, 0], ground: null,
    bodies: primitives.map(([id, shape], index) => fixedBody(id, [index * 3, 0, 0], shape)),
    sites: [], tendons: [], connections: [], loads: [],
  });
  const runtime = await createRuntime(scene);
  try {
    const frame = runtime.frame();
    assert.equal(frame.length, primitives.length);
    for (let index = 0; index < primitives.length; index++) {
      const [id, shape] = primitives[index];
      const item = frame.find(candidate => candidate.entityId === id)!;
      assert.deepEqual(item.shape, shape);
      assert.deepEqual(item.position, [index * 3, 0, 0]);
    }
    assert.equal(runtime.snapshot().entities.length, primitives.length);
  } finally {
    runtime.dispose();
  }
});

test('maps nested body frames and nonzero hinge reference coordinates into native poses', async () => {
  const half = Math.SQRT1_2;
  const quarterTurn = [half, 0, 0, half];
  const scene = validateScene({
    category: 'mechanics', title: 'Nested reference frames', gravity: [0, 0, 0], ground: null,
    bodies: [
      { id: 'support', label: 'Support', parentId: null, position: [2, 0, 0], orientation: quarterTurn, shape: { kind: 'box', size: [0.2, 0.2, 0.2] }, mass: null, motion: { kind: 'fixed' }, color: '#9cabb5' },
      { id: 'arm', label: 'Hinged cylinder', parentId: 'support', position: [2, 1, 0], orientation: quarterTurn, shape: { kind: 'cylinder', radius: 0.1, length: 2 }, mass: 2,
        motion: { kind: 'hinge', axis: [0, 0, 1], anchor: [2, 2, 0], position: Math.PI / 2, velocity: 0, limits: null, stiffness: 0, damping: 0, springReference: 0 }, color: '#67d9ce' },
    ],
    sites: [], tendons: [], connections: [], loads: [],
  });
  const runtime = await createRuntime(scene);
  try {
    const arm = runtime.frame().find(item => item.entityId === 'arm')!;
    assert.ok(Math.abs(arm.position[0] - 3) < 1e-8);
    assert.ok(Math.abs(arm.position[1] - 2) < 1e-8);
    assert.ok(Math.abs(arm.position[2]) < 1e-8);
    assert.ok(Math.abs(arm.quaternion[2] - 1) < 1e-8);
    assert.ok(Math.abs(arm.quaternion[3]) < 1e-8);
    assert.deepEqual(arm.shape, { kind: 'cylinder', radius: 0.1, length: 2 });
  } finally {
    runtime.dispose();
  }
});

test('compiles connect, weld, and scalar coupling constraints in their declared frames', async () => {
  const freeBody = (id: string, position: number[]) => ({
    id, label: id, parentId: null, position, orientation: identity, shape: { kind: 'sphere', radius: 0.1 }, mass: 1,
    motion: { kind: 'free', linearVelocity: [0, 0, 0], angularVelocity: [0, 0, 0] }, color: '#67d9ce',
  });
  const hingeBody = (id: string, position: number[], coordinate: number) => ({
    id, label: id, parentId: null, position, orientation: identity, shape: { kind: 'sphere', radius: 0.1 }, mass: 1,
    motion: { kind: 'hinge', axis: [0, 0, 1], anchor: position, position: coordinate, velocity: 0, limits: null, stiffness: 0, damping: 0, springReference: 0 }, color: '#f2c178',
  });
  const scene = validateScene({
    category: 'mechanics', title: 'Native equality connections', gravity: [0, 0, 0], ground: null,
    bodies: [freeBody('connect_a', [0, 0, 0]), freeBody('connect_b', [2, 0, 0]), freeBody('weld_a', [5, 0, 0]), freeBody('weld_b', [7, 0, 0]),
      hingeBody('axis_a', [10, 0, 0], 0.2), hingeBody('axis_b', [12, 0, 0], 0.4)],
    sites: [], tendons: [],
    connections: [
      { kind: 'connect', id: 'pin', label: 'World anchor', bodyA: 'connect_a', bodyB: 'connect_b', anchor: [1, 0, 0] },
      { kind: 'weld', id: 'weld', label: 'Rigid equality', bodyA: 'weld_a', bodyB: 'weld_b' },
      { kind: 'coupling', id: 'ratio', label: 'Scalar relation', bodyA: 'axis_a', bodyB: 'axis_b', ratio: 2, offset: 0 },
    ],
    loads: [],
  });
  const runtime = await createRuntime(scene);
  try {
    const pin = runtime.frame().find(item => item.entityId === 'pin')!;
    assert.equal(pin.shape.kind, 'line');
    assert.deepEqual(pin.points?.[0], [1, 0, 0]);
    assert.deepEqual(pin.points?.[1], [1, 0, 0]);
    const entities = runtime.snapshot().entities.filter(entity => entity.kind === 'connection');
    assert.deepEqual(entities.map(entity => entity.id), ['pin', 'weld', 'ratio']);
  } finally {
    runtime.dispose();
  }
});
test('compiles a spherical wrap and pulley branch as a native spatial tendon', async () => {
  const scene = validateScene({
    category: 'mechanics', title: 'Wrapped spring cable', gravity: [0, 0, 0], ground: null,
    bodies: [fixedBody('guide', [0, 0, 0], { kind: 'sphere', radius: 0.5 })],
    sites: [
      { id: 'start', label: 'Start', bodyId: null, position: [-1, 0, 0] },
      { id: 'wrap_exit', label: 'Wrap exit', bodyId: null, position: [1, 0, 0] },
      { id: 'branch_start', label: 'Branch start', bodyId: null, position: [-1, 0, 2] },
      { id: 'end', label: 'End', bodyId: null, position: [1, 0, 2] },
    ],
    tendons: [
      { id: 'spring_cable', label: 'Wrapped spring', mode: 'spring', length: 3, stiffness: 10, damping: 1,
        path: [{ kind: 'site', siteId: 'start' }, { kind: 'wrap', bodyId: 'guide' }, { kind: 'site', siteId: 'wrap_exit' },
          { kind: 'pulley', divisor: 2 }, { kind: 'site', siteId: 'branch_start' }, { kind: 'site', siteId: 'end' }] },
      { id: 'loose_rope', label: 'Slack cable', mode: 'rope', length: 100,
        path: [{ kind: 'site', siteId: 'start' }, { kind: 'site', siteId: 'end' }] },
    ],
    connections: [], loads: [],
  });
  const runtime = await createRuntime(scene);
  try {
    const branches = runtime.frame().filter(item => item.entityId === 'spring_cable');
    assert.equal(branches.length, 2);
    assert.ok((branches[0].points?.length ?? 0) >= 4);
    assert.equal(branches[1].points?.length, 2);
    const snapshot = runtime.snapshot();
    const springForce = snapshot.entities.find(entity => entity.id === 'spring_cable')!.properties.find(property => property.label === 'Axial force')!.value;
    const ropeLimit = snapshot.entities.find(entity => entity.id === 'loose_rope')!.properties.find(property => property.label === 'Maximum length')!.value;
    assert.ok(typeof springForce === 'number' && Number.isFinite(springForce));
    assert.equal(ropeLimit, 100);
  } finally {
    runtime.dispose();
  }
});
