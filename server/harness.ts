import type { Api, Context, Model } from '@earendil-works/pi-ai';
import { getCurrentTools, normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { z } from 'zod';
import { HARNESS_MAX_TURNS, HARNESS_MAX_TOOL_CALLS, HARNESS_TIMEOUT_MS, HarnessProgressSchema, HarnessRequestSchema, ModelPurposeSchema, type HarnessProgress, type HarnessRequest, type ModelPurpose } from '../shared/harness.ts';
import { formatHarnessFailure, HarnessFailureSchema } from '../shared/harness-failure.ts';
import { InlineSceneImageSchema, MAX_JPEG_BASE64, MAX_JPEG_BYTES, MAX_VISUAL_CALLS_PER_RUN, MAX_VISUAL_FRAMES_PER_RUN } from '../shared/visual-inspection.ts';
import { VerificationReceiptSchema, type VerificationReceipt } from '../shared/verification.ts';
import { validateDecision } from '../shared/scene.ts';
import { ReviewProposalSchema, type LabOutcome } from '../shared/review-proposal.ts';
import { MAX_MODEL_TEXT_CHARS } from '../shared/model-text.ts';
import { resolveLabModel, providerKey, ProviderError, streamLabModel } from './providers.ts';
import { runSandbox, SandboxError, type SandboxRun } from './sandbox.ts';
import { InspectionRequestSchema } from '../shared/inspection-rpc.ts';
import { renderScene } from './renderer-client.ts';
const TextSchema = z.object({ type: z.literal('text'), text: z.string().max(MAX_MODEL_TEXT_CHARS) }).passthrough();
const ImageSchema = InlineSceneImageSchema.refine(({ data }) => {
  if (data.length < 8 || data.length > MAX_JPEG_BASE64 || data.length % 4 !== 0) return false;
  const bytes = Buffer.from(data, 'base64');
  return bytes.length <= MAX_JPEG_BYTES && bytes.toString('base64') === data
    && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
});
const ImageContentSchema = z.union([TextSchema, ImageSchema]);
const ToolNameSchema = z.enum(['inspect_catalog', 'calculate', 'check_experiment', 'finish_experiment', 'submit_review', 'inspect_scene']);
const ToolSchema = z.object({ name: ToolNameSchema, description: z.string(), parameters: z.record(z.string(), z.json()) });
const ContentSchema = z.array(z.union([
  TextSchema,
  z.object({ type: z.literal('thinking'), thinking: z.string() }).passthrough(),
  z.object({ type: z.literal('toolCall'), id: z.string(), name: z.string().max(100), arguments: z.record(z.string(), z.json()) }).passthrough(),
]));
const ToolResultSchema = z.object({
  role: z.literal('toolResult'), toolCallId: z.string(), toolName: z.string(),
  content: z.array(ImageContentSchema), isError: z.boolean(), timestamp: z.number(),
}).superRefine((message, context) => {
  if (message.toolName !== 'inspect_scene' && message.content.some(block => block.type === 'image')) {
    context.addIssue({ code: 'custom', path: ['content'], message: 'Only scene inspection results may contain images.' });
  }
});
const ContextSchema = z.object({ messages: z.array(z.discriminatedUnion('role', [
  z.object({ role: z.literal('system'), content: z.union([z.string(), z.array(TextSchema)]), toolsAdded: z.array(ToolSchema).optional(), toolsRemoved: z.array(z.object({ name: ToolNameSchema })).optional(), timestamp: z.number() }).passthrough(),
  z.object({ role: z.literal('user'), content: z.union([z.string(), z.array(ImageContentSchema)]), timestamp: z.number() }),
  z.object({ role: z.literal('assistant'), content: ContentSchema, timestamp: z.number() }).passthrough(),
  ToolResultSchema,
])).min(1).max(100) });
export function validateModelContext(value: unknown, model: Pick<Model<Api>, 'input'>, purpose: ModelPurpose): Context {
  const context = ContextSchema.parse(value) as Context;
  const tools = getCurrentTools(context.messages);
  if (tools.length === 0 || (purpose === 'reviewer'
    ? tools.length !== 1 || tools[0]?.name !== 'submit_review'
    : tools.some(tool => tool.name === 'submit_review'))) {
    throw new ProviderError('lab_tool_scope', 'The isolated assistant requested model access outside its declared lab-tool role.', 502);
  }
  const visionContent = context.messages.some(message => {
    if (message.role === 'system') return message.toolsAdded?.some(tool => tool.name === 'inspect_scene') ?? false;
    if (message.role === 'assistant') return message.content.some(block => block.type === 'toolCall' && block.name === 'inspect_scene');
    if (message.role === 'toolResult') return message.toolName === 'inspect_scene' || message.content.some(block => block.type === 'image');
    return message.role === 'user' && Array.isArray(message.content) && message.content.some(block => block.type === 'image');
  });
  if (visionContent && !model.input.includes('image')) throw new z.ZodError([{ code: 'custom', path: ['messages'], message: 'This model does not support visual inspection.' }]);
  return context as Context;
}
const RecordSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('model'), id: z.number().int().positive(), purpose: ModelPurposeSchema, context: z.unknown() }),
  HarnessProgressSchema.extend({ type: z.literal('progress') }),
  InspectionRequestSchema,
  z.strictObject({ type: z.literal('decision'), decision: z.unknown(), verification: VerificationReceiptSchema.optional() }),
  z.strictObject({ type: z.literal('proposal'), proposal: ReviewProposalSchema }),
  HarnessFailureSchema,
]);
let activeRuns = 0;

