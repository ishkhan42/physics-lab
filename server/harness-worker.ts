import { createInterface } from 'node:readline';
import { Agent, type AgentTool, type AgentToolResult, type StreamFn } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import type { AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream, Model, Api } from '@earendil-works/pi-ai';
import { Type, type TSchema } from 'typebox';
import { z } from 'zod';
import { calculate } from '../shared/calculations.ts';
import type { Decision, Scene } from '../shared/scene.ts';
import { ASSEMBLY_INSTRUCTIONS } from '../shared/catalog.ts';
import { AssemblyDecisionSchema, AssemblyDecisionJsonSchema, parseAssemblyDecision, bodyCapacity } from '../shared/assembly-input.ts';
import { modelTextContent } from '../shared/model-text.ts';
import { HarnessRequestSchema, HARNESS_MAX_TURNS, HARNESS_MAX_TOOL_CALLS, HARNESS_REVIEW_MAX_TURNS, type HarnessProgress, type ModelPurpose } from '../shared/harness.ts';
import { VERIFICATION_SECONDS, VerificationReceiptSchema, type VerificationReceipt } from '../shared/verification.ts';
import { createRuntime } from '../src/physics/mujoco.ts';
import { advanceNativeCheckTo, NATIVE_CHECK_WALL_BUDGET_MS } from '../src/physics/native-check.ts';
import type { InspectionSnapshot } from '../src/physics/types.ts';
import { auditSceneStructure, captureStateCheckpoint, createMotionTracker, measureDeclaredLaunchProperties, measureJointGeometry, measureNativeBoxBounds, measureTendonGeometry } from '../src/physics/evidence.ts';
import { compactInspection, toModelTable } from '../src/physics/model-evidence.ts';
import { HarnessFailureIssueSchema, makeHarnessFailure, formatHarnessFailure, type HarnessFailureCode, type HarnessFailureContext, type HarnessFailureIssue } from '../shared/harness-failure.ts';
import { reviewExperiment, ReviewUnusableError, type ModelReview } from './harness-review.ts';
import { ReviewProposalConcernSchema, ReviewProposalSchema, type ReviewProposal } from '../shared/review-proposal.ts';
import { captureScene } from './scene-inspector.ts';
import { INSPECTION_FPS, MAX_INSPECTION_FRAMES, MAX_VISUAL_CALLS_PER_RUN, MAX_VISUAL_FRAMES_PER_RUN, VisualFrameSchema, VisualInspectionRequestSchema, type VisualFrame, type VisualInspectionRequest } from '../shared/visual-inspection.ts';
import { withLabResources } from './lab-resources.ts';

const MAX_DECISION_JSON_CHARS = 524288;
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const streams = new Map<number, AssistantMessageEventStream>();
let initialized = false;
let sequence = 0;
const failureContext: HarnessFailureContext = { stage: 'initializing', modelTurns: 0, toolCalls: 0 };
let lastIssue: HarnessFailureIssue | undefined;
let lastFailureCode: HarnessFailureCode | undefined;
let progressPurpose: ModelPurpose = 'builder';
let capacityBlockedRequest = false;
let canInspectImages = false;
let visualCalls = 0;
let visualFrameCount = 0;
const sendProgress = (stage: HarnessProgress['stage'], message: string, purpose = progressPurpose) => send({
  type: 'progress', stage, message, role: purpose,
  budget: { modelRequests: sequence, modelRequestLimit: HARNESS_MAX_TURNS, toolCalls: failureContext.toolCalls, toolCallLimit: HARNESS_MAX_TOOL_CALLS },
});
function failedStream(model: Model<Api>, message: string): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const error: AssistantMessage = {
    role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'error', errorMessage: message, timestamp: Date.now(),
  };
  stream.push({ type: 'error', reason: 'error', error });
  stream.end();
  return stream;
}
const streamFor = (purpose: ModelPurpose): StreamFn => (model, context) => {
  progressPurpose = purpose;
  const hasCapacity = sequence < HARNESS_MAX_TURNS && (
    purpose === 'reviewer' || sequence + 1 + HARNESS_REVIEW_MAX_TURNS <= HARNESS_MAX_TURNS
  );
  if (!hasCapacity) {
    capacityBlockedRequest = true;
    const code = purpose === 'reviewer' ? 'review_unstarted' : lastFailureCode === 'review_rejected' ? 'review_rejected' : 'model_budget';
    failureContext.code = code;
    if (purpose === 'reviewer') lastFailureCode = code;
    if (purpose === 'builder' && sequence < HARNESS_MAX_TURNS && code === 'model_budget' && !lastIssue) {
      lastIssue = { path: '', code: 'review_capacity', message: `${HARNESS_REVIEW_MAX_TURNS} model requests remained reserved for independent review; no final candidate was submitted before the building allowance ended.` };
    }
    failureContext.stage = purpose === 'reviewer' || code === 'review_rejected' ? 'reviewing' : 'planning';
    sendProgress(purpose === 'reviewer' || code === 'review_rejected' ? 'reviewing' : 'generating', 'The remaining bounded request capacity cannot admit another model request.', purpose);
    return failedStream(model, code === 'review_rejected' ? 'The rejected experiment could not be repaired within the remaining request budget.' : 'The model request budget is exhausted.');
  }
  capacityBlockedRequest = false;
  const id = ++sequence;
  failureContext.modelTurns = sequence;
  failureContext.stage = purpose === 'reviewer' ? 'reviewing' : 'planning';
  const stream = createAssistantMessageEventStream();
  streams.set(id, stream);
  if (purpose === 'reviewer') sendProgress('reviewing', 'Requesting an independent verdict within the remaining bounded capacity.', purpose);
  const resourceContext = withLabResources(context, purpose, {
    modelRequests: sequence, labActions: failureContext.toolCalls, inspectionCalls: visualCalls,
    imageAttempts: visualFrameCount, canInspectImages,
  });
  send({ type: 'model', id, purpose, context: resourceContext });
  return stream;
};
const result = (value: unknown, terminate = false) => ({ content: modelTextContent(JSON.stringify(value)), details: undefined, terminate });

