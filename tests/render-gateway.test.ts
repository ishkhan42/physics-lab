import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { request as httpRequest } from 'node:http';
import type { TestContext } from 'node:test';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import { EXPERIMENT_EXAMPLES } from '../shared/examples.ts';
import { createRenderGateway } from '../server/render-gateway.ts';

const EXAMPLE_SCENE = EXPERIMENT_EXAMPLES[0]!.setups[0]!.document.scene;
const PAYLOAD = { scene: EXAMPLE_SCENE, request: { times: [0], view: 'overview', focusId: null } };

async function startGateway(t: TestContext): Promise<string> {
  const server = createRenderGateway();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    if (!server.listening) return;
    const closed = Promise.withResolvers<void>();
    server.close(error => error ? closed.reject(error) : closed.resolve());
    server.closeAllConnections();
    await closed.promise;
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function assertError(response: Response, status: number, code: string): Promise<void> {
  assert.equal(response.status, status);
  const body = await response.json() as { error?: { code?: string; message?: string } };
  assert.equal(body.error?.code, code);
}

function post(base: string, body: string | ArrayBuffer, contentType = 'application/json'): Promise<Response> {
  return fetch(`${base}/capture`, { method: 'POST', headers: { 'content-type': contentType }, body });
}

test('renderer gateway exposes only the health and capture paths with their exact methods', { timeout: 10_000 }, async t => {
  const base = await startGateway(t);
  const health = await fetch(`${base}/`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });

  await assertError(await fetch(`${base}/capture`), 405, 'method_not_allowed');
  await assertError(await fetch(`${base}/`, { method: 'POST' }), 405, 'method_not_allowed');
  await assertError(await fetch(`${base}/unknown`, { method: 'POST' }), 404, 'not_found');
  await assertError(await fetch(`${base}/capture?url=https://example.invalid`, { method: 'POST' }), 400, 'invalid_path');
  await assertError(await fetch(`${base}/?ready=true`), 400, 'invalid_path');
});

test('renderer gateway rejects unsupported media, malformed UTF-8 and JSON, and oversized bodies', { timeout: 15_000 }, async t => {
  const base = await startGateway(t);
  await assertError(await post(base, '{"not":"json"', 'text/plain'), 415, 'unsupported_media_type');
  await assertError(await post(base, new Uint8Array([0x7b, 0xff, 0x7d]).buffer), 400, 'invalid_utf8');
  await assertError(await post(base, '{not-json'), 400, 'invalid_json');
  await assertError(await post(base, ' '.repeat(2 * 1024 * 1024 + 1)), 413, 'payload_too_large');
});

test('oversized chunked capture uploads are rejected before the sender finishes', { timeout: 5000 }, async t => {
  const base = await startGateway(t);
  const result = await new Promise<{ status: number; code: string }>((resolve, reject) => {
    const client = httpRequest(`${base}/capture`, { method: 'POST', headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' } }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('error', reject);
      response.on('end', () => {
        try { resolve({ status: response.statusCode!, code: JSON.parse(body).error.code }); } catch (error) { reject(error); }
      });
    });
    client.on('error', reject);
    t.after(() => client.destroy());
    client.write(Buffer.alloc(2 * 1024 * 1024 + 1, 0x20));
  });
  assert.deepEqual(result, { status: 413, code: 'payload_too_large' });
});

test('renderer gateway rejects semantic scene references and every unknown URL or code field before rendering', { timeout: 15_000 }, async t => {
  const base = await startGateway(t);
  const invalidReference = {
    ...PAYLOAD,
    scene: {
      ...EXAMPLE_SCENE,
      bodies: EXAMPLE_SCENE.bodies.map((body, index) => index === 0 ? { ...body, parentId: 'missing-reference' } : body),
    },
  };
  await assertError(await post(base, JSON.stringify(invalidReference)), 400, 'invalid_scene');

  const invalidPayloads = [
    { ...PAYLOAD, url: 'file:///etc/passwd' },
    { ...PAYLOAD, code: 'fetch("https://example.invalid")' },
    { ...PAYLOAD, scene: { ...EXAMPLE_SCENE, url: 'file:///etc/passwd' } },
    { ...PAYLOAD, scene: { ...EXAMPLE_SCENE, code: 'arbitrary browser code' } },
  ];
  for (const payload of invalidPayloads) {
    await assertError(await post(base, JSON.stringify(payload)), 400, 'invalid_payload');
  }
});

test('canceling actual navigation cleans resources and does not poison the next inspection', { timeout: 60_000 }, async () => {
  const program = `
    import assert from 'node:assert/strict';
    import {readdir} from 'node:fs/promises';
    import puppeteer from 'puppeteer-core';
    import {captureScene} from '/lab/server/scene-inspector.ts';
    const scene=${JSON.stringify(EXAMPLE_SCENE)};
    const request={times:[0],view:'overview',focusId:null};
    const profiles=async()=> (await readdir('/tmp')).filter(name=>name.startsWith('physics-lab-inspection-')).sort();
    const before=await profiles();
    const controller=new AbortController();
    const original=puppeteer.launch.bind(puppeteer);
    let launched;
    puppeteer.launch=async options=>{
      const browser=await original(options);launched=browser;
      const newPage=browser.newPage.bind(browser);
      browser.newPage=async()=>{
        const page=await newPage();
        const goto=page.goto.bind(page);
        page.goto=(...args)=>{const pending=goto(...args);controller.abort();return pending;};
        return page;
      };
      return browser;
    };
    await assert.rejects(captureScene(scene,request,controller.signal),error=>error instanceof Error&&!(error instanceof AggregateError)&&/cancelled/.test(error.message));
    assert.equal(launched.connected,false);
    const browserProcess=launched.process();
    assert.ok(browserProcess.exitCode!==null||browserProcess.signalCode!==null);
    assert.deepEqual(await profiles(),before);
    puppeteer.launch=original;
    const frames=await captureScene(scene,request);
    assert.equal(frames[0].width,960);assert.equal(frames[0].height,640);
    assert.deepEqual(await profiles(),before);
  `;
  await promisify(execFile)('docker', [
    'run', '--rm', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--user=10001:10001', '--memory=1g', '--pids-limit=128', '--cpus=1',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=128m', '--entrypoint=node', 'physics-lab-harness:local',
    '--input-type=module', '-e', program,
  ], { timeout: 55_000, maxBuffer: 1024 * 1024 });
});
