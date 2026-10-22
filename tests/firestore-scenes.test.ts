import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Firestore } from '@google-cloud/firestore';
import { InvalidSceneDocumentError } from '../server/scenes.ts';
import { FirestoreSceneStore } from '../server/firestore-scenes.ts';
import { SCENE_RETENTION_MS, validateSceneDocument } from '../shared/saved-scene.ts';
import type { SceneDocument } from '../shared/saved-scene.ts';
import { atwood } from './fixtures.ts';

const emulatorAvailable = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

function testProjectId(): string {
  return `pl-${randomUUID().replaceAll('-', '').slice(0, 22)}`;
}

function validDocument(): SceneDocument {
  const scene = atwood();
  const sourceScene = {
    ...scene,
    ground: { height: 0, restitution: 1, friction: { sliding: 0, torsional: 0, rolling: 0, static: null } },
  };
  return validateSceneDocument({
    prompt: 'Compare the motion of two masses.',
    decision: {
      kind: 'scene',
      summary: 'An ideal Atwood machine.',
      assumptions: [],
      question: null,
      reason: null,
      scene: sourceScene,
      approximation: null,
      alternative: null,
    },
    scene,
    userGroundChoice: 'none',
  });
}

function largeDocument(): SceneDocument {
  const document = validDocument();
  const scene = {
    ...document.scene,
    sites: [...document.scene.sites, ...Array.from({ length: 512 - document.scene.sites.length }, (_, index) => ({
      id: `site_${index}`,
      label: 'x'.repeat(100),
      bodyId: null,
      position: [index, 0, 0] as [number, number, number],
    }))],
  };
  return validateSceneDocument({ ...document, scene, decision: { ...document.decision, scene } });
}

test('Firestore scenes persist large validated JSON across store reopen', { skip: !emulatorAvailable }, async t => {
  const projectId = testProjectId();
  const clock = { value: Date.parse('2026-10-01T12:00:00.000Z') };
  const first = new FirestoreSceneStore({ projectId, now: () => clock.value });
  t.after(() => first.close());
  await first.initialize();

  const document = largeDocument();
  assert.ok(Buffer.byteLength(JSON.stringify(document)) > 64 * 1024);
  const saved = await first.create(document);
  assert.equal(saved.createdAt, new Date(clock.value).toISOString());
  assert.equal(saved.lastRunAt, null);
  assert.equal(saved.expiresAt, new Date(clock.value + SCENE_RETENTION_MS).toISOString());
  assert.equal(saved.document.scene.sites.length, 512);
  await first.close();

  const reopened = new FirestoreSceneStore({ projectId, now: () => clock.value });
  t.after(() => reopened.close());
  await reopened.initialize();
  assert.deepEqual(await reopened.get(saved.id), saved);
});

test('reads do not renew expiry and transactional runs preserve unrelated fields', { skip: !emulatorAvailable }, async t => {
  const projectId = testProjectId();
  const clock = { value: Date.parse('2026-10-02T12:00:00.000Z') };
  const store = new FirestoreSceneStore({ projectId, now: () => clock.value });
  const raw = new Firestore({ projectId });
  t.after(() => store.close());
  t.after(() => raw.terminate());
  const saved = await store.create(validDocument());
  const reference = raw.collection('scenes').doc(saved.id);
  const unrelated = { source: 'emulator test', values: [1, 2, 3] };
  await reference.update({ unrelated });

  clock.value += 12 * 60 * 60 * 1000;
  assert.deepEqual(await store.get(saved.id), saved);
  const untouched = await reference.get();
  assert.equal(untouched.get('expiresAt'), saved.expiresAt);
  assert.equal(untouched.get('lastRunAt'), null);

  clock.value += 11 * 60 * 60 * 1000;
  const runAt = clock.value;
  const renewed = await store.run(saved.id);
  assert.deepEqual(renewed, {
    id: saved.id,
    createdAt: saved.createdAt,
    lastRunAt: new Date(runAt).toISOString(),
    expiresAt: new Date(runAt + SCENE_RETENTION_MS).toISOString(),
  });
  const persisted = await reference.get();
  assert.deepEqual(persisted.get('unrelated'), unrelated);
  const afterRun = await store.get(saved.id);
  assert.ok(afterRun);
  assert.equal(afterRun.createdAt, saved.createdAt);
  assert.equal(afterRun.expiresAt, renewed?.expiresAt);
  assert.deepEqual(afterRun.document, saved.document);
});

test('expiry is exclusive and an expired scene cannot be revived by run', { skip: !emulatorAvailable }, async t => {
  const clock = { value: Date.parse('2026-10-03T12:00:00.000Z') };
  const store = new FirestoreSceneStore({ projectId: testProjectId(), now: () => clock.value });
  t.after(() => store.close());
  const saved = await store.create(validDocument());

  clock.value += SCENE_RETENTION_MS - 1;
  assert.deepEqual(await store.get(saved.id), saved);
  clock.value += 1;
  assert.equal(await store.get(saved.id), null);
  assert.equal(await store.run(saved.id), null);
  clock.value += SCENE_RETENTION_MS;
  assert.equal(await store.run(saved.id), null);
  assert.equal(await store.get(saved.id), null);
});

test('cleanup cannot delete a scene after a concurrent transaction renews it', { skip: !emulatorAvailable }, async t => {
  const projectId = testProjectId();
  const createdAt = Date.parse('2026-10-04T12:00:00.000Z');
  const creator = new FirestoreSceneStore({ projectId, now: () => createdAt });
  t.after(() => creator.close());
  const saved = await creator.create(validDocument());
  const expiry = createdAt + SCENE_RETENTION_MS;
  const runnerClock = { value: expiry - 1 };
  const runner = new FirestoreSceneStore({ projectId, now: () => runnerClock.value });
  const cleaner = new FirestoreSceneStore({ projectId, now: () => expiry });
  t.after(() => runner.close());
  t.after(() => cleaner.close());

  const [renewed] = await Promise.all([runner.run(saved.id), cleaner.cleanupExpired()]);
  const persisted = await runner.get(saved.id);
  if (renewed) {
    assert.ok(persisted);
    assert.equal(persisted.expiresAt, new Date(runnerClock.value + SCENE_RETENTION_MS).toISOString());
  } else {
    assert.equal(persisted, null);
  }
});

test('invalid IDs, corrupt persisted JSON, and invalid clocks are rejected safely', { skip: !emulatorAvailable }, async t => {
  const projectId = testProjectId();
  const clock = { value: Date.parse('2026-10-05T12:00:00.000Z') };
  const store = new FirestoreSceneStore({ projectId, now: () => clock.value });
  const raw = new Firestore({ projectId });
  t.after(() => store.close());
  t.after(() => raw.terminate());
  const saved = await store.create(validDocument());

  assert.equal(await store.get('not-a-uuid'), null);
  assert.equal(await store.run('not-a-uuid'), null);
  await assert.rejects(store.create({ invalid: true }), InvalidSceneDocumentError);
  await raw.collection('scenes').doc(saved.id).collection('documentChunks').doc('0').update({ value: '{' });
  await assert.rejects(store.get(saved.id), /Corrupt saved scene record/);

  const invalidClock = new FirestoreSceneStore({ projectId, now: () => Number.NaN });
  t.after(() => invalidClock.close());
  await assert.rejects(invalidClock.get(saved.id), /scene storage clock is invalid/i);
});
