import { createServer, type IncomingMessage, type Server as HTTPServer, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { EXPERIMENT_EXAMPLES } from '../shared/examples.ts';
import { InspectionPayloadSchema } from '../shared/inspection-rpc.ts';
import { INSPECTION_TIMEOUT_MS, INSPECTION_HEIGHT, INSPECTION_WIDTH, MAX_INSPECTION_FRAMES, VisualFrameSchema, type VisualFrame } from '../shared/visual-inspection.ts';
import { validateScene, type Scene } from '../shared/scene.ts';
import { captureScene } from './scene-inspector.ts';

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const shutdowns = new WeakMap<HTTPServer, () => Promise<void>>();

type ErrorCode = 'invalid_path' | 'not_found' | 'method_not_allowed' | 'invalid_request' | 'unsupported_media_type'
  | 'payload_too_large' | 'invalid_utf8' | 'invalid_json' | 'invalid_payload' | 'invalid_scene' | 'busy'
  | 'shutting_down' | 'capture_failed' | 'internal_error';
type ActiveCapture = { controller: AbortController; done: Promise<void>; startedAt: number };

class GatewayFailure extends Error {
  readonly status: number;
  readonly code: ErrorCode;

  constructor(status: number, code: ErrorCode, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  if (response.destroyed || response.writableEnded) return;
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': String(body.byteLength),
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  response.end(body);
}

function sendError(response: ServerResponse, status: number, code: ErrorCode, message: string, headers?: Record<string, string>): void {
  sendJson(response, status, { error: { code, message } }, { connection: 'close', ...headers });
}

async function readPayload(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers['content-type'];
  if (!contentType || !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test(contentType.trim())) {
    request.resume();
    throw new GatewayFailure(415, 'unsupported_media_type', 'Content-Type must be application/json with UTF-8 encoding.');
  }
  const declaredLength = request.headers['content-length'];
  if (declaredLength !== undefined && Number(declaredLength) > MAX_REQUEST_BYTES) {
    request.resume();
    throw new GatewayFailure(413, 'payload_too_large', 'Request body exceeds 2 MiB.');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (bytes.byteLength > MAX_REQUEST_BYTES - size) {
        request.resume();
        throw new GatewayFailure(413, 'payload_too_large', 'Request body exceeds 2 MiB.');
      }
      size += bytes.byteLength;
      chunks.push(bytes);
    }
  } catch (error) {
    if (error instanceof GatewayFailure) throw error;
    throw new GatewayFailure(400, 'invalid_json', 'Request body could not be read.');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size));
  } catch {
    throw new GatewayFailure(400, 'invalid_utf8', 'Request body must be valid UTF-8.');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new GatewayFailure(400, 'invalid_json', 'Request body is not valid JSON.');
  }
}

async function handleCapture(request: IncomingMessage, response: ServerResponse, isShuttingDown: () => boolean,
  getActive: () => ActiveCapture | null,
  setActive: (value: ActiveCapture | null) => void, onCleanupFailure: () => void): Promise<void> {
  let raw: unknown;
  try {
    raw = await readPayload(request);
  } catch (error) {
    if (error instanceof GatewayFailure) sendError(response, error.status, error.code, error.message);
    else sendError(response, 500, 'internal_error', 'Request could not be processed.');
    return;
  }
  let payload: z.infer<typeof InspectionPayloadSchema>;
  try {
    payload = InspectionPayloadSchema.parse(raw);
  } catch {
    sendError(response, 400, 'invalid_payload', 'Request payload is invalid.');
    return;
  }
  let scene: Scene;
  try {
    scene = validateScene(payload.scene);
  } catch {
    sendError(response, 400, 'invalid_scene', 'Scene fails semantic validation.');
    return;
  }
  if (response.destroyed) return;
  if (isShuttingDown()) {
    sendError(response, 503, 'shutting_down', 'Renderer is shutting down.');
    return;
  }
  if (getActive()) {
    sendError(response, 503, 'busy', 'Renderer is busy.');
    return;
  }

  const controller = new AbortController();
  const completion = Promise.withResolvers<void>();
  const active: ActiveCapture = { controller, done: completion.promise, startedAt: performance.now() };
  setActive(active);
  const cancelIfDisconnected = () => {
    if (!response.writableEnded && !controller.signal.aborted) controller.abort();
  };
  request.once('aborted', cancelIfDisconnected);
  response.once('close', cancelIfDisconnected);
  let cleanupFailed = false;
  try {
    const rawFrames = await captureScene(scene, payload.request, controller.signal);
    const frames = z.array(VisualFrameSchema).min(1).max(MAX_INSPECTION_FRAMES).parse(rawFrames);
    if (frames.length !== payload.request.times.length) throw new Error('Renderer frame count did not match the request.');
    sendJson(response, 200, { frames });
  } catch (error) {
    cleanupFailed = error instanceof AggregateError;
    sendError(response, 500, 'capture_failed', 'Scene capture failed.');
  } finally {
    request.off('aborted', cancelIfDisconnected);
    response.off('close', cancelIfDisconnected);
    if (cleanupFailed) onCleanupFailure();
    else setActive(null);
    completion.resolve();
  }
}

