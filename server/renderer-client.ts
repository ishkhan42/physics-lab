import { GoogleAuth, type IdTokenClient } from 'google-auth-library';
import { z } from 'zod';
import { INSPECTION_RPC_TIMEOUT_MS, InspectionPayloadSchema, type InspectionPayload } from '../shared/inspection-rpc.ts';
import { validateScene } from '../shared/scene.ts';
import { MAX_INSPECTION_FRAMES, VisualFrameSchema, type VisualFrame } from '../shared/visual-inspection.ts';

const auth = new GoogleAuth();
const ResponseSchema = z.strictObject({ frames: z.array(VisualFrameSchema).min(1).max(MAX_INSPECTION_FRAMES) });
let identityClient: { origin: string; promise: Promise<IdTokenClient> } | undefined;

export async function renderScene(input: InspectionPayload, signal: AbortSignal): Promise<VisualFrame[]> {
  const payload = InspectionPayloadSchema.parse(input);
  payload.scene = validateScene(payload.scene);
  signal.throwIfAborted();
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(INSPECTION_RPC_TIMEOUT_MS - 5_000)]);
  const canceled = Promise.withResolvers<never>();
  const onAbort = () => canceled.reject(deadline.reason);
  deadline.addEventListener('abort', onAbort, { once: true });
  try {
    const origin = new URL(process.env.LAB_RENDERER_URL || '');
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
      throw new Error('Invalid private renderer origin.');
    }
    if (!identityClient || identityClient.origin !== origin.origin) {
      const pending = { origin: origin.origin, promise: auth.getIdTokenClient(origin.origin) };
      identityClient = pending;
      void pending.promise.catch(() => { if (identityClient === pending) identityClient = undefined; });
    }
    const client = await Promise.race([identityClient.promise, canceled.promise]);
    deadline.throwIfAborted();
    const headers = await Promise.race([client.getRequestHeaders(), canceled.promise]);
    headers.set('content-type', 'application/json');
    const response = await fetch(new URL('/capture', origin), {
      method: 'POST', headers, body: JSON.stringify(payload), signal: deadline, redirect: 'error',
    });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('Renderer unavailable.'); }
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > 1024 * 1024) throw new Error('Renderer response exceeded its allowance.');
      chunks.push(chunk);
    }
    const { frames } = ResponseSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    const times = [...payload.request.times].sort((a, b) => a - b);
    if (frames.length !== times.length || frames.some((frame, index) => frame.requestedAt !== times[index] || frame.view !== payload.request.view)) {
      throw new Error('Renderer response did not match its requested frames.');
    }
    signal.throwIfAborted();
    return frames;
  } catch {
    signal.throwIfAborted();
    throw new Error('Scene inspection is temporarily unavailable. The current experiment is unchanged.');
  } finally { deadline.removeEventListener('abort', onAbort); }
}