function endWithRecord(record: unknown, exitCode: number) {
  process.stdout.write(`${JSON.stringify(record)}\n`, () => process.exit(exitCode));
}

function sceneCheckKey(decision: Decision): string {
  return JSON.stringify([decision.kind, decision.scene], (key, value) =>
    key === 'title' || key === 'label' || key === 'color' || key === 'appearance' || key === 'visual' ? undefined : value);
}
type WorkerResult = { decision: Decision; verification?: VerificationReceipt } | { proposal: ReviewProposal };

async function inspectInitialState(scene: Scene) {
  const runtime = await createRuntime(scene);
  try {
    const snapshot = runtime.snapshot();
    return {
      phase: 'initial-before-scheduled-actions',
      state: compactInspection(snapshot),
      boxBounds: toModelTable(measureNativeBoxBounds(runtime)),
      joints: measureJointGeometry(runtime),
      tendons: measureTendonGeometry(runtime, snapshot),
    };
  } finally { runtime.dispose(); }
}

async function run(input: unknown): Promise<WorkerResult> {
  const init = z.strictObject({ type: z.literal('init'), request: HarnessRequestSchema, model: z.custom<Model<Api>>() }).parse(input);
  canInspectImages = init.model.input.includes('image');
  visualCalls = 0;
  visualFrameCount = 0;
  capacityBlockedRequest = false;
  let currentInitialState: InspectionSnapshot | null = null;
  let currentStateIssue: unknown = null;
  if (init.request.currentScene) {
    try {
      const current = await createRuntime(init.request.currentScene);
      try { currentInitialState = current.snapshot(); }
      finally { current.dispose(); }
    } catch (error) {
      currentStateIssue = makeHarnessFailure(error, { ...failureContext, code: 'physics_check_failed' });
      sendProgress('repairing', 'The previous setup needs correction; the assistant can rebuild it from your request.');
    }
  }
  let completed: Decision | null = null;
  let completedVerification: VerificationReceipt | null = null;
  let checked: { sceneKey: string; decision: Decision; report: unknown; verification: VerificationReceipt | null } | null = null;
  let lastRejectedProposal: ReviewProposal | null = null;
  const failedChecks = new Map<string, unknown>();
  const checkScene = async (decision: Decision, sceneKey: string) => {
    if (checked?.sceneKey === sceneKey) return { ...checked, decision };
    let report: unknown = { kind: decision.kind };
    let verification: VerificationReceipt | null = null;
    if (decision.kind === 'scene') {
      sendProgress('simulating', 'Testing the motion and scheduled actions.');
      const deadline = performance.now() + NATIVE_CHECK_WALL_BUDGET_MS;
      const runtime = await createRuntime(decision.scene);
      try {
        const scene = decision.scene;
        const initial = runtime.snapshot();
        const initialJointGeometry = measureJointGeometry(runtime);
        const initialTendonGeometry = measureTendonGeometry(runtime, initial);
        const initialBoxBounds = measureNativeBoxBounds(runtime);
        const motion = createMotionTracker(runtime);
        motion.sample();
        const stateCheckpoints = [captureStateCheckpoint('Initial', runtime, motion.report())];
        const readEventStates = (snapshot: typeof initial) => {
          const states = snapshot.events ?? [];
          if (states.length !== scene.events.length) throw new Error('The runtime did not report every scheduled action state.');
          return new Map(states.map(state => [state.id, state]));
        };
        const initialStates = readEventStates(initial);
        for (const event of scene.events) {
          const state = initialStates.get(event.id);
          if (!state || state.status !== 'pending' || state.firedAt !== null) {
            throw new Error(`Scheduled action ${event.id} changed before the first physics step.`);
          }
        }
        const sampledSeconds = [initial.time];
        let lastProgressAt = performance.now();
        await advanceNativeCheckTo(runtime, VERIFICATION_SECONDS, deadline, runtime.scene.bodies.length, () => motion.sample(), simulatedSeconds => {
          const now = performance.now();
          if (now - lastProgressAt < 1000) return;
          lastProgressAt = now;
          sendProgress('simulating', `Checking motion · ${simulatedSeconds.toFixed(3)} of ${VERIFICATION_SECONDS.toFixed(3)} simulated seconds.`);
        });
        const observed = runtime.snapshot();
        stateCheckpoints.push(captureStateCheckpoint(`After ${VERIFICATION_SECONDS} s requested (${observed.time.toFixed(3)} s actual)`, runtime, motion.report()));
        const states = readEventStates(observed);
        for (const event of scene.events) {
          const state = states.get(event.id);
          if (!state) throw new Error(`The runtime omitted scheduled action ${event.id}.`);
          if (state.status === 'completed') {
            if (state.firedAt === null || state.firedAt < event.at || state.firedAt > observed.time) {
              throw new Error(`Scheduled action ${event.id} reported an invalid execution time.`);
            }
          } else if (event.at <= observed.time) {
            throw new Error(`Scheduled action ${event.id} was not completed by its warm-up checkpoint.`);
          }
        }
        if (sampledSeconds[sampledSeconds.length - 1] !== observed.time) sampledSeconds.push(observed.time);
        const checkpoints = [{ requestedSeconds: VERIFICATION_SECONDS, simulatedSeconds: observed.time }];
        const final = runtime.snapshot();
        const pending = (final.events ?? []).some(event => event.status === 'pending');
        verification = VerificationReceiptSchema.parse({ checkedThroughSeconds: final.time });
        report = {
          bodyCapacity: bodyCapacity(scene),
          simulatedSeconds: final.time,
          testedHorizonSeconds: final.time,
          sampledSeconds,
          checkpoints,
          stateCheckpoints: stateCheckpoints.map(checkpoint => ({ ...checkpoint, bodies: toModelTable(checkpoint.bodies) })),
          declaredLaunchProperties: measureDeclaredLaunchProperties(scene),
          initialBoxBounds: toModelTable(initialBoxBounds),
          structure: auditSceneStructure(scene),
          motion: toModelTable(motion.report()),
          initialJointGeometry,
          finalJointGeometry: measureJointGeometry(runtime),
          initialTendonGeometry,
          finalTendonGeometry: measureTendonGeometry(runtime, final),
          initial: compactInspection(initial),
          final: compactInspection(final),
          chronologyLimit: 'Only the paused initial and warm-up-end states are sampled; motion between them can include scheduled actions and impacts, so the warm-up does not establish unsampled contact timing. Box AABBs are world bounds, not an exact collision test.',
          limit: `Actual simulation horizon: ${final.time} seconds. ${pending ? 'Some scheduled actions remain pending at this time and were not exercised.' : 'All declared scheduled actions completed within this warm-up.'} This short physics warm-up is not proof of future outcomes or long-term stability.`,
        };
      } finally { runtime.dispose(); }
    }
    checked = { sceneKey, decision, report, verification };
    return checked;
  };
  const recordCheckFailure = (error: unknown, sceneKey?: string): never => {
    const failure = makeHarnessFailure(error, failureContext);
    if (sceneKey) failedChecks.set(sceneKey, error);
    lastIssue = failure.lastIssue ?? { path: '', code: failure.code, message: failure.message };
    lastFailureCode = failure.code;
    throw new Error(formatHarnessFailure(failure));
  };

  const parseDecision = (input: unknown) => {
    failureContext.stage = 'checking';
    sendProgress('validating', 'Checking geometry, materials, references and physical constraints.');
    try { return parseAssemblyDecision(input); }
    catch (error) { return recordCheckFailure(error); }
  };
  const checkDecision = async (decision: Decision) => {
    failureContext.stage = 'checking';
    const sceneKey = sceneCheckKey(decision);
    if (failedChecks.has(sceneKey)) {
      sendProgress('validating', 'Reusing the previous failed check for this unchanged setup; revise the physical model before checking it again.');
      return recordCheckFailure(failedChecks.get(sceneKey));
    }
    try { return await checkScene(decision, sceneKey); }
    catch (error) { return recordCheckFailure(error, sceneKey); }
  };
  const consumeTool = (reserve = 0, purpose = progressPurpose) => {
    if (failureContext.toolCalls + 1 + reserve > HARNESS_MAX_TOOL_CALLS) {
      failureContext.code = 'tool_budget';
      return false;
    }
    failureContext.toolCalls++;
    sendProgress(purpose === 'reviewer' ? 'reviewing' : 'validating', 'The lab tool allowance now includes this admitted operation.', purpose);
    return true;
  };
  const decisionSchema = Type.Unsafe<z.input<typeof AssemblyDecisionSchema>>({
    ...AssemblyDecisionJsonSchema,
    description: `Complete decision object, limited to ${MAX_DECISION_JSON_CHARS} compact serialized characters.`,
  } as TSchema);
  const parameters = Type.Object({ decision: decisionSchema }, { additionalProperties: false });
  const calculationOperand = Type.Union([
    Type.Number({ description: 'A finite numeric value.' }),
    Type.Object({ ref: Type.String({ pattern: '^[A-Za-z][A-Za-z0-9_-]{0,63}$', description: 'The ID of an earlier step.' }) }, { additionalProperties: false }),
    Type.Object({ constant: Type.Literal('pi') }, { additionalProperties: false }),
  ]);
  const calculationParameters = Type.Object({
    steps: Type.Array(Type.Object({
      id: Type.String({ minLength: 1, maxLength: 64, pattern: '^[A-Za-z][A-Za-z0-9_-]{0,63}$' }),
      operation: Type.Union([
        Type.Literal('add'), Type.Literal('subtract'), Type.Literal('multiply'), Type.Literal('divide'),
        Type.Literal('sqrt'), Type.Literal('hypot'), Type.Literal('sin'), Type.Literal('cos'), Type.Literal('tan'),
        Type.Literal('atan2'), Type.Literal('pow'), Type.Literal('deg_to_rad'), Type.Literal('rad_to_deg'),
      ]),
      args: Type.Array(calculationOperand, { maxItems: 8, description: 'Arity: add, subtract, multiply, divide, atan2 and pow take 2; sqrt, trig and degree conversions take 1; hypot takes 1–8. atan2 takes y then x.' }),
    }, { additionalProperties: false }), { minItems: 1, maxItems: 32 }),
  }, { additionalProperties: false });
  const DecisionInputSchema = z.unknown()
    .refine(input => input !== undefined, 'A decision object is required.')
    .superRefine((input, context) => {
      let length = Number.POSITIVE_INFINITY;
      try {
        const json = JSON.stringify(input);
        if (json !== undefined) length = json.length;
      } catch {
        length = Number.POSITIVE_INFINITY;
      }
      if (length > MAX_DECISION_JSON_CHARS) {
        context.addIssue({ code: 'custom', message: `Decision exceeds ${MAX_DECISION_JSON_CHARS} serialized characters.` });
      }
    });
  const DecisionArgumentsSchema = z.strictObject({ decision: DecisionInputSchema });
  const FinishArgumentsSchema = DecisionArgumentsSchema.extend({ reviewResponse: z.string().trim().min(1).max(1600).optional() });
  const VisualInspectionArgumentsSchema = VisualInspectionRequestSchema.extend({ decision: DecisionInputSchema });
  const parseToolArguments = <T extends z.ZodType>(schema: T, args: unknown): z.output<T> => {
    const parsed = schema.safeParse(args);
    if (!parsed.success) {
      failureContext.stage = 'checking';
      sendProgress('validating', 'Checking geometry, materials, references and physical constraints.');
      return recordCheckFailure(parsed.error);
    }
    return parsed.data;
  };
  let terminalReviewFailure = false;
  let terminalToolFailure = false;
  const preparedFinishes = new Map<string, { input: z.infer<typeof FinishArgumentsSchema>; decision: Decision }>();
  let terminalModelFailure = false;
  const finishPreflightMessages = new WeakSet<object>();
  const finishIndexes = new WeakMap<object, { index: number; scene: boolean }>();
  let previousReview: ModelReview | null = null;
  let visualSceneKey: string | null = null;
  let visualFrames: VisualFrame[] = [];
  let lastVisualRequest: { key: string; frames: VisualFrame[] } | null = null;
  const sceneVisualKey = (decision: Extract<Decision, { kind: 'scene' }>) =>
    JSON.stringify(decision.scene, (name, value) => name === 'title' || name === 'label' ? undefined : value);
  const framesFor = (decision: Extract<Decision, { kind: 'scene' }>) => {
    const key = sceneVisualKey(decision);
    if (key !== visualSceneKey) {
      visualSceneKey = key;
      visualFrames = [];
      lastVisualRequest = null;
    }
    return visualFrames;
  };
  const inspect = async (decision: Extract<Decision, { kind: 'scene' }>, request: VisualInspectionRequest) => {
    if (!canInspectImages) throw new Error('The selected model cannot inspect images.');
    framesFor(decision);
    const requestKey = JSON.stringify(request);
    if (lastVisualRequest?.key === requestKey) return lastVisualRequest.frames;
    if (visualCalls >= MAX_VISUAL_CALLS_PER_RUN || visualFrameCount + request.frames.length > MAX_VISUAL_FRAMES_PER_RUN) {
      lastFailureCode = 'tool_budget';
      lastIssue = { path: '', code: 'visual_budget', message: 'The bounded visual-inspection allowance is exhausted.' };
      throw new Error('The visual-inspection allowance is exhausted.');
    }
    sendProgress('inspecting', 'Inspecting actual rendered frames, not a schematic or guessed preview.');
    visualCalls++;
    visualFrameCount += request.frames.length;
    try {
      const captureRequest = { times: request.frames.map(frame => frame / INSPECTION_FPS), view: request.view, focusId: request.focusId };
      const frames = z.array(VisualFrameSchema).min(1).max(MAX_INSPECTION_FRAMES).parse(await captureScene(decision.scene, captureRequest));
      if (frames.length !== request.frames.length) throw new Error('The renderer did not return every requested frame.');
      visualFrames.push(...frames);
      visualFrames.sort((a, b) => a.simulatedAt - b.simulatedAt || a.requestedAt - b.requestedAt);
      lastVisualRequest = { key: requestKey, frames };
      return frames;
    } catch (error) {
      const failure = makeHarnessFailure(error, { ...failureContext, code: 'visual_check_failed' });
      lastFailureCode = failure.code;
      lastIssue = failure.lastIssue ?? { path: '', code: failure.code, message: failure.message };
      throw new Error(formatHarnessFailure(failure));
    }
  };
  const ensureVisualEvidence = async (decision: Extract<Decision, { kind: 'scene' }>) => {
    if (!canInspectImages) return [];
    const reviewFrames = [0, VERIFICATION_SECONDS * INSPECTION_FPS];
    const missing = reviewFrames.filter(frame => !framesFor(decision).some(image =>
      image.view === 'overview' && image.focusedId === null && image.requestedAt === frame / INSPECTION_FPS));
    const remaining = MAX_VISUAL_FRAMES_PER_RUN - visualFrameCount;
    const count = Math.min(remaining, MAX_INSPECTION_FRAMES, missing.length);
    if (visualCalls >= MAX_VISUAL_CALLS_PER_RUN || count < 1) {
      if (missing.length) sendProgress('reviewing', 'The screenshot allowance is used; checking this revision against measured physics without new images.');
      return framesFor(decision);
    }
    if (!consumeTool()) throw new Error('The lab tool budget is exhausted.');
    await inspect(decision, VisualInspectionRequestSchema.parse({ frames: missing.slice(0, count) }));
    return framesFor(decision);
  };
  const prepareFinish = (args: unknown) => {
    try {
      const input = FinishArgumentsSchema.parse(args);
      return { input, decision: parseAssemblyDecision(input.decision) };
    } catch { return null; }
  };
  const preflightReview = (decision: Decision, pendingToolCalls = 0) => {
    if (decision.kind !== 'scene') return true;
    const frames = sceneVisualKey(decision) === visualSceneKey ? visualFrames : [];
    const reviewFrames = [0, VERIFICATION_SECONDS * INSPECTION_FPS];
    const missing = reviewFrames.some(frame => !frames.some(image =>
      image.view === 'overview' && image.focusedId === null && image.requestedAt === frame / INSPECTION_FPS));
    const needsScreenshot = canInspectImages && missing && visualCalls < MAX_VISUAL_CALLS_PER_RUN && visualFrameCount < MAX_VISUAL_FRAMES_PER_RUN;
    const modelCapacity = sequence + HARNESS_REVIEW_MAX_TURNS <= HARNESS_MAX_TURNS;
    const toolCapacity = failureContext.toolCalls + pendingToolCalls + HARNESS_REVIEW_MAX_TURNS + Number(needsScreenshot) <= HARNESS_MAX_TOOL_CALLS;
    if (modelCapacity && toolCapacity) return true;
    terminalReviewFailure = true;
    failureContext.stage = 'reviewing';
    failureContext.code = 'review_unstarted';
    if (lastFailureCode !== 'review_rejected') {
      const reason = !modelCapacity && !toolCapacity
        ? 'Two independent-review model requests and the required review tools were unavailable.'
        : !modelCapacity
          ? 'Two independent-review model requests were unavailable.'
          : 'The remaining lab-tool budget could not reserve two review calls and any required screenshot.';
      lastIssue = { path: '', code: 'review_capacity', message: reason };
    }
    lastFailureCode = 'review_unstarted';
    sendProgress('reviewing', 'Independent review could not start within the remaining bounded capacity.', 'builder');
    return false;
  };
  const preflightTurnFinish = (assistantMessage: AssistantMessage) => {
    if (finishPreflightMessages.has(assistantMessage)) return true;
    finishPreflightMessages.add(assistantMessage);
    const toolCalls = assistantMessage.content.filter((item): item is Extract<AssistantMessage['content'][number], { type: 'toolCall' }> => item.type === 'toolCall');
    const index = toolCalls.findIndex(call => call.name === 'finish_experiment');
    if (index < 0) return true;
    const call = toolCalls[index]!;
    const prepared = prepareFinish(call.arguments);
    if (prepared?.decision.kind === 'scene' && !preflightReview(prepared.decision, index + 1)) return false;
    if (prepared) preparedFinishes.set(call.id, prepared);
    finishIndexes.set(assistantMessage, { index, scene: prepared?.decision.kind === 'scene' });
    return true;
  };
  const tools: AgentTool[] = [
    { name: 'inspect_catalog', label: 'Inspect physics catalog', description: 'Read the authoritative decision schema and supported bodies, materials, forces and constraints as a reference. No filesystem or network access.', parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => {
        sendProgress('catalog', 'Consulting the lab’s supported bodies, materials, forces and constraints.');
        return result({ schema: AssemblyDecisionJsonSchema, bodyCapacity: bodyCapacity(init.request.currentScene), coordinates: 'SI units; Z up; arrays for tuples; generated scalar joint positions zero; event times are seconds, with actual firedAt and snapshot notes exposing native-step timing precision. Grid inputs expand into separate physical bodies before validation.' });
      } },
    { name: 'calculate', label: 'Calculate', description: 'Use for numeric work instead of mental arithmetic, especially trigonometry, vector components, lengths and trajectory arithmetic. Trig inputs are radians; use deg_to_rad or rad_to_deg explicitly. Batches contain up to 32 named steps and may reference only earlier steps or the explicit pi constant.', parameters: calculationParameters,
      execute: async (_id, args) => result(calculate(args)) },
    { name: 'check_experiment', label: 'Check experiment', description: 'Validate and run the native initial checks and a 0.5-second physics warm-up. Reports the initial state, actual warm-up horizon, and pending/completed scheduled actions. Actions scheduled later remain pending, not failed or exercised; this short check is not proof of future outcomes or long-term stability.', parameters,
      execute: async (_id, args) => {
        const decision = parseDecision(parseToolArguments(DecisionArgumentsSchema, args).decision);
        return result((await checkDecision(decision)).report);
      } },
    { name: 'finish_experiment', label: 'Prepare checked preview', description: 'Validate, physically check and independently review the final scene. On rejection, correct the model or use reviewResponse to explain an evidence-backed rebuttal; the next review considers both. No approval override or identical-copy step.', parameters: Type.Object({
      ...parameters.properties,
      reviewResponse: Type.Optional(Type.String({ minLength: 1, maxLength: 1600, description: 'After rejection, briefly state the correction or cite native measurements/conventions that refute the finding. This is untrusted review context, not approval.' })),
    }, { additionalProperties: false }),
      execute: async (_id, args) => {
        const prepared = preparedFinishes.get(_id);
        preparedFinishes.delete(_id);
        const input = prepared?.input ?? parseToolArguments(FinishArgumentsSchema, args);
        const decision = prepared?.decision ?? parseDecision(input.decision);
        sendProgress('validating', 'Checking geometry, materials, references and physical constraints.');
        if (decision.kind === 'scene' && !preflightReview(decision)) {
          throw new Error('The independent review could not start because its bounded model or lab-tool capacity was unavailable.');
        }
        const accepted = await checkDecision(decision);
        if (accepted.decision.kind === 'scene') {
          const frames = await ensureVisualEvidence(accepted.decision);
          failureContext.stage = 'reviewing';
          sendProgress('reviewing', 'Checking that the actual mechanism and motion match your request.', 'reviewer');
          try {
            const review = await reviewExperiment(init.model, streamFor('reviewer'), init.request, accepted.decision, accepted.report, () => consumeTool(0, 'reviewer'), frames, previousReview ? { previousFindings: previousReview.findings, builderResponse: input.reviewResponse ?? null } : null);
            sendProgress('reviewing', review.approved ? 'The independent reviewer approved this checked scene.' : 'The independent reviewer found a mismatch that needs correction.', 'reviewer');
            if (!review.approved) {
              previousReview = review;
              const finding = review.findings.find(item => item.severity === 'error')!;
              const issue = HarnessFailureIssueSchema.safeParse({ path: '', code: finding.code, message: finding.message.slice(0, 240) });
              lastIssue = issue.success ? issue.data : { path: '', code: finding.code, message: 'The proposed mechanism does not yet match your request.' };
              const concerns = review.findings.flatMap(item => {
                if (item.severity !== 'error') return [];
                const concern = ReviewProposalConcernSchema.safeParse({ code: item.code, message: item.message.slice(0, 240) });
                return [concern.success ? concern.data : { code: item.code, message: 'The assistant could not confirm this part of the requested setup.' }];
              });
              const proposal = accepted.verification ? ReviewProposalSchema.safeParse({
                kind: 'proposal', decision: accepted.decision, verification: accepted.verification, concerns,
              }) : null;
              lastRejectedProposal = proposal?.success ? proposal.data : null;
              lastFailureCode = 'review_rejected';
              return result({ accepted: false, reviewRequired: true, findings: review.findings, report: accepted.report,
                next: 'Correct the concrete mismatch, or refute an incorrect finding with native measurements and authoritative conventions. Finish with reviewResponse explaining the change or rebuttal; approval still requires independent review.' });
            }
            previousReview = null;
            lastRejectedProposal = null;
            lastFailureCode = undefined;
            lastIssue = undefined;
          } catch (error) {
            terminalReviewFailure = true;
            const code = error instanceof ReviewUnusableError ? 'review_unusable' : failureContext.code ?? 'review_failed';
            const failure = makeHarnessFailure(error, { ...failureContext, code });
            if (!previousReview) lastIssue = failure.lastIssue ?? { path: '', code: failure.code, message: failure.message };
            lastFailureCode = failure.code;
            sendProgress('reviewing', failure.code === 'review_unusable' ? 'The independent reviewer did not submit a usable verdict within its bounded attempts.' : 'Independent review stopped before producing a usable verdict.', 'reviewer');
            throw new Error(formatHarnessFailure(failure));
          }
        }
        if (accepted.decision.kind === 'scene' && !accepted.verification) throw new Error('The accepted scene has no complete native verification receipt.');
        completed = accepted.decision;
        completedVerification = accepted.verification;
        return result({ accepted: true }, true);
      } },
  ];
  if (canInspectImages) tools.push({
    name: 'inspect_scene', label: 'Inspect rendered scene',
    description: 'Inspect actual rendered geometry by elapsed 60 Hz frame. Frame indices may be any nonnegative safe integer; the renderer advances native physics forward to the requested time. Default frame is 0. Diagnostic images do not approve physics; finish still requires the 0.5-second native warm-up and independent review. At most2 calls/4 image attempts total and3 frames per call. No URLs, files or code.',
    parameters: Type.Object({
      decision: decisionSchema,
      frames: Type.Optional(Type.Array(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }), { minItems: 1, maxItems: MAX_INSPECTION_FRAMES, default: [0] })),
      view: Type.Optional(Type.Union([Type.Literal('overview'), Type.Literal('front'), Type.Literal('side'), Type.Literal('top')])),
      focusId: Type.Optional(Type.Union([Type.String({ maxLength: 64 }), Type.Null()])),
    }, { additionalProperties: false }),
    execute: async (_id, args): Promise<AgentToolResult> => {
      const input = parseToolArguments(VisualInspectionArgumentsSchema, args);
      const candidate = parseDecision(input.decision);
      if (candidate.kind !== 'scene') throw new Error('Visual inspection requires a scene.');
      const initialDiagnostics = await inspectInitialState(candidate.scene).catch(error => recordCheckFailure(error, sceneCheckKey(candidate)));
      const { decision: _decision, ...request } = input;
      const frames = await inspect(candidate, request);
      const content: AgentToolResult['content'] = modelTextContent(JSON.stringify({
        renderer: 'actual Physics Lab renderer',
        remainingImages: MAX_VISUAL_FRAMES_PER_RUN - visualFrameCount,
        remainingInspectionCalls: MAX_VISUAL_CALLS_PER_RUN - visualCalls,
        initialDiagnostics,
        frames: frames.map(({ image: _image, ...metadata }) => metadata),
      }));
      for (const frame of frames) {
        content.push({ type: 'text', text: `Rendered ${frame.view} at actual ${frame.simulatedAt}s; requested ${frame.requestedAt}s; focus ${frame.focusedId ?? 'whole scene'}.` });
        content.push(frame.image);
      }
      return { content, details: undefined };
    },
  });
  const agent = new Agent({
    initialState: { systemPrompt: ASSEMBLY_INSTRUCTIONS + (canInspectImages ? '\nVISUAL INSPECTION: inspect_scene is available because this model accepts images. It takes elapsed 60 Hz frame indices, defaults to frame0, and permits any nonnegative safe-integer frame while native stability and the 45-second capture deadline permit. Independent-review evidence targets unfocused overview images at initial time0 and warm-up end0.5 as the remaining call and image allowance permits. Review actual images for framing, visible geometry, and motion; numerical validity alone is not visual quality. Images are diagnostic only: finish still requires the complete 0.5-second native warm-up and independent review. The per-request resource status gives authoritative calls and frame attempts remaining; economize within those counts. Text/metadata-only edits reuse physical checks; visual/color changes need fresh current images. Never claim an unavailable or stale image.' : '\nThis selected model is text-only or has no advertised image support. No visual inspection tool or image inputs are available. Do not claim to have seen screenshots.'), model: init.model, tools, thinkingLevel: 'off' },
    streamFn: streamFor('builder'),
    toolExecution: 'sequential',
    beforeToolCall: async ({ assistantMessage, toolCall, args }) => {
      progressPurpose = 'builder';
      if (completed) return { block: true, reason: 'The final experiment has already been submitted.', terminate: true };
      if (terminalReviewFailure || terminalToolFailure) return { block: true, reason: 'The bounded experiment run has ended.', terminate: true };
      if (!preflightTurnFinish(assistantMessage)) return { block: true, reason: 'Independent review could not start within the remaining bounded capacity.', terminate: true };
      const toolCalls = assistantMessage.content.filter((item): item is Extract<AssistantMessage['content'][number], { type: 'toolCall' }> => item.type === 'toolCall');
      const callIndex = toolCalls.findIndex(call => call.id === toolCall.id);
      const finish = finishIndexes.get(assistantMessage);
      if (toolCall.name === 'finish_experiment') {
        if (finish && callIndex !== finish.index) return { block: true, reason: 'Submit one final experiment per model response.', terminate: true };
        if (!preparedFinishes.has(toolCall.id)) {
          const prepared = prepareFinish(args);
          if (prepared?.decision.kind === 'scene' && !preflightReview(prepared.decision, 1)) return { block: true, reason: 'Independent review could not start within the remaining bounded capacity.', terminate: true };
          if (prepared) preparedFinishes.set(toolCall.id, prepared);
        }
      }
      const beforeReservedFinish = finish !== undefined && callIndex <= finish.index;
      const screenshotReserve = canInspectImages && visualCalls < MAX_VISUAL_CALLS_PER_RUN && visualFrameCount < MAX_VISUAL_FRAMES_PER_RUN ? 1 : 0;
      const reserve = beforeReservedFinish ? 0 : 1 + HARNESS_REVIEW_MAX_TURNS + screenshotReserve;
      if (!consumeTool(reserve)) {
        terminalToolFailure = true;
        if (lastFailureCode === 'review_rejected') failureContext.code = 'review_rejected';
        else if (failureContext.toolCalls < HARNESS_MAX_TOOL_CALLS) {
          lastIssue = { path: '', code: 'review_capacity', message: 'Lab-tool calls were held for the final scene check, its screenshot allowance when available, and independent review.' };
        }
        return { block: true, reason: 'The lab tool budget is exhausted while preserving independent-review capacity.', terminate: true };
      }
    },
    finishTurn: ({ message }) => {
      if (message.stopReason === 'aborted' || (message.stopReason === 'error' && !capacityBlockedRequest)) terminalModelFailure = true;
      if (completed || terminalReviewFailure || terminalToolFailure || capacityBlockedRequest || sequence >= HARNESS_MAX_TURNS || failureContext.toolCalls >= HARNESS_MAX_TOOL_CALLS || terminalModelFailure) return { action: 'end' };
      return { action: 'continue' };
    },
  });
  agent.subscribe(event => {
    if (event.type === 'turn_start') failureContext.stage = 'planning';
    if (event.type === 'tool_execution_end' && event.isError && !terminalReviewFailure && !terminalToolFailure) sendProgress('repairing', 'The lab found a problem. The assistant can revise the setup using the actual validation feedback.', 'builder');
  });
  failureContext.stage = 'planning';
  await agent.prompt({ role: 'user', content: modelTextContent(JSON.stringify({ request: init.request, bodyCapacity: bodyCapacity(init.request.currentScene), currentInitialState, currentStateIssue })), timestamp: Date.now() });
  if (!completed) {
    const reviewCapacityExhausted = capacityBlockedRequest || terminalToolFailure || sequence >= HARNESS_MAX_TURNS || failureContext.toolCalls >= HARNESS_MAX_TOOL_CALLS;
    if (lastFailureCode === 'review_rejected' && lastRejectedProposal && reviewCapacityExhausted
      && !terminalReviewFailure && !terminalModelFailure) {
      failureContext.stage = 'finishing';
      return { proposal: lastRejectedProposal };
    }
    const reviewOutcome = lastFailureCode === 'review_unstarted' || lastFailureCode === 'review_unusable' || lastFailureCode === 'review_rejected' ? lastFailureCode : undefined;
    failureContext.code ??= reviewOutcome ?? (sequence >= HARNESS_MAX_TURNS ? 'model_budget' : failureContext.toolCalls >= HARNESS_MAX_TOOL_CALLS ? 'tool_budget' : lastFailureCode ?? 'internal');
    throw new Error('No checked experiment was completed.');
  }
  failureContext.stage = 'finishing';
  return { decision: completed, verification: completedVerification ?? undefined };
}

lines.on('line', line => {
  try {
    if (Buffer.byteLength(line) > 2 * 1024 * 1024) throw new Error('Protocol limit exceeded.');
    const value = JSON.parse(line);
    if (!initialized) {
      initialized = true;
      void run(value).then(result => endWithRecord(
        'proposal' in result
          ? { type: 'proposal', proposal: result.proposal }
          : { type: 'decision', decision: result.decision, ...(result.verification ? { verification: result.verification } : {}) },
        0,
      )).catch(error => {
        const failure = makeHarnessFailure(error, failureContext);
        if (lastIssue) failure.lastIssue = lastIssue;
        endWithRecord(failure, 1);
      });
    } else {
      const record = z.object({ type: z.literal('model_event'), id: z.number().int().positive(), event: z.custom<AssistantMessageEvent>() }).parse(value);
      const stream = streams.get(record.id);
      if (!stream) throw new Error('Unknown model stream.');
      stream.push(record.event);
      if (record.event.type === 'done' || record.event.type === 'error') streams.delete(record.id);
    }
  } catch (error) {
    endWithRecord(makeHarnessFailure(error, { ...failureContext, code: 'protocol' }), 1);
  }
});
