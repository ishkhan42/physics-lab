import { z } from 'zod';
import { VerificationReceiptSchema } from './verification.ts';
import { ProviderSchema, DecisionSchema, SceneSchema, validateScene } from './scene.ts';

export const HarnessRequestSchema = z.strictObject({
  provider: ProviderSchema,
  model: z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/),
  description: z.string().trim().min(3).max(16000),
  clarification: z.array(z.strictObject({ question: z.string().min(1).max(2000), answer: z.string().trim().min(1).max(4000) })).max(12).default([]),
  history: z.array(z.strictObject({ role: z.enum(['user', 'assistant']), content: z.string().trim().min(1).max(16000) })).max(24).default([]),
  currentScene: SceneSchema.nullable().default(null),
  sourcePrompt: z.string().max(16000).nullable().default(null),
  sourceAssumptions: DecisionSchema.options[0].shape.assumptions.default([]),
}).superRefine((request, context) => {
  if (request.currentScene) {
    try { validateScene(request.currentScene); }
    catch { context.addIssue({ code: 'custom', path: ['currentScene'], message: 'The current experiment is invalid.' }); }
  }
});
export type HarnessRequest = z.infer<typeof HarnessRequestSchema>;
export const HARNESS_MAX_TURNS = 16;
export const HARNESS_MAX_TOOL_CALLS = 24;
export const HARNESS_REVIEW_MAX_TURNS = 2;
export const HARNESS_TIMEOUT_MS = 240_000;
export const ModelPurposeSchema = z.enum(['builder', 'reviewer']);
export type ModelPurpose = z.infer<typeof ModelPurposeSchema>;
export const HarnessBudgetSchema = z.strictObject({
  modelRequests: z.number().int().min(0).max(64),
  modelRequestLimit: z.number().int().min(1).max(64),
  toolCalls: z.number().int().min(0).max(128),
  toolCallLimit: z.number().int().min(1).max(128),
}).superRefine((budget, context) => {
  if (budget.modelRequests > budget.modelRequestLimit) context.addIssue({ code: 'custom', path: ['modelRequests'], message: 'Request count exceeds its limit.' });
  if (budget.toolCalls > budget.toolCallLimit) context.addIssue({ code: 'custom', path: ['toolCalls'], message: 'Tool count exceeds its limit.' });
});
export type HarnessBudget = z.infer<typeof HarnessBudgetSchema>;
export const HarnessProgressSchema = z.strictObject({
  stage: z.enum(['starting', 'generating', 'catalog', 'validating', 'simulating', 'inspecting', 'repairing', 'retrying', 'reviewing']),
  message: z.string().min(1).max(2000),
  role: ModelPurposeSchema.optional(),
  budget: HarnessBudgetSchema.optional(),
  verification: VerificationReceiptSchema.optional(),
});
export type HarnessProgress = z.infer<typeof HarnessProgressSchema>;
