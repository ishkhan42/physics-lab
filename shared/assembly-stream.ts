import { z } from 'zod';
import { validateDecision, type Decision } from './scene.ts';

const ProgressSchema = z.strictObject({
  type: z.literal('progress'),
  stage: z.enum(['generating', 'validating', 'repairing', 'retrying']),
  message: z.string().min(1).max(2000),
});
export type AssemblyProgress = Omit<z.infer<typeof ProgressSchema>, 'type'>;
const MAX_BYTES = 1024 * 1024;

function failure(value: unknown, status: number): Error {
  const parsed = z.object({ error: z.object({ message: z.string().max(4000), code: z.string().max(80).optional() }) }).safeParse(value);
  return Object.assign(new Error(parsed.success ? parsed.data.error.message : `The assembly service returned HTTP ${status}.`), { code: parsed.success ? parsed.data.error.code : undefined });
}

export async function readAssemblyResponse(response: Response, onProgress: (progress: AssemblyProgress) => void): Promise<Decision> {
  if (!response.headers.get('content-type')?.includes('application/x-ndjson')) {
    const value: unknown = await response.json();
    if (!response.ok) throw failure(value, response.status);
    return validateDecision(value);
  }
  if (!response.ok || !response.body) throw new Error('The assembly service could not start a response.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  let bytes = 0;
  let decision: Decision | null = null;
  const consume = (line: string) => {
    if (!line.trim()) return;
    if (decision) throw new Error('The assembly service sent data after its completed decision.');
    const value: unknown = JSON.parse(line);
    if (typeof value !== 'object' || value === null || !('type' in value)) throw new Error('The assembly service returned an invalid progress record.');
    if (value.type === 'progress') {
      const { type: _type, ...progress } = ProgressSchema.parse(value);
      onProgress(progress);
    } else if (value.type === 'decision' && 'decision' in value) {
      decision = validateDecision(value.decision);
    } else if (value.type === 'error') {
      throw failure(value, response.status);
    } else {
      throw new Error('The assembly service returned an unknown progress record.');
    }
  };
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BYTES) throw new Error('The assembly response exceeded its size limit.');
      pending += decoder.decode(chunk.value, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf('\n')) !== -1) {
        consume(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
    }
    pending += decoder.decode();
    consume(pending);
    if (!decision) throw new Error('The assembly connection ended before a complete model decision arrived.');
    return decision;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