export function createRenderGateway(): HTTPServer {
  let shuttingDown = false;
  let activeCapture: ActiveCapture | null = null;
  let shutdownPromise: Promise<void> | null = null;
  const server = createServer((request, response) => {
    const target = request.url;
    if (target?.includes('?')) {
      request.resume();
      sendError(response, 400, 'invalid_path', 'Query strings are not accepted.');
      return;
    }
    if (target !== '/' && target !== '/capture') {
      request.resume();
      sendError(response, 404, 'not_found', 'Route not found.');
      return;
    }
    if (target === '/') {
      if (request.method !== 'GET') {
        request.resume();
        sendError(response, 405, 'method_not_allowed', 'Method not allowed.', { allow: 'GET' });
        return;
      }
      if (request.headers['transfer-encoding'] || Number(request.headers['content-length'] ?? '0') > 0) {
        request.resume();
        sendError(response, 400, 'invalid_request', 'Health requests must not include a body.');
        return;
      }
      const unhealthy = shuttingDown || (activeCapture !== null && performance.now() - activeCapture.startedAt > INSPECTION_TIMEOUT_MS + 30_000);
      sendJson(response, unhealthy ? 503 : 200, { status: unhealthy ? 'unhealthy' : 'ok' });
      return;
    }
    if (request.method !== 'POST') {
      request.resume();
      sendError(response, 405, 'method_not_allowed', 'Method not allowed.', { allow: 'POST' });
      return;
    }
    if (shuttingDown) {
      request.resume();
      sendError(response, 503, 'shutting_down', 'Renderer is shutting down.');
      return;
    }
    if (activeCapture) {
      request.resume();
      sendError(response, 503, 'busy', 'Renderer is busy.');
      return;
    }
    void handleCapture(request, response, () => shuttingDown, () => activeCapture,
      value => { activeCapture = value; }, () => { shuttingDown = true; })
      .catch(() => sendError(response, 500, 'internal_error', 'Request could not be processed.'));
  });

  shutdowns.set(server, () => {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    const active = activeCapture;
    active?.controller.abort();
    const closed = Promise.withResolvers<void>();
    server.close(error => error ? closed.reject(error) : closed.resolve());
    server.closeAllConnections();
    shutdownPromise = (async () => {
      await closed.promise;
      await active?.done;
    })();
    return shutdownPromise;
  });
  return server;
}

export function shutdownRenderGateway(server: HTTPServer): Promise<void> {
  const shutdown = shutdowns.get(server);
  if (!shutdown) return Promise.reject(new Error('Server was not created by createRenderGateway.'));
  return shutdown();
}

async function runRendererGateway(): Promise<void> {
  const portValue = process.env.PORT ?? '8080';
  const port = Number(portValue);
  if (!/^\d{1,5}$/.test(portValue) || port < 1 || port > 65_535) {
    console.error('Renderer gateway has an invalid PORT and did not start.');
    process.exitCode = 1;
    return;
  }
  const startupController = new AbortController();
  let server: HTTPServer | null = null;
  let gatewayListening = false;
  const shutdown = () => {
    if (!server || !gatewayListening) {
      startupController.abort();
      return;
    }
    void shutdownRenderGateway(server).catch(() => {
      console.error('Renderer gateway shutdown failed.');
      process.exitCode = 1;
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  const scene = EXPERIMENT_EXAMPLES[0]?.setups[0]?.document.scene;
  if (!scene) {
    console.error('Renderer startup check failed; service did not start.');
    process.exitCode = 1;
    return;
  }
  let frame: VisualFrame;
  try {
    const frames = z.array(VisualFrameSchema).min(1).max(1).parse(await captureScene(scene, {
      times: [0], view: 'overview', focusId: null,
    }, startupController.signal));
    const checked = frames[0];
    if (!checked || checked.width !== INSPECTION_WIDTH || checked.height !== INSPECTION_HEIGHT) {
      throw new Error('Renderer startup dimensions did not match.');
    }
    frame = checked;
  } catch (error) {
    if (startupController.signal.aborted && !(error instanceof AggregateError)) return;
    console.error('Renderer startup check failed; service did not start.');
    process.exitCode = 1;
    return;
  }
  if (startupController.signal.aborted) return;
  console.log(`Renderer startup check passed: ${frame.width}x${frame.height}.`);

  const gateway = createRenderGateway();
  server = gateway;
  try {
    await new Promise<void>((resolveListening, rejectListening) => {
      const onListening = () => {
        gateway.off('error', onError);
        resolveListening();
      };
      const onError = (error: Error) => {
        gateway.off('listening', onListening);
        rejectListening(error);
      };
      gateway.once('listening', onListening);
      gateway.once('error', onError);
      gateway.listen(port, '0.0.0.0');
    });
  } catch {
    if (!startupController.signal.aborted) {
      console.error('Renderer gateway failed to listen; service did not start.');
      process.exitCode = 1;
    }
    return;
  }
  gatewayListening = true;
  if (startupController.signal.aborted) {
    try { await shutdownRenderGateway(gateway); }
    catch {
      console.error('Renderer gateway shutdown failed.');
      process.exitCode = 1;
    }
    return;
  }
  gateway.on('error', () => {
    console.error('Renderer gateway failed.');
    process.exitCode = 1;
    shutdown();
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void runRendererGateway().catch(() => {
    console.error('Renderer gateway startup failed; service did not start.');
    process.exitCode = 1;
  });
}
