import type { Context } from '@earendil-works/pi-ai';
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript';
import { HARNESS_MAX_TOOL_CALLS, HARNESS_MAX_TURNS, HARNESS_REVIEW_MAX_TURNS, type ModelPurpose } from '../shared/harness.ts';
import { MAX_VISUAL_CALLS_PER_RUN, MAX_VISUAL_FRAMES_PER_RUN } from '../shared/visual-inspection.ts';

export function withLabResources(context: Context, purpose: ModelPurpose, counts: { modelRequests: number; labActions: number; inspectionCalls: number; imageAttempts: number; canInspectImages: boolean }): Context {
  const remainingRequests = Math.max(0, HARNESS_MAX_TURNS - counts.modelRequests);
  const tools = getCurrentTools(context.messages).map(({ name }) => name);
  const status = {
    labResourceStatus: {
      purpose,
      modelRequests: {
        usedIncludingCurrent: counts.modelRequests,
        limit: HARNESS_MAX_TURNS,
        remainingAfterCurrentRequest: remainingRequests,
        builderRequestsBeforeReviewReserve: Math.max(0, remainingRequests - HARNESS_REVIEW_MAX_TURNS),
        reservedForFinalReview: HARNESS_REVIEW_MAX_TURNS,
      },
      labActions: {
        used: counts.labActions,
        limit: HARNESS_MAX_TOOL_CALLS,
        remaining: Math.max(0, HARNESS_MAX_TOOL_CALLS - counts.labActions),
      },
      inspection: {
        imageInputAvailable: counts.canInspectImages,
        toolAvailable: counts.canInspectImages && tools.includes('inspect_scene'),
        callsUsed: counts.inspectionCalls,
        callLimit: MAX_VISUAL_CALLS_PER_RUN,
        callsRemaining: counts.canInspectImages ? Math.max(0, MAX_VISUAL_CALLS_PER_RUN - counts.inspectionCalls) : 0,
        imageAttemptsUsed: counts.imageAttempts,
        imageAttemptLimit: MAX_VISUAL_FRAMES_PER_RUN,
        imageAttemptsRemaining: counts.canInspectImages ? Math.max(0, MAX_VISUAL_FRAMES_PER_RUN - counts.imageAttempts) : 0,
      },
      callableTools: tools,
    },
  };
  return {
    ...context,
    messages: [...context.messages, { role: 'system', content: JSON.stringify(status), timestamp: Date.now() }],
  };
}
