import { isUtf8 } from 'node:buffer';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { WebSocket, WebSocketServer } from 'ws';
import { InspectionResultSchema } from '../shared/inspection-rpc.ts';
import { HarnessRequestSchema } from '../shared/harness.ts';
import { ProviderSchema } from '../shared/scene.ts';
import { runDockerSandbox, SandboxError, type SandboxFailureCode, type SandboxRun } from './sandbox.ts';

const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_SOCKET_BUFFER_BYTES = 1024 * 1024;
const SOCKET_CLOSE_TIMEOUT_MS = 5_000;
const PROVIDER_TARGETS: Record<z.infer<typeof ProviderSchema>, { api: string; baseUrl: string }> = {
  openai: { api: 'openai-responses', baseUrl: 'https://api.openai.com/v1' },
  anthropic: { api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com' },
  openrouter: { api: 'openai-completions', baseUrl: 'https://openrouter.ai/api/v1' },
  'openai-codex': { api: 'openai-codex-responses', baseUrl: 'https://chatgpt.com/backend-api' },
};
const FAILURE_CODES: Record<SandboxFailureCode, true> = {
  docker_unavailable: true, sandbox_image_missing: true, sandbox_start_failed: true, sandbox_resource_limit: true,
  sandbox_worker_failed: true, sandbox_protocol_failed: true, sandbox_input_limit: true, sandbox_output_limit: true,
  sandbox_io_failed: true, sandbox_timeout: true, worker_unavailable: true, worker_busy: true, worker_auth_failed: true,
};
const CostSchema = z.strictObject({
  input: z.number().finite().nonnegative(), output: z.number().finite().nonnegative(),
  cacheRead: z.number().finite().nonnegative(), cacheWrite: z.number().finite().nonnegative(),
  tiers: z.array(z.strictObject({
    input: z.number().finite().nonnegative(), output: z.number().finite().nonnegative(),
    cacheRead: z.number().finite().nonnegative(), cacheWrite: z.number().finite().nonnegative(),
    inputTokensAbove: z.number().finite().nonnegative(),
  })).optional(),
});
const ModelSchema = z.strictObject({
  id: z.string().min(1).max(200), name: z.string().min(1).max(500),
  api: z.string().min(1).max(100), provider: ProviderSchema, baseUrl: z.string().url(),
  input: z.array(z.enum(['text', 'image'])).min(1).max(2), inputLimits: z.json().optional(),
  cost: CostSchema, type: z.literal('chat').optional(), reasoning: z.boolean(),
  thinkingLevelMap: z.json().optional(), promptCache: z.json().optional(),
  contextWindow: z.number().int().positive().max(10_000_000), maxTokens: z.number().int().positive().max(10_000_000),
  samplingParamsByThinkingLevel: z.json().optional(), compat: z.json().optional(),
});
const InitSchema = z.strictObject({ type: z.literal('init'), request: HarnessRequestSchema, model: ModelSchema, brokerInspection: z.boolean().default(false) })
  .superRefine(({ request, model }, context) => {
    const target = PROVIDER_TARGETS[request.provider];
    if (model.provider !== request.provider || model.id !== request.model || model.api !== target.api || model.baseUrl !== target.baseUrl || !model.input.includes('text')) {
      context.addIssue({ code: 'custom', path: ['model'], message: 'The model does not match its declared provider and model.' });
    }
  });
const ModelEventSchema = z.object({ type: z.literal('model_event') }).passthrough();
const AUTH_SCHEME = 'Bearer ';
type CloseIntent = { code: number; reason: string };
type Session = {
  socket?: WebSocket;
  controller: AbortController;
  run?: SandboxRun;
  initialized: boolean;
  brokerInspection: boolean;
  workerSettled: boolean;
  socketClosed: boolean;
  released: boolean;
  closeSent: boolean;
  inputBytes: number;
  outputBytes: number;
  queue: string[];
  sending: boolean;
  closeIntent?: CloseIntent;
  closeTimer?: NodeJS.Timeout;
  initTimer?: NodeJS.Timeout;
  flushTimer?: NodeJS.Timeout;
  releaseWaiters: Array<() => void>;
};

function strongSecret(secret: string): boolean {
  return Buffer.byteLength(secret) >= 32 && /^[A-Za-z0-9._~+\/-]+={0,2}$/.test(secret)
    && new Set(secret.replace(/=+$/, '')).size >= 8;
}

function closeReason(error: unknown): string {
  return error instanceof SandboxError && Object.hasOwn(FAILURE_CODES, error.code) ? error.code : 'unavailable';
}

function rejectUpgrade(socket: Duplex, status: number, text: string, extraHeaders = ''): void {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n${extraHeaders}Content-Length: 0\r\n\r\n`);
}

export function createWorkerGateway({ secret }: { secret: string }): Server {
  if (!strongSecret(secret)) throw new Error('WORKER_AUTH_TOKEN must be a strong URL-safe token of at least 32 characters.');
  const expectedAuthorization = createHash('sha256').update(`${AUTH_SCHEME}${secret}`).digest();
  let active: Session | undefined;
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, skipUTF8Validation: true, perMessageDeflate: false });
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end('{"ready":true}');
      return;
    }
    response.writeHead(404, { 'content-length': '0', 'cache-control': 'no-store' });
    response.end();
  });

  const release = (session: Session) => {
    if (session.released || !session.socketClosed || !session.workerSettled) return;
    session.released = true;
    clearTimeout(session.closeTimer);
    clearTimeout(session.flushTimer);
    clearTimeout(session.initTimer);
    if (active === session) active = undefined;
    for (const waiter of session.releaseWaiters.splice(0)) waiter();
  };

  const maybeClose = (session: Session) => {
    const socket = session.socket;
    if (!socket || session.socketClosed || !session.workerSettled || !session.closeIntent) {
      release(session);
      return;
    }
    if (session.queue.length || session.sending) {
      flush(session);
      return;
    }
    if (socket.readyState !== WebSocket.OPEN) {
      if (socket.readyState === WebSocket.CLOSED) session.socketClosed = true;
      release(session);
      return;
    }
    if (socket.bufferedAmount > 0) {
      if (!session.flushTimer) session.flushTimer = setTimeout(() => { session.flushTimer = undefined; maybeClose(session); }, 10);
      return;
    }
    if (session.closeSent) return;
    session.closeSent = true;
    socket.close(session.closeIntent.code, session.closeIntent.reason);
    session.closeTimer = setTimeout(() => socket.terminate(), SOCKET_CLOSE_TIMEOUT_MS);
  };

  const requestStop = (session: Session, code: number, reason: string) => {
    session.closeIntent ??= { code, reason };
    clearTimeout(session.initTimer);
    if (!session.controller.signal.aborted) session.controller.abort();
    session.run?.stop();
    if (!session.run) session.workerSettled = true;
    maybeClose(session);
  };

  const flush = (session: Session) => {
    const socket = session.socket;
    if (!socket || session.socketClosed || socket.readyState !== WebSocket.OPEN || session.sending) return;
    const next = session.queue[0];
    if (!next) { maybeClose(session); return; }
    if (socket.bufferedAmount > MAX_SOCKET_BUFFER_BYTES) {
      if (!session.flushTimer) session.flushTimer = setTimeout(() => { session.flushTimer = undefined; flush(session); }, 10);
      return;
    }
    session.sending = true;
    try {
      socket.send(next, { compress: false }, error => {
        session.sending = false;
        if (session.queue[0] === next) {
          session.queue.shift();
        }
        if (error) {
          if (!session.closeIntent) requestStop(session, 1011, 'unavailable');
          else socket.terminate();
          return;
        }
        flush(session);
      });
    } catch {
      session.sending = false;
      requestStop(session, 1011, 'unavailable');
    }
  };

  const sendWorkerOutput = (session: Session, value: unknown) => {
    if (session.closeIntent || session.socketClosed) return;
    let payload: string | undefined;
    try { payload = JSON.stringify(value); } catch { requestStop(session, 1011, 'unavailable'); return; }
    if (payload === undefined) { requestStop(session, 1011, 'unavailable'); return; }
    const bytes = Buffer.byteLength(payload) + 1;
    if (session.outputBytes + bytes > MAX_OUTPUT_BYTES) {
      requestStop(session, 1011, 'sandbox_output_limit');
      return;
    }
    session.outputBytes += bytes;
    session.queue.push(payload);
    flush(session);
  };

  const settleWorker = (session: Session, error?: unknown) => {
    if (session.workerSettled) return;
    session.workerSettled = true;
    if (!session.closeIntent) session.closeIntent = error === undefined ? { code: 1000, reason: '' } : { code: 1011, reason: closeReason(error) };
    if (session.socket && !session.closeTimer) {
      session.closeTimer = setTimeout(() => session.socket?.terminate(), SOCKET_CLOSE_TIMEOUT_MS);
    }
    maybeClose(session);
  };

  const handleMessage = (session: Session, data: WebSocket.RawData, isBinary: boolean) => {
    if (session.closeIntent || session.socketClosed) return;
    if (isBinary) { requestStop(session, 1003, 'binary messages not supported'); return; }
    const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
    if (!isUtf8(bytes)) { requestStop(session, 1007, 'invalid UTF-8'); return; }
    if (session.inputBytes + bytes.length + 1 > MAX_INPUT_BYTES) { requestStop(session, 1009, 'input_limit'); return; }
    session.inputBytes += bytes.length + 1;
    let value: unknown;
    try { value = JSON.parse(bytes.toString('utf8')); }
    catch { requestStop(session, 1002, 'invalid JSON'); return; }

    if (!session.initialized) {
      const init = InitSchema.safeParse(value);
      if (!init.success) { requestStop(session, 1008, 'invalid init'); return; }
      session.brokerInspection = init.data.brokerInspection;
      session.initialized = true;
      clearTimeout(session.initTimer);
      session.workerSettled = false;
      try {
        const run = runDockerSandbox(init.data, message => sendWorkerOutput(session, message), session.controller.signal);
        session.run = run;
        void run.done.then(() => settleWorker(session), error => settleWorker(session, error));
      } catch (error) {
        settleWorker(session, error);
      }
      return;
    }

    const inspectionResult = InspectionResultSchema.safeParse(value);
    if (inspectionResult.success) {
      if (!session.brokerInspection) { requestStop(session, 1002, 'invalid message'); return; }
      try { session.run?.send(inspectionResult.data); }
      catch { requestStop(session, 1011, 'unavailable'); }
      return;
    }
    const modelEvent = ModelEventSchema.safeParse(value);
    if (!modelEvent.success) { requestStop(session, 1002, 'invalid message'); return; }
    try { session.run?.send(modelEvent.data); }
    catch { requestStop(session, 1011, 'unavailable'); }
  };

  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/run') { rejectUpgrade(socket, request.url?.startsWith('/run?') ? 400 : 404, request.url?.startsWith('/run?') ? 'Bad Request' : 'Not Found'); return; }
    if (request.headers.origin !== undefined) { rejectUpgrade(socket, 403, 'Forbidden'); return; }
    const authorization = request.headers.authorization;
    const suppliedAuthorization = typeof authorization === 'string'
      ? createHash('sha256').update(authorization).digest()
      : Buffer.alloc(expectedAuthorization.length);
    if (!timingSafeEqual(suppliedAuthorization, expectedAuthorization)) {
      rejectUpgrade(socket, 401, 'Unauthorized', 'WWW-Authenticate: Bearer\r\n');
      return;
    }
    if (active) { rejectUpgrade(socket, 503, 'Service Unavailable', 'Retry-After: 1\r\n'); return; }

    const session: Session = {
      controller: new AbortController(), initialized: false, workerSettled: true, socketClosed: false,
      brokerInspection: false, released: false, closeSent: false, inputBytes: 0, outputBytes: 0,
      queue: [], sending: false, releaseWaiters: [],
    };
    active = session;
    let upgraded = false;
    socket.once('close', () => {
      if (!upgraded) {
        session.socketClosed = true;
        release(session);
      }
    });
    try {
      websocketServer.handleUpgrade(request, socket, head, websocket => {
        upgraded = true;
        session.socket = websocket;
        session.initTimer = setTimeout(() => requestStop(session, 1008, 'init timeout'), 10_000);
        session.initTimer.unref();
        if (session.closeIntent) maybeClose(session);
        websocket.on('message', (data, isBinary) => {
          try { handleMessage(session, data, isBinary); }
          catch { requestStop(session, 1002, 'invalid message'); }
        });
        websocket.on('error', () => {
          if (!session.closeIntent) requestStop(session, 1002, 'websocket error');
        });
        websocket.on('close', () => {
          session.socketClosed = true;
          clearTimeout(session.closeTimer);
          clearTimeout(session.flushTimer);
          if (!session.closeIntent && !session.workerSettled) requestStop(session, 1001, 'disconnected');
          else if (!session.workerSettled) {
            if (!session.controller.signal.aborted) session.controller.abort();
            session.run?.stop();
          }
          release(session);
        });
        websocketServer.emit('connection', websocket, request);
      });
    } catch {
      session.socketClosed = true;
      requestStop(session, 1011, 'unavailable');
      socket.destroy();
    }
  });

  const close = server.close.bind(server);
  server.close = ((callback?: (error?: Error) => void) => {
    const session = active;
    if (session) requestStop(session, 1012, 'server shutdown');
    return close(error => {
      if (!callback) return;
      if (session && !session.released) session.releaseWaiters.push(() => callback(error));
      else callback(error);
    });
  }) as typeof server.close;
  return server;
}

function startWorkerGateway(): Server {
  const secret = process.env.WORKER_AUTH_TOKEN;
  if (!secret || !strongSecret(secret)) throw new Error('WORKER_AUTH_TOKEN must be set to a strong URL-safe token of at least 32 characters.');
  const portValue = process.env.PORT ?? '8081';
  if (!/^\d{1,5}$/.test(portValue)) throw new Error('PORT must be an integer between 1 and 65535.');
  const port = Number(portValue);
  if (port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535.');
  const server = createWorkerGateway({ secret });
  server.on('error', () => {
    console.error('Worker gateway could not listen.');
    process.exitCode = 1;
  });
  server.listen(port, '0.0.0.0');
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { startWorkerGateway(); }
  catch {
    console.error('Worker gateway requires a strong WORKER_AUTH_TOKEN and valid PORT.');
    process.exitCode = 1;
  }
}
