import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { lstat, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { validateScene, type Scene } from '../shared/scene.ts';
import {
  INSPECTION_HEIGHT,
  INSPECTION_TIMEOUT_MS,
  INSPECTION_WIDTH,
  MAX_JPEG_BYTES,
  VisualFrameSchema,
  VisualCaptureRequestSchema,
  type VisualFrame,
  type VisualCaptureRequest,
  type InspectionView,
} from '../shared/visual-inspection.ts';

const PREVIEW_ROOT = fileURLToPath(new URL('../dist-inspection/', import.meta.url));
const CHROMIUM_PATH = '/usr/bin/chromium';
const MAX_ASSET_BYTES = 24 * 1024 * 1024;
const ASSET_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.webp': 'image/webp',
};

interface StaticAsset {
  diskPath: string;
  contentType: string;
}

function routePath(rawUrl: string | undefined): string | null {
  if (!rawUrl || rawUrl.includes('?') || rawUrl.includes('#')) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawUrl);
  } catch {
    return null;
  }
  if (decoded !== rawUrl || decoded.includes('\\') || decoded.includes('\0') || !decoded.startsWith('/')) return null;
  if (decoded.split('/').some(part => part === '.' || part === '..')) return null;
  return decoded;
}

async function makeAsset(path: string, diskPath: string, contentType: string): Promise<StaticAsset> {
  const info = await lstat(diskPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_ASSET_BYTES) {
    throw new Error(`Inspection preview asset is not a bounded regular file: ${path}`);
  }
  return { diskPath, contentType };
}

async function createAssetWhitelist(): Promise<Map<string, StaticAsset>> {
  const assets = new Map<string, StaticAsset>();
  assets.set('/', await makeAsset('/inspection.html', join(PREVIEW_ROOT, 'inspection.html'), 'text/html; charset=utf-8'));
  assets.set('/inspection.html', assets.get('/')!);
  const assetDirectory = join(PREVIEW_ROOT, 'assets');
  for (const name of await readdir(assetDirectory)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) continue;
    const extension = name.slice(name.lastIndexOf('.'));
    const contentType = ASSET_TYPES[extension];
    if (!contentType) continue;
    const path = `/assets/${name}`;
    assets.set(path, await makeAsset(path, join(assetDirectory, name), contentType));
  }
  return assets;
}

function sendHeaders(response: ServerResponse, contentType?: string): void {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  // MuJoCo's trusted Embind bindings generate JS functions; assets and browser requests remain allowlisted.
  response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self' 'unsafe-eval'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  response.setHeader('Cache-Control', 'no-store');
  if (contentType) response.setHeader('Content-Type', contentType);
}

async function startAssetServer(assets: Map<string, StaticAsset>): Promise<{ server: Server; origin: string }> {
  const server = createServer((request, response) => {
    const path = routePath(request.url);
    const asset = path === null ? undefined : assets.get(path);
    if ((request.method !== 'GET' && request.method !== 'HEAD') || !asset) {
      sendHeaders(response);
      response.writeHead(request.method === 'GET' || request.method === 'HEAD' ? 404 : 405);
      response.end();
      return;
    }
    void readFile(asset.diskPath).then(contents => {
      if (response.destroyed) return;
      sendHeaders(response, asset.contentType);
      response.setHeader('Content-Length', contents.byteLength);
      response.writeHead(200);
      response.end(request.method === 'HEAD' ? undefined : contents);
    }).catch(() => {
      if (response.destroyed) return;
      sendHeaders(response);
      response.writeHead(404);
      response.end();
    });
  });
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const fail = (error: Error) => reject(error);
  server.once('error', fail);
  server.once('listening', () => {
    server.off('error', fail);
    resolve();
  });
  server.listen(0, '127.0.0.1');
  await promise;
  const address = server.address() as AddressInfo;
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

function stopAssetServer(server: Server): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  server.close(error => error ? reject(error) : resolve());
  server.closeAllConnections();
  return promise;
}

