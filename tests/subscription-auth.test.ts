import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { Firestore } from '@google-cloud/firestore';
import { GoogleAuth } from 'google-auth-library';
import { hostedSubscriptionKey } from '../server/subscription-auth.ts';

const secret = 'projects/demo-lab/secrets/codex';
function credential(expires: number, refresh = 'initial-refresh') {
  return { type: 'oauth' as const, access: `fixture.${Buffer.from(JSON.stringify({ exp: expires / 1000, 'https://api.openai.com/auth': { chatgpt_account_id: 'isolated-account' } })).toString('base64url')}.fixture`, refresh, expires };
}

function boundary(t: TestContext, initial: ReturnType<typeof credential>) {
  let stored = initial;
  let refreshes = 0;
  let rejectPublication = false;
  let beforeRefresh: (() => Promise<void>) | undefined;
  const saved = Promise.withResolvers<void>();
  t.mock.method(GoogleAuth.prototype, 'request', async (options: { url: string; data?: { payload: { data: string } } }) => {
    if (options.url.endsWith('/versions/latest:access')) return { data: { payload: { data: Buffer.from(JSON.stringify(stored)).toString('base64') } } };
    assert.equal(options.url, `https://secretmanager.googleapis.com/v1/${secret}:addVersion`);
    if (rejectPublication) throw new Error('Deliberate secret storage failure.');
    stored = JSON.parse(Buffer.from(options.data!.payload.data, 'base64').toString('utf8'));
    saved.resolve();
    return { data: { name: `${secret}/versions/2` } };
  });
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'https://auth.openai.com/oauth/token');
    assert.equal(new URLSearchParams(String(init?.body)).get('refresh_token'), stored.refresh);
    refreshes++;
    await beforeRefresh?.();
    return Response.json({ access_token: credential(Date.now() + 10 * 86_400_000).access, refresh_token: 'rotated-refresh', expires_in: 10 * 86_400 });
  };
  return { get stored() { return stored; }, get refreshes() { return refreshes; }, saved: saved.promise,
    blockRefresh: (callback: () => Promise<void>) => { beforeRefresh = callback; },
    failPublication: () => { rejectPublication = true; } };
}

async function leaseStore(t: TestContext) {
  const projectId = `demo-auth-${randomUUID().slice(0, 8)}`;
  const previous = process.env.FIRESTORE_PROJECT_ID;
  process.env.FIRESTORE_PROJECT_ID = projectId;
  const firestore = new Firestore({ projectId });
  t.after(async () => {
    await firestore.doc('labAuth/codex-refresh').delete();
    await firestore.terminate();
    if (previous === undefined) delete process.env.FIRESTORE_PROJECT_ID;
    else process.env.FIRESTORE_PROJECT_ID = previous;
  });
  return firestore;
}

const emulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
test('a valid access token remains usable when the demo extends beyond its expiry because renewal is available', async t => {
  const state = boundary(t, credential(Date.now() + 86_400_000));
  assert.equal(await hostedSubscriptionKey(secret, Date.now() + 12 * 86_400_000), state.stored.access);
  assert.equal(state.refreshes, 0);
});

test('expired credentials rotate once, persist the new refresh token and serve subsequent requests', { skip: !emulator }, async t => {
  await leaseStore(t);
  const state = boundary(t, credential(Date.now() - 1000));
  const first = await hostedSubscriptionKey(secret, Date.now() + 12 * 86_400_000);
  assert.equal(state.stored.refresh, 'rotated-refresh');
  assert.equal(await hostedSubscriptionKey(secret, Date.now() + 12 * 86_400_000), first);
  assert.equal(state.refreshes, 1);
});

test('the durable lease prevents a second instance from rotating the same refresh token concurrently', { skip: !emulator }, async t => {
  await leaseStore(t);
  const state = boundary(t, credential(Date.now() - 1000));
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  state.blockRefresh(async () => { started.resolve(); await release.promise; });
  const first = hostedSubscriptionKey(secret, Date.now() + 12 * 86_400_000);
  await started.promise;
  await assert.rejects(hostedSubscriptionKey(secret, Date.now() + 12 * 86_400_000), /already in progress/);
  release.resolve();
  await first;
  assert.equal(state.refreshes, 1);
});

test('canceling a browser during rotation still persists credentials for the next visitor', { skip: !emulator }, async t => {
  await leaseStore(t);
  const state = boundary(t, credential(Date.now() - 1000));
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  state.blockRefresh(async () => { started.resolve(); await release.promise; });
  const controller = new AbortController();
  const first = hostedSubscriptionKey(secret, Date.now() + 12 * 86_400_000, controller.signal);
  await started.promise;
  controller.abort();
  await assert.rejects(first, { name: 'AbortError' });
  release.resolve();
  await state.saved;
  const next = await hostedSubscriptionKey(secret, Date.now() + 12 * 86_400_000);
  assert.equal(next, state.stored.access);
  assert.equal(state.stored.refresh, 'rotated-refresh');
  assert.equal(state.refreshes, 1);
});

test('failed durable publication never hands out an unpersisted token and releases the renewal lease', { skip: !emulator }, async t => {
  const firestore = await leaseStore(t);
  const state = boundary(t, credential(Date.now() - 1000));
  state.failPublication();
  await assert.rejects(hostedSubscriptionKey(secret, Date.now() + 12 * 86_400_000), /storage failure/);
  assert.equal((await firestore.doc('labAuth/codex-refresh').get()).exists, false);
  assert.equal(state.refreshes, 1);
});