export async function runLab(request: HarnessRequest, onProgress: (event: HarnessProgress) => void, onAssistant: (text: string) => void, signal: AbortSignal): Promise<LabOutcome> {
  request = HarnessRequestSchema.parse(request);
  const capacity = process.env.LAB_WORKER_URL ? 1 : 2;
  if (activeRuns >= capacity) throw new ProviderError('lab_busy', 'The lab is checking another experiment. Wait for it to finish before starting another.', 503);
  activeRuns++;
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(HARNESS_TIMEOUT_MS)]);
  const failure = Promise.withResolvers<never>();
  // The rejection is always consumed by Promise.race, including synchronous launch failures.
  void failure.promise.catch(() => {});
  let calls = 0;
  let toolCalls = 0;
  let toolCallLimit = HARNESS_MAX_TOOL_CALLS;
  let pending = false;
  let inspectionCalls = 0;
  let inspectionFrames = 0;
  let lastModelPurpose: ModelPurpose | undefined;
  let assistantBytes = 0;
  let outcome: LabOutcome | null = null;
  let sandbox: SandboxRun | undefined;
  let workerFailureLogged = false;
  let lastStage: HarnessProgress['stage'] = 'starting';
  let lastRole: ModelPurpose | undefined;
  const progress = (stage: HarnessProgress['stage'], message: string, role?: ModelPurpose, verification?: VerificationReceipt) => {
    lastStage = stage;
    if (role) lastRole = role;
    onProgress({
      stage, message, ...(role ? { role } : {}),
      ...(verification ? { verification } : {}),
      budget: { modelRequests: calls, modelRequestLimit: HARNESS_MAX_TURNS, toolCalls, toolCallLimit },
    });
  };
  const fail = (error: unknown) => {
    failure.reject(error);
    controller.abort();
  };
  try {
    progress('starting', 'Starting your isolated physics assistant. Lab tools only; shell, host files and network access are denied.');
    const model = await resolveLabModel(request.provider, request.model, combined);
    const credential = await providerKey(request.provider, combined);
    combined.throwIfAborted();
    const brokerInspection = Boolean(process.env.LAB_RENDERER_URL) && model.input.includes('image');
    sandbox = runSandbox({ type: 'init', request, model, brokerInspection }, value => {
      try {
        if (outcome) throw new Error('Unexpected output after the final experiment.');
        const record = RecordSchema.parse(value);
        if (record.type === 'model') {
          if (pending || record.id !== calls + 1 || calls >= HARNESS_MAX_TURNS) throw new ProviderError('lab_limit', 'The assistant reached the model-turn limit. Your current scene is unchanged.', 502);
          const context = validateModelContext(record.context, model, record.purpose);
          calls++;
          lastModelPurpose = record.purpose;
          pending = true;
          const stage = record.purpose === 'reviewer' ? 'reviewing' : 'generating';
          const task = record.purpose === 'reviewer' ? 'Reviewing' : 'Working with';
          progress(stage, `${task} ${request.model} · model request ${calls} of ${HARNESS_MAX_TURNS}.`, record.purpose);
          // Pi adds its normalization brand after the boundary validates model-scoped content.
          void streamLabModel(request.provider, model, normalizeContext(context), combined, event => {
            combined.throwIfAborted();
            if (record.purpose === 'builder' && event.type === 'text_delta' && event.delta) {
              assistantBytes += Buffer.byteLength(event.delta);
              if (assistantBytes > 32000) throw new ProviderError('lab_limit', 'The assistant exceeded its conversation output limit.', 502);
              for (let at = 0; at < event.delta.length;) {
                let end = Math.min(at + 2000, event.delta.length);
                const last = event.delta.charCodeAt(end - 1);
                if (end < event.delta.length && last >= 0xd800 && last <= 0xdbff) end--;
                onAssistant(event.delta.slice(at, end));
                at = end;
              }
            }
            // Keep SDK lifecycle bookends, not quadratic growing partial snapshots, across the isolated pipe.
            if (event.type === 'start' || event.type === 'done' || event.type === 'error') sandbox!.send({ type: 'model_event', id: record.id, event });
          }, credential, record.purpose === 'reviewer' ? 'submit_review' : 'any').then(() => { pending = false; }).catch(fail);
        } else if (record.type === 'inspection') {
          if (!brokerInspection || lastModelPurpose !== 'builder' || pending) throw new ProviderError('lab_tool_scope', 'The assistant requested image inspection outside its declared role.', 502);
          if (record.id !== inspectionCalls + 1 || inspectionCalls >= MAX_VISUAL_CALLS_PER_RUN
            || inspectionFrames + record.request.times.length > MAX_VISUAL_FRAMES_PER_RUN) {
            throw new ProviderError('lab_limit', 'The image inspection allowance was exceeded.', 502);
          }
          inspectionCalls++;
          inspectionFrames += record.request.times.length;
          pending = true;
          void renderScene({ scene: record.scene, request: record.request }, combined).then(frames => {
            combined.throwIfAborted();
            for (const frame of frames) ImageSchema.parse(frame.image);
            pending = false;
            sandbox!.send({ type: 'inspection_result', id: record.id, status: 'ok', frames });
          }).catch(error => {
            pending = false;
            if (combined.aborted) { fail(error); return; }
            sandbox!.send({ type: 'inspection_result', id: record.id, status: 'error', message: 'The private scene renderer could not complete this inspection.' });
          });
        } else if (record.type === 'progress') {
          if (record.budget) {
            toolCalls = record.budget.toolCalls;
            toolCallLimit = record.budget.toolCallLimit;
          }
          progress(record.stage, record.message, record.role);
        }
        else if (record.type === 'decision') {
          const decision = validateDecision(record.decision);
          if ((decision.kind === 'scene') !== (record.verification !== undefined)) {
            throw new ProviderError('lab_protocol_error', 'The isolated assistant returned invalid verification for its accepted decision.', 502);
          }
          outcome = decision;
          progress(lastStage, 'The lab assistant completed its decision.', lastRole, record.verification);
        }
        else if (record.type === 'proposal') {
          outcome = record.proposal;
          progress(lastStage, 'The lab assistant completed a checked proposal for your review.', lastRole, record.proposal.verification);
        }
        else {
          toolCalls = record.toolCalls;
          progress(lastStage, 'The assistant stopped its bounded lab run.', lastRole);
          if (!workerFailureLogged) {
            workerFailureLogged = true;
            console.error('Physics lab worker failure', {
              code: record.code,
              stage: record.stage,
              modelTurns: record.modelTurns,
              toolCalls: record.toolCalls,
            });
          }
          throw new ProviderError(record.code, formatHarnessFailure(record), 502);
        }
      } catch (error) { fail(error instanceof ProviderError ? error : new ProviderError('lab_protocol_error', 'The isolated assistant returned an invalid lab response. Your scene is unchanged.', 502)); }
    }, combined);
    await Promise.race([sandbox.done, failure.promise]);
    if (!outcome) throw new ProviderError('lab_incomplete', 'The assistant ended before completing a checked experiment. Your draft and current preview are preserved.', 502);
    return outcome;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (signal.aborted) throw new ProviderError('lab_canceled', 'The lab assistant was stopped. Your draft and scene are preserved.', 499);
    if (combined.aborted) throw new ProviderError('lab_timeout', 'The assistant reached its four-minute run limit. Your draft and current scene are preserved.', 504);
    if (error instanceof SandboxError) {
      if (error.code === 'sandbox_timeout') throw new ProviderError('lab_timeout', error.message, 504);
      const unavailable = error.code === 'docker_unavailable' || error.code === 'sandbox_image_missing'
        || error.code === 'sandbox_start_failed' || error.code === 'sandbox_resource_limit'
        || error.code === 'worker_unavailable' || error.code === 'worker_busy' || error.code === 'worker_auth_failed';
      const guidance = error.code === 'sandbox_image_missing' ? ' Run npm run sandbox:build before retrying.' : '';
      throw new ProviderError(error.code, `${error.message}${guidance} Your draft and previous scene are preserved. No unsandboxed fallback is used.`, unavailable ? 503 : 502);
    }
    if (error instanceof z.ZodError) throw new ProviderError('lab_protocol_error', 'The assistant returned an invalid internal request or progress record. Your draft and previous scene are preserved.', 502);
    throw new ProviderError('internal_error', 'The lab assistant stopped unexpectedly. Your draft and previous scene are preserved.', 500);
  } finally {
    controller.abort();
    sandbox?.stop();
    if (sandbox) await sandbox.done.catch(() => {});
    activeRuns--;
  }
}
