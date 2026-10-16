import { createReadStream } from 'node:fs';
import type { Stats } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AssemblyRequestSchema } from '../shared/scene.ts';
import { assemble, getProviderConfig, listOpenRouterModels, ProviderError } from './providers.ts';

const PORT = 3001;
const MAX_ASSEMBLY_BYTES = 64 * 1024;
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

function enforceLocalRequest(request: IncomingMessage): void {
  const host = request.headers.host?.toLowerCase();
  if (!host || !Object.hasOwn(ALLOWED_HOSTS, host)) throw new ApiError(403, 'forbidden_host', 'Requests must use the local application host.');
  const origin = request.headers.origin?.toLowerCase();
  if (origin && !Object.hasOwn(ALLOWED_ORIGINS, origin)) throw new ApiError(403, 'forbidden_origin', 'Requests must come from the local application.');
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    request.resume();
    throw new ApiError(415, 'unsupported_media_type', 'Send the assembly request as application/json.', true);
  }
  const declaredLength = Number(request.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ASSEMBLY_BYTES) {
    request.resume();
    throw new ApiError(413, 'payload_too_large', 'Assembly requests are limited to 64 KiB.', true);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (size + bytes.length > MAX_ASSEMBLY_BYTES) {
        request.resume();
        throw new ApiError(413, 'payload_too_large', 'Assembly requests are limited to 64 KiB.', true);
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
    'cache-control': 'no-cache',
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
): Promise<void> {
  try {
    enforceLocalRequest(request);
    if (!request.url?.startsWith('/')) throw new ApiError(400, 'invalid_path', 'The requested path is invalid.');
    let url: URL;
    try {
      url = new URL(request.url, 'http://127.0.0.1');
    } catch {
      throw new ApiError(400, 'invalid_path', 'The requested path is invalid.');
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
    if (url.pathname === '/api/assemble') {
      if (request.method !== 'POST') throw new ApiError(405, 'method_not_allowed', 'Use POST to assemble an experiment.');
      const parsed = AssemblyRequestSchema.safeParse(await readJsonBody(request));
      if (!parsed.success) throw new ApiError(400, 'invalid_request', 'The assembly request does not match the supported format.');
      const decision = await assemble(parsed.data);
      sendJson(response, 200, decision);
      return;
    }
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      throw new ApiError(404, 'not_found', 'The requested endpoint was not found.');
    }
    await serveStatic(request, response, url.pathname);
  } catch (error) {
    const safeError = error instanceof ApiError
      ? error
      : error instanceof ProviderError
        ? new ApiError(error.status, error.code, error.message)
        : new ApiError(500, 'internal_error', 'The request could not be completed.');
    if (!response.destroyed && !response.headersSent) {
      sendJson(response, safeError.status, { error: { code: safeError.code, message: safeError.message } }, safeError.closeConnection);
    } else if (!response.destroyed) {
      response.destroy();
    }
  }
}

export function createApiServer() {
  const server = createHttpServer((request, response) => {
    void handleRequest(request, response).catch(() => response.destroy());
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 65_000;
  return server;
}

export function startServer() {
  const server = createApiServer();
  server.on('error', () => {
    console.error('Could not start the local physics-lab server on port 3001.');
    process.exitCode = 1;
  });
  server.listen(PORT, '127.0.0.1', () => {
    console.log('Physics lab server listening on http://127.0.0.1:3001');
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) startServer();
