import { z } from 'zod';
import { HARNESS_MAX_TURNS, HARNESS_MAX_TOOL_CALLS, HARNESS_REVIEW_MAX_TURNS } from './harness.ts';

export const HARNESS_FAILURE_CODES = ['model_budget', 'tool_budget', 'malformed_json', 'invalid_schema', 'physics_check_failed', 'visual_check_failed', 'review_failed', 'review_unstarted', 'review_unusable', 'review_rejected', 'internal', 'protocol'] as const;
export const HARNESS_FAILURE_STAGES = ['initializing', 'planning', 'checking', 'inspecting', 'reviewing', 'finishing'] as const;
export const HARNESS_FAILURE_MAX_MODEL_TURNS = HARNESS_MAX_TURNS;
export const HARNESS_FAILURE_MAX_TOOL_CALLS = HARNESS_MAX_TOOL_CALLS;

export const HarnessFailureIssueSchema = z.strictObject({
  path: z.string().max(160).refine(value => value === '' || (/^(?:[A-Za-z][A-Za-z0-9_-]{0,63}|\[(?:\d{1,8}|field)\])(?:\[(?:\d{1,8})\]|\.(?:[A-Za-z][A-Za-z0-9_-]{0,63}|\[field\]))*$/.test(value) && !unsafeDiagnostic.test(`p${value}`))),
  code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  message: z.string().min(1).max(240).refine(value => safeDiagnosticText(value) === value),
});
export const HarnessFailureSchema = z.strictObject({
  type: z.literal('error'),
  code: z.enum(HARNESS_FAILURE_CODES),
  message: z.string().min(1).max(240).refine(value => safeDiagnosticText(value) === value),
  stage: z.enum(HARNESS_FAILURE_STAGES),
  modelTurns: z.number().int().min(0).max(HARNESS_FAILURE_MAX_MODEL_TURNS),
  toolCalls: z.number().int().min(0).max(HARNESS_FAILURE_MAX_TOOL_CALLS),
  lastIssue: HarnessFailureIssueSchema.optional(),
});

export type HarnessFailureCode = typeof HARNESS_FAILURE_CODES[number];
export type HarnessFailureStage = typeof HARNESS_FAILURE_STAGES[number];
export type HarnessFailureIssue = z.infer<typeof HarnessFailureIssueSchema>;
export type HarnessFailure = z.infer<typeof HarnessFailureSchema>;
export type HarnessFailureContext = {
  stage: HarnessFailureStage;
  modelTurns: number;
  toolCalls: number;
  code?: HarnessFailureCode;
};

const FAILURE_MESSAGES: Record<HarnessFailureCode, string> = {
  model_budget: 'The assistant could not finish within its request allowance; final-review capacity remains reserved.',
  tool_budget: 'The assistant could not finish within its lab-action allowance.',
  malformed_json: 'The assistant returned experiment data that was not valid JSON.',
  invalid_schema: 'The assistant returned experiment data outside the supported format.',
  physics_check_failed: 'The physics check could not complete.',
  visual_check_failed: 'The actual scene could not be rendered for visual inspection.',
  review_failed: 'The checked experiment could not be reviewed.',
  review_unstarted: 'Independent review could not start because the bounded request or lab-tool capacity was unavailable.',
  review_unusable: `Independent review did not submit a usable verdict within its ${HARNESS_REVIEW_MAX_TURNS}-request limit.`,
  review_rejected: 'Independent review found an unresolved mismatch; no checked repair could be completed within the remaining bounded model and lab-tool capacity.',
  internal: 'The lab assistant encountered an internal error.',
  protocol: 'The isolated assistant returned an invalid response.',
};

