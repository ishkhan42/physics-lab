import { createReadStream } from 'node:fs';
import type { Stats } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HarnessRequestSchema } from '../shared/harness.ts';
import { SavedSceneIdSchema } from '../shared/saved-scene.ts';
import { InvalidSceneDocumentError, SceneStore } from './scenes.ts';
import { FirestoreSceneStore } from './firestore-scenes.ts';
import { getProviderConfig, listOpenRouterModels, ProviderError } from './providers.ts';
import { runLab } from './harness.ts';
import { hostedDemo } from './demo.ts';

const DEFAULT_PORT = 3001;
const MAX_ASSEMBLY_BYTES = 64 * 1024;
const MAX_SCENE_BYTES = 1024 * 1024;
const MAX_API_RESPONSE_BYTES = 8 * 1024 * 1024;
const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST_ROOT = resolve(PROJECT_ROOT, 'dist');
const ALLOWED_HOSTS: Record<string, true> = {
  '127.0.0.1:3001': true,
  'localhost:3001': true,
  '127.0.0.1:5173': true,
  'localhost:5173': true,
};
const ALLOWED_ORIGINS: Record<string, true> = {
  'http://127.0.0.1:3001': true,
  'http://localhost:3001': true,
  'http://127.0.0.1:5173': true,
  'http://localhost:5173': true,
};
type SceneRepository = Pick<SceneStore, 'initialize' | 'create' | 'get' | 'run' | 'cleanupExpired'> & { close(): void | Promise<void> };
type RequestPolicy = { hosts: ReadonlySet<string>; origins: ReadonlySet<string> };

function requestPolicy(): RequestPolicy {
  const configured = process.env.PUBLIC_ORIGINS?.trim();
  if (!configured) return { hosts: new Set(Object.keys(ALLOWED_HOSTS)), origins: new Set(Object.keys(ALLOWED_ORIGINS)) };
  const origins = configured.split(',').map(value => {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('PUBLIC_ORIGINS must contain HTTPS origins only.');
    }
    return url;
  });
  return { hosts: new Set(origins.map(url => url.host)), origins: new Set(origins.map(url => url.origin)) };
}
const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly closeConnection: boolean;

  constructor(status: number, code: string, message: string, closeConnection = false) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.closeConnection = closeConnection;
  }
}

function setSafeHeaders(response: ServerResponse): void {
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('referrer-policy', 'no-referrer');
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  closeConnection = false,
): void {
  let body = JSON.stringify(value) ?? 'null';
  let size = Buffer.byteLength(body);
  if (size > MAX_API_RESPONSE_BYTES) {
    status = 502;
    body = JSON.stringify({ error: { code: 'response_too_large', message: 'The server response exceeded the allowed size.' } });
    size = Buffer.byteLength(body);
  }
  setSafeHeaders(response);
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': size,
    'content-type': 'application/json; charset=utf-8',
    ...(closeConnection ? { connection: 'close' } : {}),
  });
  response.end(body);
}

function enforceRequest(request: IncomingMessage, policy: RequestPolicy): void {
  const host = request.headers.host?.toLowerCase();
  if (!host || !policy.hosts.has(host)) throw new ApiError(403, 'forbidden_host', 'Use this lab’s application address.');
  const origin = request.headers.origin?.toLowerCase();
  if (origin && !policy.origins.has(origin)) throw new ApiError(403, 'forbidden_origin', 'Requests must come from this lab.');
}

async function readJsonBody(
  request: IncomingMessage,
  maxBytes = MAX_ASSEMBLY_BYTES,
  label = 'assembly',
): Promise<unknown> {
  const contentType = request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    request.resume();
    throw new ApiError(415, 'unsupported_media_type', `Send the ${label} request as application/json.`, true);
  }
  const declaredLength = Number(request.headers['content-length']);
  const limitMessage = label === 'lab' ? 'Lab requests are limited to 1 MiB, including conversation and scene context.' : label === 'assembly' ? 'Requests are limited to 64 KiB.' : 'Saved-scene requests are limited to 1 MiB.';
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    request.resume();
    throw new ApiError(413, 'payload_too_large', limitMessage, true);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (size + bytes.length > maxBytes) {
        request.resume();
        throw new ApiError(413, 'payload_too_large', limitMessage, true);
      }
      size += bytes.length;
      chunks.push(bytes);
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'invalid_json', 'The request body is not valid JSON.');
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
  } catch {
    throw new ApiError(400, 'invalid_json', 'The request body is not valid JSON.');
  }
}

