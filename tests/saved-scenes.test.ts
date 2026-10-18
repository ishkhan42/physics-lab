import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { forgetRecentScene, readRecentScenes, rememberRecentScene, renewSavedScene, type RecentScene } from '../src/saved-scenes.ts';

const makeId = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const expiry = new Date(2_000_000_000_000).toISOString();

function withLocalStorage(run: (entries: Map<string, string>) => void): void {
  const entries = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => entries.set(key, value),
    },
  });
  try {
    run(entries);
  } finally {
    Reflect.deleteProperty(globalThis, 'localStorage');
  }
}

test('recent scenes retain cached expiries for server revalidation and persist metadata only', () => {
  withLocalStorage(entries => {
    const valid: RecentScene = { id: makeId(1), title: 'A scene', expiresAt: expiry };
    const cachedExpired: RecentScene = { ...valid, id: makeId(2), expiresAt: new Date(1_000_000_000_000).toISOString() };
    entries.set('physics-lab.recent-scenes', JSON.stringify([
      valid,
      cachedExpired,
      { ...valid, id: 'not-a-uuid' },
      { ...valid, id: makeId(3), document: { prompt: 'must not persist' } },
    ]));

    const recent = readRecentScenes();
    assert.deepEqual(recent, [valid, cachedExpired, { id: makeId(3), title: valid.title, expiresAt: valid.expiresAt }]);
    assert.deepEqual(JSON.parse(entries.get('physics-lab.recent-scenes')!), recent);
  });
});

test('recent scenes stay unique, capped at eight, and can be removed', () => {
  withLocalStorage(entries => {
    const record = (id: number) => ({ id: makeId(id), title: `Scene ${id}`, expiresAt: expiry });
    for (let id = 1; id <= 9; id += 1) {
      const item = record(id);
      rememberRecentScene(item.id, item.title, item.expiresAt);
    }
    const last = record(9);
    rememberRecentScene(last.id, last.title, last.expiresAt);
    const recent = readRecentScenes();
    assert.equal(recent.length, 8);
    assert.equal(recent.some(item => item.id === makeId(1)), false);
    assert.deepEqual(forgetRecentScene(makeId(9)).map(item => item.id), recent.slice(1).map(item => item.id));
    assert.deepEqual(Object.keys(JSON.parse(entries.get('physics-lab.recent-scenes')!)[0] ?? {}).sort(), ['expiresAt', 'id', 'title']);
  });
});
test('stalled scene requests stop on their deadline or caller cancellation', { timeout: 5000 }, async t => {
  let received = Promise.withResolvers<void>();
  let disconnected = Promise.withResolvers<void>();
  const server = createServer((request, response) => {
    const closed = disconnected;
    request.resume();
    response.once('close', () => closed.resolve());
    received.resolve();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const originalFetch = globalThis.fetch;
  let deadline = new AbortController();
  t.mock.method(AbortSignal, 'timeout', () => deadline.signal);
  // Supply an origin for browser-relative URLs, but use the real HTTP transport.
  globalThis.fetch = (input, init) => originalFetch(new URL(String(input), `http://127.0.0.1:${address.port}`), init);
  t.after(async () => {
    globalThis.fetch = originalFetch;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  for (const mode of ['deadline', 'caller'] as const) {
    received = Promise.withResolvers<void>();
    disconnected = Promise.withResolvers<void>();
    deadline = new AbortController();
    const caller = new AbortController();
    const rejected = assert.rejects(renewSavedScene(makeId(10), mode === 'caller' ? caller.signal : undefined),
      error => error instanceof Error && error.name === (mode === 'deadline' ? 'TimeoutError' : 'AbortError'));
    await received.promise;
    if (mode === 'deadline') deadline.abort(new DOMException('Deadline reached.', 'TimeoutError'));
    else caller.abort();
    await rejected;
    await disconnected.promise;
  }
});
