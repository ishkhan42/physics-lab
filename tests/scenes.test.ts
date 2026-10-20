import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { request } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCENE_RETENTION_MS, SavedSceneMetadataSchema, SavedSceneSchema } from '../shared/saved-scene.ts';
import type { SavedScene, SceneDocument } from '../shared/saved-scene.ts';
import type { Scene } from '../shared/scene.ts';
import { createRuntime } from '../src/physics/mujoco.ts';
import { createApiServer } from '../server/index.ts';
import { atwood } from './fixtures.ts';

type HttpResult = {
  status: number;
  body: string;
  value: unknown;
  headers: IncomingHttpHeaders;
};

type RunningServer = { server: Server; port: number };

function send(port: number, method: string, path: string, body?: string | Buffer): Promise<HttpResult> {
  const { promise, resolve, reject } = Promise.withResolvers<HttpResult>();
  const headers: Record<string, string> = { host: '127.0.0.1:3001', connection: 'close' };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(body));
  }
  const client = request({ hostname: '127.0.0.1', port, method, path, agent: false, headers }, response => {
    const chunks: Buffer[] = [];
    response.on('data', chunk => chunks.push(Buffer.from(chunk)));
    response.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        value = undefined;
      }
      resolve({ status: response.statusCode ?? 0, body: text, value, headers: response.headers });
    });
  });
  client.on('error', reject);
  client.end(body);
  return promise;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  server.close(error => error ? reject(error) : resolve());
  await promise;
}

async function sandbox(t: TestContext, clock: { value: number }) {
  const directory = await mkdtemp(join(tmpdir(), 'physics-lab-scenes-'));
  const databasePath = join(directory, 'private', 'scenes.sqlite');
  const servers: Server[] = [];
  t.after(async () => {
    for (const server of servers) await closeServer(server);
    await rm(directory, { recursive: true, force: true });
  });
  return {
    databasePath,
    async start(initializeSceneStore = false): Promise<RunningServer> {
      const server = createApiServer({ sceneDbPath: databasePath, now: () => clock.value, initializeSceneStore });
      servers.push(server);
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('The test server did not bind to a TCP port.');
      return { server, port: address.port };
    },
  };
}

function validDocument(): SceneDocument {
  const scene = atwood();
  const sourceScene = {
    ...scene,
    ground: { height: 0, restitution: 1, friction: { sliding: 0, torsional: 0, rolling: 0, static: null } },
  };
  return {
    prompt: 'Compare the motion of the two masses.',
    decision: {
      kind: 'scene', summary: 'An ideal Atwood machine.', assumptions: [], question: null,
      reason: null, approximation: null, scene: sourceScene, alternative: null,
    },
    scene,
    userGroundChoice: 'none',
  };
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
  return { ...document, scene, decision: { ...document.decision, scene } };
}

function errorCode(result: HttpResult): string | undefined {
  if (!result.value || typeof result.value !== 'object' || !('error' in result.value)) return undefined;
  const error = result.value.error;
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}
function savedScene(result: HttpResult): SavedScene {
  return SavedSceneSchema.parse(result.value);
}

