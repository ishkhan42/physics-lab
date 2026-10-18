import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { validateScene } from '../shared/scene.ts';
import { validateSavedScene, validateSceneDocument } from '../shared/saved-scene.ts';
import { projectile } from './fixtures.ts';

function document() {
  const scene = projectile();
  return {
    prompt: 'A sphere moving without a ground plane.',
    decision: { kind: 'scene', summary: 'A freely moving sphere.', assumptions: [], question: null, reason: null, scene },
    scene: validateScene({ ...scene, ground: undefined }),
    userGroundChoice: 'default',
  };
}

test('saved documents preserve the actual ground choice separately from the original model suggestion', () => {
  const input = document();
  const before = JSON.stringify(input);
  const parsed = validateSceneDocument(input);
  assert.equal(parsed.decision.scene.ground, null);
  assert.equal(parsed.scene.ground?.height, 0);
  assert.equal(parsed.scene.ground?.restitution, 1);
  assert.equal(parsed.prompt, input.prompt);
  assert.equal(parsed.userGroundChoice, 'default');
  assert.equal(JSON.stringify(input), before);
  const withoutGround = validateSceneDocument({ ...input, scene: projectile(), userGroundChoice: 'none' });
  assert.equal(withoutGround.scene.ground, null);
});

test('neither invalid original physics nor invalid actual physics can enter a saved scene', () => {
  const invalid = projectile();
  invalid.bodies[0].mass = null;
  const input = document();
  assert.throws(() => validateSceneDocument({ ...input, scene: invalid }), z.ZodError);
  assert.throws(() => validateSceneDocument({ ...input, decision: { ...input.decision, scene: invalid } }), z.ZodError);
  assert.throws(() => validateSceneDocument({ ...input, userGroundChoice: 'none' }), z.ZodError);
  assert.throws(() => validateSceneDocument({ ...input, scene: projectile() }), z.ZodError);
  assert.throws(() => validateSceneDocument({ ...input, decision: { ...input.decision, kind: 'clarify', scene: null, question: 'Which direction?' } }), z.ZodError);
  assert.throws(() => validateSceneDocument({ ...input, providerSettings: { privateValue: 'must-not-be-stored' } }), z.ZodError);
});

test('saved records validate their link and server timestamps as well as their definition', () => {
  const record = {
    id: '11111111-1111-4111-8111-111111111111',
    createdAt: '2026-10-01T12:00:00.000Z',
    lastRunAt: null,
    expiresAt: '2026-10-02T12:00:00.000Z',
    document: document(),
  };
  assert.equal(validateSavedScene(record).lastRunAt, null);
  assert.throws(() => validateSavedScene({ ...record, id: '../private' }), z.ZodError);
  assert.throws(() => validateSavedScene({ ...record, expiresAt: 'tomorrow' }), z.ZodError);
  assert.throws(() => validateSavedScene({ ...record, document: { ...record.document, prompt: 'x'.repeat(16001) } }), z.ZodError);
});
