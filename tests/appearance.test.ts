import assert from 'node:assert/strict';
import test from 'node:test';
import { AssemblyDecisionSchema } from '../shared/assembly-input.ts';
import { AppearanceSchema, DEFAULT_APPEARANCE } from '../shared/appearance.ts';
import { validateSavedScene } from '../shared/saved-scene.ts';
import { DecisionSchema, validateScene } from '../shared/scene.ts';
import { createRuntime } from '../src/physics/mujoco.ts';
import { projectile } from './fixtures.ts';

test('appearance offers only curated cosmetic choices and defaults omitted values', () => {
  assert.deepEqual(AppearanceSchema.parse(undefined), DEFAULT_APPEARANCE);
  assert.deepEqual(AppearanceSchema.parse({ surface: 'plain', sky: 'sunset', textured: false }), {
    surface: 'plain', sky: 'sunset', textured: false, grid: true,
  });
  for (const appearance of [
    { surface: 'wood', sky: 'day', textured: true },
    { surface: 'ice', sky: 'rain', textured: true },
    { surface: 'stone', sky: 'day', textured: true, imageUrl: 'https://example.invalid/texture.png' },
    { surface: 'ice', sky: 'day', textured: true, grid: 'hidden' },
  ]) assert.equal(AppearanceSchema.safeParse(appearance).success, false);
});

test('typed scene tools author appearance and old persisted scenes restore with the default', () => {
  const scene = projectile();
  const decision = {
    kind: 'scene', summary: 'You can inspect the moving sphere.', assumptions: ['The visual surface is assumed concrete.'],
    question: null, reason: null, approximation: null, alternative: null,
    scene: { ...scene, appearance: { surface: 'rubber', sky: 'overcast', textured: false } },
  };
  assert.deepEqual(AssemblyDecisionSchema.options[0].parse(decision).scene.appearance, {
    surface: 'rubber', sky: 'overcast', textured: false, grid: true,
  });
  assert.deepEqual(DecisionSchema.options[0].parse(decision).scene.appearance, {
    surface: 'rubber', sky: 'overcast', textured: false, grid: true,
  });
  const omitted = { ...scene };
  Reflect.deleteProperty(omitted, 'appearance');
  assert.deepEqual(AssemblyDecisionSchema.options[0].parse({ ...decision, scene: omitted }).scene.appearance, DEFAULT_APPEARANCE);
  assert.equal(AssemblyDecisionSchema.safeParse({
    ...decision, scene: { ...scene, appearance: { surface: 'marble', sky: 'studio', textured: true } },
  }).success, false);

  const oldScene = structuredClone(scene);
  Reflect.deleteProperty(oldScene, 'appearance');
  const saved = validateSavedScene({
    id: '11111111-1111-4111-8111-111111111111', createdAt: '2026-10-01T12:00:00.000Z',
    lastRunAt: null, expiresAt: '2026-10-02T12:00:00.000Z',
    document: {
      prompt: 'A sphere moving without a ground plane.',
      decision: { ...decision, scene: oldScene }, scene: oldScene, userGroundChoice: 'none',
    },
  });
  assert.deepEqual(saved.document.decision.scene.appearance, DEFAULT_APPEARANCE);
  assert.deepEqual(saved.document.scene.appearance, DEFAULT_APPEARANCE);

  const current = validateScene({ ...scene, appearance: { surface: 'asphalt', sky: 'sunset', textured: false, grid: false } });
  const updated = validateSavedScene({
    id: '22222222-2222-4222-8222-222222222222', createdAt: '2026-10-01T12:00:00.000Z',
    lastRunAt: null, expiresAt: '2026-10-02T12:00:00.000Z',
    document: { prompt: 'A sphere moving without a ground plane.', decision: { ...decision, scene: current }, scene: current, userGroundChoice: 'none' },
  });
  assert.deepEqual(updated.document.scene.appearance, { surface: 'asphalt', sky: 'sunset', textured: false, grid: false });
});

test('changing appearance leaves native physics behavior unchanged', async () => {
  const physical = projectile();
  const styled = validateScene({ ...physical, appearance: { surface: 'ice', sky: 'sunset', textured: false, grid: false } });
  const plainRuntime = await createRuntime(physical);
  const styledRuntime = await createRuntime(styled);
  try {
    assert.deepEqual(styledRuntime.snapshot(), plainRuntime.snapshot());
    plainRuntime.advance(0.1, 1);
    styledRuntime.advance(0.1, 1);
    assert.deepEqual(styledRuntime.snapshot(), plainRuntime.snapshot());
  } finally {
    styledRuntime.dispose();
    plainRuntime.dispose();
  }
});
