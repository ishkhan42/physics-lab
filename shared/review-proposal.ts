import { z } from 'zod';
import { HarnessFailureIssueSchema } from './harness-failure.ts';
import { DecisionSchema, validateDecision, validateScene, type Decision } from './scene.ts';
import { VerificationReceiptSchema } from './verification.ts';

export const ReviewProposalDecisionSchema = DecisionSchema.options[0].refine(decision => {
  try { validateScene(decision.scene); return true; }
  catch { return false; }
}, { error: 'The proposal scene is not a valid experiment.' });

export const ReviewProposalConcernSchema = HarnessFailureIssueSchema.omit({ path: true });
export const ReviewProposalSchema = z.strictObject({
  kind: z.literal('proposal'),
  decision: ReviewProposalDecisionSchema,
  verification: VerificationReceiptSchema,
  concerns: z.array(ReviewProposalConcernSchema).min(1).max(8),
});
export type ReviewProposal = z.infer<typeof ReviewProposalSchema>;
export type LabOutcome = Decision | ReviewProposal;

export const LabOutcomeSchema = z.union([ReviewProposalSchema, DecisionSchema]).superRefine((outcome, context) => {
  if (outcome.kind !== 'scene') return;
  try { validateDecision(outcome); }
  catch { context.addIssue({ code: 'custom', message: 'The experiment scene is invalid.' }); }
});

export function validateLabOutcome(input: unknown): LabOutcome {
  return LabOutcomeSchema.parse(input);
}