const unsafeDiagnostic = /(?:\b(?:api[_-]?key|authorization|bearer|password|passphrase|secret|token|credential|prompt)\b|\b(?:sk|rk|pk|ghp|gho|github_pat|xox[baprs]|AIza)[-_A-Za-z0-9]{8,}\b|\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b|(?:^|[\s("'=])(?:\/(?:[^\s/]+\/)*[^\s/]+|[A-Za-z]:\\(?:[^\s\\]+\\)*[^\s\\]+)|\b(?:raw|provider|model)\s+(?:response|output|payload|body)\b|\b(?:stack trace|request body|response body)\b|^\s*[\[{])/i;

function safeDiagnosticText(value: string): string | undefined {
  const text = value.trim();
  if (!text || text.length > 240 || /[\r\n\t\0]/.test(text) || unsafeDiagnostic.test(text)) return undefined;
  return text;
}

function boundedCount(value: number, maximum: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(maximum, Math.trunc(value))) : 0;
}

function safeIssue(error: z.ZodError): HarnessFailureIssue | undefined {
  const issue = error.issues.at(-1);
  if (!issue) return undefined;
  let path = '';
  for (const part of issue.path) {
    if (typeof part === 'number' && Number.isSafeInteger(part) && part >= 0) path += `[${part}]`;
    else if (typeof part === 'string') {
      const segment = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(part) && !unsafeDiagnostic.test(part) ? part : '[field]';
      path += `${path ? '.' : ''}${segment}`;
    } else path += `${path ? '.' : ''}[field]`;
    if (path.length > 160) { path = ''; break; }
  }
  return {
    path,
    code: /^[a-z][a-z0-9_]{0,63}$/.test(issue.code) ? issue.code : 'validation_error',
    message: issue.code === 'unrecognized_keys' ? 'The value contains unsupported fields.' : safeDiagnosticText(issue.message) ?? 'The value does not match the supported format.',
  };
}

function safeNativeReason(error: unknown): string | undefined {
  if (!(error instanceof Error) || error instanceof SyntaxError) return undefined;
  const reason = error.message;
  if (reason === 'The runtime did not report every scheduled action state.'
    || reason === 'The scheduled-action smoke check could not advance simulation time.'
    || reason === 'Initial body poses and joint coordinates violate a declared equality connection or fixed tendon length.'
    || reason === 'A free carried group needs positive finite native mass.'
    || reason === 'The carried group has a singular mass response.'
    || reason === 'Native cable branches do not match the compiled model.'
    || reason === 'Native cable branch data is incomplete.'
    || reason === 'The MuJoCo runtime has been disposed.'
    || reason === 'MuJoCo produced a non-finite state; simulation paused.'
    || reason === 'Mutual gravity became singular at coincident particles; simulation paused.') return reason;
  if (/^Physics check stopped after 60 s: reached \d{1,2}\.\d{3} of \d{1,2}\.\d{3} simulated seconds \(\d{1,3} bodies\)\. Keep requested values; check initial geometry and contact materials\.$/.test(reason)) return reason;
  if (/^Scheduled action [A-Za-z][A-Za-z0-9_-]{0,63} (?:changed before the first physics step|reported an invalid execution time|was not completed by its smoke checkpoint)\.$/.test(reason)) return 'A scheduled action did not pass its physics check.';
  if (/^The runtime omitted scheduled action [A-Za-z][A-Za-z0-9_-]{0,63}\.$/.test(reason)) return 'The runtime did not report a scheduled action.';
  if (/^Fixed tendon .+ does not start at its declared length\.$/.test(reason)) return 'A fixed-length tendon does not start at its declared length.';
  if (/^Rope .+ starts beyond its maximum length\.$/.test(reason)) return 'A rope starts beyond its maximum length.';
  if (/^The compiled model is missing .+\.$/.test(reason)) return 'The compiled physics model is missing a required component.';
  if (/^Body [A-Za-z][A-Za-z0-9_-]{0,63} is not (?:currently held|a free rigid body)\.$/.test(reason)) return 'The physics check found an invalid body state.';
  const warning = /^MuJoCo reported a new (inertia|contact capacity|constraint capacity|position|velocity|acceleration|control|numerical) warning; simulation paused\.$/.exec(reason);
  return warning ? `MuJoCo reported a new ${warning[1]} warning; simulation paused.` : undefined;
}

function inferredCode(error: unknown, stage: HarnessFailureStage): HarnessFailureCode {
  if (error instanceof SyntaxError) return 'malformed_json';
  if (error instanceof z.ZodError) return 'invalid_schema';
  if (stage === 'checking') return 'physics_check_failed';
  if (stage === 'inspecting') return 'visual_check_failed';
  if (stage === 'reviewing') return 'review_failed';
  return 'internal';
}

export function makeHarnessFailure(error: unknown, context: HarnessFailureContext): HarnessFailure {
  const code = context.code ?? inferredCode(error, context.stage);
  const nativeReason = safeNativeReason(error);
  const reviewReason = error instanceof Error
    && error.message === `The independent review did not submit a usable verdict within its ${HARNESS_REVIEW_MAX_TURNS}-request limit.`
    ? error.message : undefined;
  const issue = error instanceof z.ZodError ? safeIssue(error) : nativeReason
    ? { path: '', code: 'native_error', message: nativeReason }
    : reviewReason ? { path: '', code: 'review_verdict', message: reviewReason } : undefined;
  return HarnessFailureSchema.parse({
    type: 'error',
    code,
    message: FAILURE_MESSAGES[code],
    stage: context.stage,
    modelTurns: boundedCount(context.modelTurns, HARNESS_FAILURE_MAX_MODEL_TURNS),
    toolCalls: boundedCount(context.toolCalls, HARNESS_FAILURE_MAX_TOOL_CALLS),
    ...(issue ? { lastIssue: issue } : {}),
  });
}

export function formatHarnessFailure(failure: HarnessFailure): string {
  const issue = failure.lastIssue;
  const context = `Stage: ${failure.stage}; model requests: ${failure.modelTurns}; lab tools: ${failure.toolCalls}.`;
  if (!issue) return `${FAILURE_MESSAGES[failure.code]} ${context}`;
  const location = issue.path ? `${issue.path} · ` : '';
  return `${FAILURE_MESSAGES[failure.code]} ${context} Last check: ${location}${issue.code}: ${issue.message}`.slice(0, 640);
}
