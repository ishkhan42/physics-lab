import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRuntime } from '../src/physics/mujoco.ts';
import { advanceNativeCheckTo } from '../src/physics/native-check.ts';
import { validateScene } from '../shared/scene.ts';

const deadline = setTimeout(() => { console.error('Worker self-check exceeded two minutes.'); process.exit(1); }, 120_000);
deadline.unref();
try {
  const status = readFileSync('/proc/self/status', 'utf8');
  assert.equal(process.getuid?.(), 10001);
  for (const field of ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']) assert.match(status, new RegExp(`^${field}:\\s+0+$`, 'm'));
  assert.match(status, /^NoNewPrivs:\s+1$/m);
  assert.equal(process.env.OPENROUTER_API_KEY, undefined);
  assert.equal(process.env.WORKER_AUTH_TOKEN, undefined);
  assert.throws(() => writeFileSync('/lab/check-write', 'x'), { code: 'EROFS' });
  // shortcut: this deployment check targets COS cgroup v2; add v1 paths before deploying another host.
  assert.ok(BigInt(readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim()) <= 1024n ** 3n);
  assert.ok(Number(readFileSync('/sys/fs/cgroup/pids.max', 'utf8').trim()) <= 128);
  const [quota, period] = readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim().split(/\s+/).map(Number);
  assert.ok(Number.isFinite(quota) && quota > 0 && period > 0 && quota <= period);
  const mounts = readFileSync('/proc/self/mountinfo', 'utf8').split('\n');
  const scratch = mounts.find(line => line.split(' ')[4] === '/tmp')?.split(' ')[5]?.split(',');
  assert.ok(scratch?.includes('noexec') && scratch.includes('nosuid'));
  for (const target of ['https://example.com', 'http://169.254.169.254/computeMetadata/v1/']) {
    let denied = false;
    try { await fetch(target, { signal: AbortSignal.timeout(1500) }); } catch { denied = true; }
    assert.equal(denied, true);
  }
  const scene = validateScene({ category: 'mechanics', title: 'Worker projectile check', gravity: [0, 0, -9.81],
    bodies: [{ id: 'ball', label: 'Projectile', position: [0, 0, 20], shape: { kind: 'sphere', radius: 0.1 }, mass: 2,
      motion: { kind: 'free', linearVelocity: [5, 0, 0], angularVelocity: [0, 0, 0] } }], sites: [], tendons: [], connections: [], loads: [] });
  const nativeStarted = performance.now();
  const runtime = await createRuntime(scene);
  try {
    await advanceNativeCheckTo(runtime, 1, performance.now() + 60_000, 1, () => {}, () => {});
    const position = runtime.snapshot().entities.find(entity => entity.id === 'ball')?.properties.find(property => property.label === 'Position')?.value;
    assert.ok(Array.isArray(position));
    assert.ok(Math.abs(position[0]! - 5) < 1e-8 && Math.abs(position[2]! - 15.095) < 0.006);
  } finally { runtime.dispose(); }
  console.log(JSON.stringify({ checked: true, nativeMs: performance.now() - nativeStarted }));
} finally { clearTimeout(deadline); }