function isInside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function serveStatic(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
): Promise<void> {
  if (request.method !== 'GET' && request.method !== 'HEAD') throw new ApiError(405, 'method_not_allowed', 'Only GET and HEAD are allowed for static files.');
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    throw new ApiError(400, 'invalid_path', 'The requested path is invalid.');
  }
  if (decodedPath.includes('\0')) throw new ApiError(404, 'not_found', 'The requested file was not found.');
  if (decodedPath === '/') decodedPath = '/index.html';
  const requestedPath = resolve(DIST_ROOT, decodedPath.slice(1));
  let root: string;
  let target: string;
  let file: Stats;
  try {
    root = await realpath(DIST_ROOT);
    const project = await realpath(PROJECT_ROOT);
    if (root !== resolve(project, 'dist')) throw new ApiError(404, 'not_found', 'The requested file was not found.');
    target = await realpath(requestedPath);
    if (!isInside(root, target)) throw new ApiError(404, 'not_found', 'The requested file was not found.');
    file = await stat(target);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(404, 'not_found', 'The requested file was not found.');
  }
  if (!file.isFile()) throw new ApiError(404, 'not_found', 'The requested file was not found.');
  setSafeHeaders(response);
  const extension = extname(target).toLowerCase();
  response.writeHead(200, {
    'cache-control': /^\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/.test(pathname) ? 'public, max-age=31536000, immutable' : 'no-cache',
    'content-length': file.size,
    'content-type': Object.hasOwn(MIME_TYPES, extension) ? MIME_TYPES[extension] : 'application/octet-stream',
  });
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  const stream = createReadStream(target);
  stream.on('error', () => {
    if (!response.headersSent) sendJson(response, 500, { error: { code: 'file_unavailable', message: 'The requested file could not be served.' } });
    else response.destroy();
  });
  stream.pipe(response);
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  sceneStore: SceneRepository,
  policy: RequestPolicy,
): Promise<void> {
  let streaming = false;
  try {
    enforceRequest(request, policy);
    if (!request.url?.startsWith('/')) throw new ApiError(400, 'invalid_path', 'The requested path is invalid.');
    let url: URL;
    try {
      url = new URL(request.url, 'http://127.0.0.1');
    } catch {
      throw new ApiError(400, 'invalid_path', 'The requested path is invalid.');
    }
    if (url.pathname === '/api/scenes' || url.pathname.startsWith('/api/scenes/') || /^\/scenes\/[^/]+$/.test(url.pathname)) {
      response.setHeader('x-robots-tag', 'noindex, nofollow');
    }
    if (url.pathname === '/api/config') {
      if (request.method !== 'GET') throw new ApiError(405, 'method_not_allowed', 'Use GET for provider configuration.');
      sendJson(response, 200, getProviderConfig());
      return;
    }
    if (url.pathname === '/api/models') {
      if (request.method !== 'GET') throw new ApiError(405, 'method_not_allowed', 'Use GET to read the model catalog.');
      const provider = url.searchParams.getAll('provider');
      if (provider.length !== 1 || provider[0] !== 'openrouter') {
        throw new ApiError(400, 'invalid_provider', 'The model catalog is available for provider=openrouter.');
      }
      sendJson(response, 200, { models: await listOpenRouterModels() });
      return;
    }
    if (url.pathname === '/api/scenes' && request.method === 'POST') {
      const input = await readJsonBody(request, MAX_SCENE_BYTES, 'saved-scene');
      const saved = await sceneStore.create(input).catch(error => {
        if (error instanceof InvalidSceneDocumentError) {
          throw new ApiError(400, 'invalid_request', 'The saved scene document does not match the supported format.');
        }
        throw error;
      });
      sendJson(response, 201, saved);
      return;
    }
    const sceneMatch = url.pathname.match(/^\/api\/scenes\/([^/]+)$/);
    if (sceneMatch) {
      if (request.method !== 'GET') throw new ApiError(405, 'method_not_allowed', 'Use GET to read a saved scene.');
      const id = sceneMatch[1];
      if (!SavedSceneIdSchema.safeParse(id).success) throw new ApiError(404, 'scene_not_found', 'This saved scene is unavailable or has expired.');
      const saved = await sceneStore.get(id);
      if (!saved) throw new ApiError(404, 'scene_not_found', 'This saved scene is unavailable or has expired.');
      sendJson(response, 200, saved);
      return;
    }
    const runMatch = url.pathname.match(/^\/api\/scenes\/([^/]+)\/run$/);
    if (runMatch) {
      if (request.method !== 'POST') throw new ApiError(405, 'method_not_allowed', 'Use POST to run a saved scene.');
      const id = runMatch[1];
      if (!SavedSceneIdSchema.safeParse(id).success) throw new ApiError(404, 'scene_not_found', 'This saved scene is unavailable or has expired.');
      const body = await readJsonBody(request);
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 0) {
        throw new ApiError(400, 'invalid_request', 'The run request must be an empty JSON object.');
      }
      const saved = await sceneStore.run(id);
      if (!saved) throw new ApiError(404, 'scene_not_found', 'This saved scene is unavailable or has expired.');
      sendJson(response, 200, saved);
      return;
    }
    if (url.pathname === '/api/lab') {
      if (request.method !== 'POST') throw new ApiError(405, 'method_not_allowed', 'Use POST to work with the lab assistant.');
      const parsed = HarnessRequestSchema.safeParse(await readJsonBody(request, MAX_SCENE_BYTES, 'lab'));
      if (!parsed.success) throw new ApiError(400, 'invalid_request', 'The lab request does not match the supported format.');
      const controller = new AbortController();
      const disconnected = () => { if (!response.writableEnded) controller.abort(); };
      response.once('close', disconnected);
      const ensureConnected = () => {
        if (response.destroyed || response.writableEnded) throw new ApiError(499, 'lab_canceled', 'The lab assistant was stopped.');
      };
      try {
      if (request.headers.accept?.split(',').some(value => value.split(';', 1)[0].trim() === 'application/x-ndjson')) {
        const writeRecord = (record: unknown) => {
          ensureConnected();
          if (!streaming) {
            setSafeHeaders(response);
            response.writeHead(200, {
              'content-type': 'application/x-ndjson; charset=utf-8',
              'cache-control': 'no-store',
              'x-accel-buffering': 'no',
            });
            streaming = true;
          }
          response.write(`${JSON.stringify(record)}\n`);
        };
        const outcome = await runLab(parsed.data, progress => writeRecord({ type: 'progress', ...progress }), text => writeRecord({ type: 'assistant', text }), controller.signal);
        writeRecord(outcome.kind === 'proposal' ? { type: 'proposal', proposal: outcome } : { type: 'decision', decision: outcome });
        response.end();
      } else {
        sendJson(response, 200, await runLab(parsed.data, ensureConnected, ensureConnected, controller.signal));
      }
      } finally {
        response.off('close', disconnected);
        controller.abort();
      }
      return;
    }
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      throw new ApiError(404, 'not_found', 'The requested endpoint was not found.');
    }
    const sharedSceneMatch = url.pathname.match(/^\/scenes\/([^/]+)$/);
    if (sharedSceneMatch && SavedSceneIdSchema.safeParse(sharedSceneMatch[1]).success) {
      await serveStatic(request, response, '/index.html');
      return;
    }
    await serveStatic(request, response, url.pathname);
  } catch (error) {
    const safeError = error instanceof ApiError
      ? error
      : error instanceof ProviderError
        ? new ApiError(error.status, error.code, error.message)
        : new ApiError(500, 'internal_error', 'The request could not be completed.');
    if (streaming && !response.destroyed && !response.writableEnded) {
      response.end(`${JSON.stringify({ type: 'error', error: { code: safeError.code, message: safeError.message } })}\n`);
    } else if (!response.destroyed && !response.headersSent) {
      sendJson(response, safeError.status, { error: { code: safeError.code, message: safeError.message } }, safeError.closeConnection);
    } else if (!response.destroyed) {
      response.destroy();
    }
  }
}

