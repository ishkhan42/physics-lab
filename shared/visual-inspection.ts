import { z } from 'zod';
import { BodySchema } from './scene.ts';

export const INSPECTION_WIDTH = 960;
export const INSPECTION_HEIGHT = 640;
export const INSPECTION_FPS = 60;
export const MAX_INSPECTION_FRAMES = 3;
export const MAX_VISUAL_FRAMES_PER_RUN = 4;
export const MAX_VISUAL_CALLS_PER_RUN = 2;
export const MAX_JPEG_BYTES = 128 * 1024;
export const MAX_JPEG_BASE64 = Math.ceil(MAX_JPEG_BYTES / 3) * 4;
export const INSPECTION_TIMEOUT_MS = 45_000;
export const InspectionViewSchema = z.enum(['overview', 'front', 'side', 'top']);
export type InspectionView = z.infer<typeof InspectionViewSchema>;
export const VisualInspectionRequestSchema = z.strictObject({
  frames: z.array(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)).min(1).max(MAX_INSPECTION_FRAMES).default([0]),
  view: InspectionViewSchema.default('overview'),
  focusId: BodySchema.shape.id.nullable().default(null),
});
export type VisualInspectionRequest = z.infer<typeof VisualInspectionRequestSchema>;
export const VisualCaptureRequestSchema = z.strictObject({
  times: z.array(z.number().finite().min(0)).min(1).max(MAX_INSPECTION_FRAMES),
  view: InspectionViewSchema,
  focusId: BodySchema.shape.id.nullable(),
});
export type VisualCaptureRequest = z.infer<typeof VisualCaptureRequestSchema>;
export const InlineSceneImageSchema = z.strictObject({
  type: z.literal('image'),
  data: z.string().min(8).max(MAX_JPEG_BASE64).regex(/^\/9j\/[A-Za-z0-9+/]*={0,2}$/).refine(value => value.length % 4 === 0),
  mimeType: z.literal('image/jpeg'),
});
export type InlineSceneImage = z.infer<typeof InlineSceneImageSchema>;
export const VisualFrameSchema = z.strictObject({
  requestedAt: z.number().finite().min(0),
  simulatedAt: z.number().finite().min(0),
  view: InspectionViewSchema,
  focusedId: BodySchema.shape.id.nullable(),
  width: z.literal(INSPECTION_WIDTH), height: z.literal(INSPECTION_HEIGHT),
  notes: z.array(z.string().max(300)).max(6).default([]),
  image: InlineSceneImageSchema,
});
export type VisualFrame = z.infer<typeof VisualFrameSchema>;
