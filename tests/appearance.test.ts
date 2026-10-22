import assert from 'node:assert/strict';
import test from 'node:test';
import { AssemblyDecisionSchema } from '../shared/assembly-input.ts';
import { AppearanceSchema } from '../shared/appearance.ts';
import { validateSavedScene } from '../shared/saved-scene.ts';
import { DecisionSchema, validateScene } from '../shared/scene.ts';
import { createRuntime } from '../src/physics/mujoco.ts';
import { projectile } from './fixtures.ts';

test('appearance rejects unknown presets, external assets and invalid guide values', () => {
  for (const appearance of [
    { surface: 'wood', sky: 'day', textured: true },
    { surface: 'ice', sky: 'rain', textured: true },
    { surface: 'stone', sky: 'day', textured: true, imageUrl: 'https://example.invalid/texture.png' },
    { surface: 'ice', sky: 'day', textured: true, grid: 'hidden' },
  ]) assert.equal(AppearanceSchema.safeParse(appearance).success, false);
});

test('grid defaults off across authoring and saved scenes while explicit saved choices take precedence', () => {
  const scene = projectile();
  const decision = {
    kind: 'scene', summary: 'You can inspect the moving sphere.', assumptions: ['The visual surface is assumed concrete.'],
    question: null, reason: null, approximation: null, alternative: null,
    scene: { ...scene, appearance: { surface: 'rubber', sky: 'overcast', textured: false } },
  };
  assert.equal(AppearanceSchema.parse(undefined).grid, false);
  assert.equal(AssemblyDecisionSchema.options[0].parse(decision).scene.appearance.grid, false);
  assert.equal(DecisionSchema.options[0].parse(decision).scene.appearance.grid, false);
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
  assert.equal(saved.document.decision.scene.appearance.grid, false);
  assert.equal(saved.document.scene.appearance.grid, false);

  const current = validateScene({ ...scene, appearance: { surface: 'asphalt', sky: 'sunset', textured: false, grid: true } });
  const updated = validateSavedScene({
    id: '22222222-2222-4222-8222-222222222222', createdAt: '2026-10-01T12:00:00.000Z',
    lastRunAt: null, expiresAt: '2026-10-02T12:00:00.000Z',
    document: { prompt: 'A sphere moving without a ground plane.', decision: { ...decision, scene: current }, scene: current, userGroundChoice: 'none' },
  });
  assert.equal(updated.document.scene.appearance.grid, true);
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
