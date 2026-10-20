import { z } from 'zod';
import { validateDecision } from './scene.ts';
import { ReviewProposalSchema, validateLabOutcome, type LabOutcome } from './review-proposal.ts';
import { HarnessProgressSchema } from './harness.ts';

const ProgressSchema = HarnessProgressSchema.extend({
  type: z.literal('progress'),
  stage: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
});
const AssistantSchema = z.strictObject({
  type: z.literal('assistant'),
  text: z.string().min(1).max(32000),
});
export type AssemblyProgress = z.infer<typeof HarnessProgressSchema>;
const MAX_BYTES = 1024 * 1024;

function responseError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function failure(value: unknown, status: number): Error {
  const parsed = z.object({ error: z.object({ message: z.string().max(4000), code: z.string().max(80).optional() }) }).safeParse(value);
  return responseError(parsed.success ? parsed.data.error.code ?? 'assembly_service_error' : 'assembly_service_error', parsed.success ? parsed.data.error.message : `The assembly service returned HTTP ${status}.`);
}

export async function readAssemblyResponse(
  response: Response,
  onProgress: (progress: AssemblyProgress) => void,
  onAssistant?: (text: string) => void,
): Promise<LabOutcome> {
  if (!response.headers.get('content-type')?.includes('application/x-ndjson')) {
    let value: unknown;
    try { value = await response.json(); }
    catch { throw responseError('assembly_invalid_response', 'The lab returned an unreadable response. Your message and previous experiment are preserved.'); }
    if (!response.ok) throw failure(value, response.status);
    try { return validateLabOutcome(value); }
    catch { throw responseError('assembly_invalid_response', 'The lab returned an invalid experiment. Your previous experiment is preserved.'); }
  }
  if (!response.ok || !response.body) throw responseError('assembly_connection_lost', 'The assembly service could not start a response.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  let bytes = 0;
  let outcome: LabOutcome | null = null;
  const consume = (line: string) => {
    if (!line.trim()) return;
    if (outcome) throw responseError('assembly_invalid_response', 'The assembly service sent data after its completed result.');
    const value: unknown = JSON.parse(line);
    if (typeof value !== 'object' || value === null || !('type' in value)) throw responseError('assembly_invalid_response', 'The assembly service returned an invalid progress record.');
    if (value.type === 'progress') {
      const { type: _type, ...progress } = ProgressSchema.parse(value);
      const known = HarnessProgressSchema.safeParse(progress);
      onProgress(known.success ? known.data : { ...progress, stage: 'generating' });
    } else if (value.type === 'assistant') {
      onAssistant?.(AssistantSchema.parse(value).text);
    } else if (value.type === 'decision') {
      const record = z.strictObject({ type: z.literal('decision'), decision: z.unknown() }).parse(value);
      outcome = validateDecision(record.decision);
    } else if (value.type === 'proposal') {
      const record = z.strictObject({ type: z.literal('proposal'), proposal: ReviewProposalSchema }).parse(value);
      outcome = record.proposal;
    } else if (value.type === 'error') {
      throw failure(value, response.status);
    } else {
      throw responseError('assembly_invalid_response', 'The assembly service returned an unknown progress record.');
    }
  };
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BYTES) throw responseError('assembly_response_too_large', 'The assembly response exceeded its size limit.');
      pending += decoder.decode(chunk.value, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf('\n')) !== -1) {
        consume(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
    }
    pending += decoder.decode();
    consume(pending);
    if (!outcome) throw responseError('assembly_connection_lost', 'The assembly connection ended before a complete lab outcome arrived.');
    return outcome;
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) throw responseError('assembly_invalid_response', 'The lab sent an invalid response record. Your message and previous experiment are preserved.');
    if (error instanceof TypeError) throw responseError('assembly_connection_lost', 'The connection to the lab was interrupted before completion. Your previous experiment is preserved.');
    throw error;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