test('pre-schedule saved scenes still run without rewriting their stored definitions', async t => {
  const clock = { value: Date.parse('2026-01-01T00:00:00.000Z') };
  const api = await sandbox(t, clock);
  const server = await api.start();
  const document = validDocument();
  const created = savedScene(await send(server.port, 'POST', '/api/scenes', JSON.stringify(document)));
  const legacyScene = (scene: Scene) => {
    const { events: _events, ...definition } = scene;
    return { ...definition, bodies: definition.bodies.map(({ heldBy: _heldBy, ...body }) => body) };
  };
  const originalJson = JSON.stringify({
    ...document,
    scene: legacyScene(document.scene),
    decision: { ...document.decision, scene: legacyScene(document.decision.scene) },
  });
  const database = new DatabaseSync(api.databasePath);
  t.after(() => database.close());
  database.prepare('UPDATE scenes SET document = ? WHERE id = ?').run(originalJson, created.id);
  const restored = await send(server.port, 'GET', `/api/scenes/${created.id}`);
  assert.equal(restored.status, 200);
  const runtime = await createRuntime(savedScene(restored).document.scene);
  try {
    assert.equal(runtime.advance(0.1, 1).pauseReason, null);
    const velocity = runtime.snapshot().entities.find(entity => entity.id === 'light')?.properties.find(property => property.label === 'Velocity')?.value;
    assert.ok(Array.isArray(velocity));
    assert.ok(Math.abs(velocity[2] - 0.327) < 1e-8);
  } finally { runtime.dispose(); }
  clock.value += 5000;
  const renewed = await send(server.port, 'POST', `/api/scenes/${created.id}/run`, '{}');
  assert.equal(renewed.status, 200);
  const row = database.prepare('SELECT document FROM scenes WHERE id = ?').get(created.id);
  assert.equal(row?.document, originalJson);
});

test('saved scene metadata and validated documents persist privately across server restart', async t => {
  const clock = { value: Date.parse('2026-01-01T00:00:00.000Z') };
  const api = await sandbox(t, clock);
  const first = await api.start();
  const document = validDocument();
  const created = await send(first.port, 'POST', '/api/scenes', JSON.stringify(document));
  assert.equal(created.status, 201);
  assert.equal(created.headers['x-robots-tag'], 'noindex, nofollow');
  const saved = savedScene(created);
  assert.match(saved.id, /^[0-9a-f-]{36}$/i);
  assert.equal(saved.createdAt, new Date(clock.value).toISOString());
  assert.equal(saved.lastRunAt, null);
  assert.equal(saved.expiresAt, new Date(clock.value + SCENE_RETENTION_MS).toISOString());
  assert.deepEqual(saved.document, document);
  assert.equal(saved.document.scene.ground, null);
  assert.equal(saved.document.userGroundChoice, 'none');
  assert.notEqual(saved.document.decision.scene.ground, null);
  assert.equal((await stat(api.databasePath)).mode & 0o777, 0o600);
  assert.equal((await stat(join(api.databasePath, '..'))).mode & 0o777, 0o700);
  const readBack = await send(first.port, 'GET', `/api/scenes/${saved.id}`);
  assert.deepEqual(readBack.value, saved);
  assert.equal(readBack.headers['x-robots-tag'], 'noindex, nofollow');

  await closeServer(first.server);
  clock.value += 60 * 60 * 1000;
  const restarted = await api.start();
  assert.deepEqual((await send(restarted.port, 'GET', `/api/scenes/${saved.id}`)).value, saved);

  clock.value = Date.parse(saved.expiresAt);
  const sharedPage = await send(restarted.port, 'GET', `/scenes/${saved.id}`);
  assert.equal(sharedPage.status, 200);
  assert.match(sharedPage.headers['content-type'] ?? '', /^text\/html/);
  assert.equal(sharedPage.headers['x-robots-tag'], 'noindex, nofollow');
  const head = await send(restarted.port, 'HEAD', `/scenes/${saved.id}`);
  assert.equal(head.status, 200);
  assert.equal(head.headers['x-robots-tag'], 'noindex, nofollow');
  assert.equal(head.body, '');
});