async function enforceBrowserAssetLock(page: Page, origin: string, allowedPaths: Set<string>): Promise<void> {
  await page.setRequestInterception(true);
  page.on('request', request => {
    let allowed = false;
    try {
      const url = new URL(request.url());
      const path = routePath(url.pathname);
      allowed = url.origin === origin && !url.search && !url.hash && request.method() === 'GET'
        && path !== null && allowedPaths.has(path);
    } catch {
      allowed = false;
    }
    const action = allowed ? request.continue() : request.abort('blockedbyclient');
    void action.catch(() => {});
  });
}

function assertNotTimedOut(timedOut: () => boolean): void {
  if (timedOut()) throw new Error('Visual inspection exceeded its 45-second limit.');
}

async function captureFrames(scene: Scene, request: VisualCaptureRequest, signal: AbortSignal, timedOut: () => boolean,
  setBrowser: (browser: Browser) => void, setServer: (server: Server) => void,
  setProfile: (path: string) => void): Promise<VisualFrame[]> {
  const assets = await createAssetWhitelist();
  assertNotTimedOut(timedOut);
  const { server, origin } = await startAssetServer(assets);
  setServer(server);
  assertNotTimedOut(timedOut);
  const profile = await mkdtemp(join(tmpdir(), 'physics-lab-inspection-'));
  setProfile(profile);
  assertNotTimedOut(timedOut);

  const launch = puppeteer.launch({
    executablePath: CHROMIUM_PATH,
    headless: true,
    signal,
    pipe: true,
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: profile, XDG_CONFIG_HOME: profile, XDG_CACHE_HOME: profile, LANG: 'C.UTF-8' },
    userDataDir: profile,
    timeout: INSPECTION_TIMEOUT_MS - 1_000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-extensions',
      '--renderer-process-limit=1',
      '--num-raster-threads=1',
      '--disable-sync',
      '--no-first-run',
      '--enable-webgl',
      '--ignore-gpu-blocklist',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
    ],
  });
  void launch.then(browser => {
    setBrowser(browser);
  }, () => {});
  const browser = await launch;
  assertNotTimedOut(timedOut);
  const page = await browser.newPage();
  await page.setViewport({ width: INSPECTION_WIDTH, height: INSPECTION_HEIGHT, deviceScaleFactor: 1 });
  await enforceBrowserAssetLock(page, origin, new Set(assets.keys()));
  await page.bringToFront();
  await page.goto(`${origin}/`, { waitUntil: 'networkidle0', timeout: INSPECTION_TIMEOUT_MS - 1_000 });
  await page.waitForFunction(() => Boolean(window.physicsLabInspection), { timeout: INSPECTION_TIMEOUT_MS - 1_000 });
  const canvas = await page.waitForSelector('canvas.simulation-canvas__webgl', { visible: true, timeout: INSPECTION_TIMEOUT_MS - 1_000 });
  if (!canvas) throw new Error('The Three.js renderer did not create its WebGL canvas.');
  await page.waitForFunction(() => {
    const element = document.querySelector<HTMLCanvasElement>('canvas.simulation-canvas__webgl');
    const bounds = element?.getBoundingClientRect();
    return Boolean(element && bounds?.width === 960 && bounds.height === 640 && element.width === 960 && element.height === 640);
  }, { timeout: INSPECTION_TIMEOUT_MS - 1_000 });
  await page.evaluate(async (input: Scene) => {
    const bridge = window.physicsLabInspection;
    if (!bridge) throw new Error('The private inspection bridge is unavailable.');
    await bridge.load(input);
  }, scene);

  const times = [...request.times].sort((a, b) => a - b);
  const frames: VisualFrame[] = [];
  for (const requestedAt of times) {
    assertNotTimedOut(timedOut);
    const capture = await page.evaluate(async (input: { time: number; view: InspectionView; focusId: string | null }) => {
      const bridge = window.physicsLabInspection;
      if (!bridge) throw new Error('The private inspection bridge is unavailable.');
      return bridge.capture(input.time, input.view, input.focusId);
    }, { time: requestedAt, view: request.view, focusId: request.focusId });
    assertNotTimedOut(timedOut);
    const dimensions = await canvas.evaluate(element => {
      if (!(element instanceof HTMLCanvasElement)) throw new Error('The scene viewport is not a canvas.');
      return { width: element.width, height: element.height, rect: element.getBoundingClientRect().toJSON() };
    });
    if (dimensions.width !== INSPECTION_WIDTH || dimensions.height !== INSPECTION_HEIGHT
      || dimensions.rect.width !== INSPECTION_WIDTH || dimensions.rect.height !== INSPECTION_HEIGHT) {
      throw new Error('The actual WebGL viewport is not exactly 960 by 640 pixels.');
    }
    const screenshot = await canvas.screenshot({ type: 'jpeg', quality: 82 });
    if (screenshot.byteLength > MAX_JPEG_BYTES) throw new Error(`The actual scene screenshot exceeded ${MAX_JPEG_BYTES} bytes.`);
    if (screenshot.byteLength < 4 || screenshot[0] !== 0xff || screenshot[1] !== 0xd8
      || screenshot[screenshot.byteLength - 2] !== 0xff || screenshot[screenshot.byteLength - 1] !== 0xd9) {
      throw new Error('Chromium did not return a complete JPEG scene screenshot.');
    }
    const data = Buffer.from(screenshot.buffer, screenshot.byteOffset, screenshot.byteLength).toString('base64');
    frames.push(VisualFrameSchema.parse({
      requestedAt,
      simulatedAt: capture.simulatedAt,
      view: request.view,
      focusedId: capture.focusedId,
      width: INSPECTION_WIDTH,
      height: INSPECTION_HEIGHT,
      notes: capture.notes,
      image: { type: 'image', data, mimeType: 'image/jpeg' },
    }));
  }
  return frames;
}