export type ApiServerOptions = {
  sceneDbPath?: string;
  now?: () => number;
  initializeSceneStore?: boolean;
};

export function createApiServer(options: ApiServerOptions = {}) {
  const policy = requestPolicy();
  hostedDemo();
  const projectId = process.env.FIRESTORE_PROJECT_ID;
  if (process.env.K_SERVICE && (!process.env.PUBLIC_ORIGINS || !projectId || !process.env.LAB_WORKER_URL || !process.env.LAB_RENDERER_URL || !process.env.WORKER_AUTH_TOKEN)) {
    throw new Error('Hosted labs require public origins, durable storage, a private renderer and an authenticated isolated worker.');
  }
  const sceneStore: SceneRepository = projectId
    ? new FirestoreSceneStore({ projectId, now: options.now })
    : new SceneStore({ path: options.sceneDbPath, now: options.now });
  const server = createHttpServer((request, response) => {
    void handleRequest(request, response, sceneStore, policy).catch(() => response.destroy());
  });
  let maintenance: NodeJS.Timeout | undefined;
  if (projectId) {
    server.once('listening', () => {
      maintenance = setInterval(() => {
        void sceneStore.cleanupExpired().catch(() => console.error('Could not remove expired saved scenes.'));
      }, 60_000);
      maintenance.unref();
    });
  }
  server.on('close', () => {
    clearInterval(maintenance);
    void Promise.resolve(sceneStore.close()).catch(() => console.error('Could not close saved-scene storage.'));
  });
  if (options.initializeSceneStore) {
    server.on('listening', () => {
      void sceneStore.initialize().catch(() => {
        if (!server.listening) return;
        console.error('Could not initialize private saved-scene storage.');
        process.exitCode = 1;
        server.close();
      });
    });
  }
  server.headersTimeout = 10_000;
  server.requestTimeout = 255_000;
  return server;
}

export function startServer() {
  const port = process.env.PORT ? Number(process.env.PORT) : DEFAULT_PORT;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.');
  const host = process.env.PUBLIC_ORIGINS ? '0.0.0.0' : '127.0.0.1';
  const server = createApiServer({ initializeSceneStore: true });
  server.on('error', () => {
    console.error(`Could not start the physics-lab server on port ${port}.`);
    process.exitCode = 1;
  });
  server.listen(port, host, () => {
    console.log(`Physics lab server listening on ${host}:${port}`);
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) startServer();
