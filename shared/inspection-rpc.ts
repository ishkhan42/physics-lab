import { z } from 'zod';
import { SceneSchema } from './scene.ts';
import { INSPECTION_TIMEOUT_MS, MAX_INSPECTION_FRAMES, MAX_VISUAL_CALLS_PER_RUN, VisualCaptureRequestSchema, VisualFrameSchema } from './visual-inspection.ts';

export const INSPECTION_RPC_TIMEOUT_MS = INSPECTION_TIMEOUT_MS * 2 + 10_000;

const InspectionIdSchema = z.number().int().min(1).max(MAX_VISUAL_CALLS_PER_RUN);
export const InspectionPayloadSchema = z.strictObject({ scene: SceneSchema, request: VisualCaptureRequestSchema });
export const InspectionRequestSchema = InspectionPayloadSchema.extend({ type: z.literal('inspection'), id: InspectionIdSchema });
export const InspectionResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ type: z.literal('inspection_result'), id: InspectionIdSchema, status: z.literal('ok'), frames: z.array(VisualFrameSchema).min(1).max(MAX_INSPECTION_FRAMES) }),
  z.strictObject({ type: z.literal('inspection_result'), id: InspectionIdSchema, status: z.literal('error'), message: z.string().min(1).max(500) }),
]);
export type InspectionPayload = z.infer<typeof InspectionPayloadSchema>;
export type InspectionResult = z.infer<typeof InspectionResultSchema>;