export async function captureScene(sceneInput: Scene, requestInput: VisualCaptureRequest): Promise<VisualFrame[]> {
  let browser: Browser | null = null;
  let server: Server | null = null;
  let profile: string | null = null;
  let timedOut = false;
  const controller = new AbortController();
  const { promise: timeout, reject: rejectTimeout } = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    rejectTimeout(new Error('Visual inspection exceeded its 45-second limit.'));
    server?.closeAllConnections();
  }, INSPECTION_TIMEOUT_MS);
  const setBrowser = (value: Browser) => {
    browser = value;
  };
  const setServer = (value: Server) => {
    server = value;
    if (timedOut) void stopAssetServer(value).catch(() => {});
  };
  const setProfile = (value: string) => {
    profile = value;
    if (timedOut) void rm(value, { recursive: true, force: true }).catch(() => {});
  };
  const work = (async () => {
    const scene = validateScene(sceneInput);
    const request = VisualCaptureRequestSchema.parse(requestInput);
    return captureFrames(scene, request, controller.signal, () => timedOut, setBrowser, setServer, setProfile);
  })();
  let failed = false;
  try {
    return await Promise.race([work, timeout]);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    controller.abort();
    const cleanupFailures: unknown[] = [];
    const activeBrowser = browser as Browser | null;
    if (activeBrowser) try { await activeBrowser.close(); } catch (error) { cleanupFailures.push(error); }
    if (server) try { await stopAssetServer(server); } catch (error) { cleanupFailures.push(error); }
    if (profile) try { await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch (error) { cleanupFailures.push(error); }
    clearTimeout(timer);
    if (!failed && cleanupFailures.length) {
      throw new Error('Visual inspection could not fully close its disposable browser resources.', { cause: cleanupFailures[0] });
    }
  }
}