test('reads do not renew expiry; run renews only metadata and keeps the saved document', async t => {
  const clock = { value: Date.parse('2026-02-01T00:00:00.000Z') };
  const api = await sandbox(t, clock);
  const { port } = await api.start();
  const created = await send(port, 'POST', '/api/scenes', JSON.stringify(validDocument()));
  const saved = savedScene(created);

  clock.value += 12 * 60 * 60 * 1000;
  const read = await send(port, 'GET', `/api/scenes/${saved.id}`);
  assert.equal(read.status, 200);
  const readScene = savedScene(read);
  assert.equal(readScene.expiresAt, saved.expiresAt);
  assert.equal(readScene.lastRunAt, null);

  clock.value += 11 * 60 * 60 * 1000;
  const run = await send(port, 'POST', `/api/scenes/${saved.id}/run`, '{}');
  assert.equal(run.status, 200);
  assert.equal(run.headers['x-robots-tag'], 'noindex, nofollow');
  const metadata = SavedSceneMetadataSchema.parse(run.value);
  assert.deepEqual(Object.keys(metadata).sort(), ['createdAt', 'expiresAt', 'id', 'lastRunAt']);
  assert.equal(metadata.id, saved.id);
  assert.equal(metadata.createdAt, saved.createdAt);
  assert.equal(metadata.lastRunAt, new Date(clock.value).toISOString());
  assert.equal(metadata.expiresAt, new Date(clock.value + SCENE_RETENTION_MS).toISOString());

  clock.value += 60 * 60 * 1000;
  const afterRun = await send(port, 'GET', `/api/scenes/${saved.id}`);
  assert.equal(afterRun.status, 200);
  const afterScene = savedScene(afterRun);
  assert.equal(afterScene.expiresAt, metadata.expiresAt);
  assert.deepEqual(afterScene.document, saved.document);
});

test('scene expiry is exclusive at exactly 24 hours and expired URLs remain app routes', async t => {
  const clock = { value: Date.parse('2026-03-01T00:00:00.000Z') };
  const api = await sandbox(t, clock);
  const { port } = await api.start();
  const first = savedScene(await send(port, 'POST', '/api/scenes', JSON.stringify(validDocument())));
  const second = savedScene(await send(port, 'POST', '/api/scenes', JSON.stringify(validDocument())));

  clock.value += SCENE_RETENTION_MS - 1;
  assert.equal((await send(port, 'GET', `/api/scenes/${second.id}`)).status, 200);
  clock.value += 1;
  const unavailable = await send(port, 'GET', `/api/scenes/${second.id}`);
  assert.equal(unavailable.status, 404);
  assert.equal(unavailable.headers['x-robots-tag'], 'noindex, nofollow');
  assert.equal(errorCode(unavailable), 'scene_not_found');
  const staleRun = await send(port, 'POST', `/api/scenes/${first.id}/run`, '{}');
  assert.equal(staleRun.status, 404);
  assert.equal(errorCode(staleRun), 'scene_not_found');
  assert.equal((await send(port, 'GET', `/scenes/${second.id}`)).status, 200);
  assert.equal((await send(port, 'HEAD', `/scenes/${second.id}`)).status, 200);
});

test('scene routes validate bodies and UUIDs, accept payloads above 64 KiB, and enforce 1 MiB', async t => {
  const clock = { value: Date.parse('2026-04-01T00:00:00.000Z') };
  const api = await sandbox(t, clock);
  const { port } = await api.start();

  const largeBody = JSON.stringify(largeDocument());
  assert.ok(Buffer.byteLength(largeBody) > 64 * 1024);
  const large = await send(port, 'POST', '/api/scenes', largeBody);
  assert.equal(large.status, 201);
  const largeSaved = savedScene(large);
  assert.equal(largeSaved.document.scene.sites.length, 512);

  const invalidDocument = { ...validDocument(), unexpected: true };
  const malformed = await send(port, 'POST', '/api/scenes', JSON.stringify(invalidDocument));
  assert.equal(malformed.status, 400);
  assert.equal(errorCode(malformed), 'invalid_request');
  const invalidJson = await send(port, 'POST', '/api/scenes', '{');
  assert.equal(invalidJson.status, 400);
  assert.equal(errorCode(invalidJson), 'invalid_json');

  const invalidId = await send(port, 'GET', '/api/scenes/not-a-uuid');
  assert.equal(invalidId.status, 404);
  assert.equal(errorCode(invalidId), 'scene_not_found');
  const invalidRunId = await send(port, 'POST', '/api/scenes/not-a-uuid/run', '{}');
  assert.equal(invalidRunId.status, 404);
  assert.equal(errorCode(invalidRunId), 'scene_not_found');
  assert.equal((await send(port, 'GET', '/api/scenes')).status, 404);
  assert.equal((await send(port, 'GET', `/scenes/${largeSaved.id}/extra`)).status, 404);
  const traversal = await send(port, 'GET', '/%2e%2e%2fserver/index.ts');
  assert.equal(traversal.status, 404);
  assert.doesNotMatch(traversal.body, /createApiServer/);

  const badRunBody = await send(port, 'POST', `/api/scenes/${largeSaved.id}/run`, '{"extra":true}');
  assert.equal(badRunBody.status, 400);
  assert.equal(errorCode(badRunBody), 'invalid_request');
  const tooLarge = await send(port, 'POST', '/api/scenes', ' '.repeat(1024 * 1024 + 1));
  assert.equal(tooLarge.status, 413);
  assert.equal(errorCode(tooLarge), 'payload_too_large');
});

test('opening cleanup uses a conditional expiry and cannot delete a scene renewed while cleanup was stale', async t => {
  const createdAt = Date.parse('2026-05-01T00:00:00.000Z');
  const clock = { value: createdAt };
  const api = await sandbox(t, clock);
  const creator = await api.start();
  const saved = savedScene(await send(creator.port, 'POST', '/api/scenes', JSON.stringify(validDocument())));

  clock.value = createdAt + 23 * 60 * 60 * 1000;
  const runner = await api.start();
  const renewedResult = await send(runner.port, 'POST', `/api/scenes/${saved.id}/run`, '{}');
  assert.equal(renewedResult.status, 200);
  const renewed = SavedSceneMetadataSchema.parse(renewedResult.value);
  assert.equal(renewed.expiresAt, new Date(createdAt + 47 * 60 * 60 * 1000).toISOString());

  clock.value = createdAt + SCENE_RETENTION_MS;
  const staleCleaner = await api.start(true);
  const live = await send(staleCleaner.port, 'GET', `/api/scenes/${saved.id}`);
  assert.equal(live.status, 200);
  assert.equal(savedScene(live).expiresAt, renewed.expiresAt);

  await closeServer(creator.server);
  await closeServer(runner.server);
  await closeServer(staleCleaner.server);
  clock.value = Date.parse(renewed.expiresAt);
  const expiryCleaner = await api.start(true);
  const expired = await send(expiryCleaner.port, 'GET', `/api/scenes/${saved.id}`);
  assert.equal(expired.status, 404);
  await closeServer(expiryCleaner.server);
  const database = new DatabaseSync(api.databasePath);
  const count = database.prepare('SELECT count(*) AS count FROM scenes').get();
  database.close();
  assert.ok(count && 'count' in count && typeof count.count === 'number');
  assert.equal(count.count, 0);
});

test('storage write failures and corrupted persisted documents return server errors', async t => {
  const clock = { value: Date.parse('2026-06-01T00:00:00.000Z') };
  const api = await sandbox(t, clock);
  const { port } = await api.start();
  const saved = savedScene(await send(port, 'POST', '/api/scenes', JSON.stringify(validDocument())));
  const database = new DatabaseSync(api.databasePath);
  database.exec(`CREATE TRIGGER reject_scene_insert BEFORE INSERT ON scenes BEGIN SELECT RAISE(ABORT, 'injected write failure'); END`);
  database.prepare('UPDATE scenes SET document = ? WHERE id = ?').run('{', saved.id);
  database.close();

  const failedWrite = await send(port, 'POST', '/api/scenes', JSON.stringify(validDocument()));
  assert.equal(failedWrite.status, 500);
  assert.equal(errorCode(failedWrite), 'internal_error');
  const corruptedRead = await send(port, 'GET', `/api/scenes/${saved.id}`);
  assert.equal(corruptedRead.status, 500);
  assert.equal(errorCode(corruptedRead), 'internal_error');
});
