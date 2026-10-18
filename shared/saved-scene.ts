import { z } from 'zod';
import { DecisionSchema, SceneSchema, validateScene } from './scene.ts';

export const SCENE_RETENTION_MS = 24 * 60 * 60 * 1000;
export const SavedSceneIdSchema = z.string().uuid();
export const SceneDocumentSchema = z.strictObject({
  prompt: z.string().max(16000),
  decision: DecisionSchema.options[0],
  scene: SceneSchema,
  userGroundChoice: z.enum(['default', 'none']).optional(),
}).superRefine((document, context) => {
  if ((document.userGroundChoice === 'none' && document.scene.ground !== null)
    || (document.userGroundChoice === 'default' && document.scene.ground === null)) {
    context.addIssue({ code: 'custom', path: ['userGroundChoice'], message: 'The saved ground choice must match the actual scene.' });
  }
});
export type SceneDocument = z.infer<typeof SceneDocumentSchema>;

export const SavedSceneMetadataSchema = z.strictObject({
  id: SavedSceneIdSchema,
  createdAt: z.iso.datetime(),
  lastRunAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime(),
});
export type SavedSceneMetadata = z.infer<typeof SavedSceneMetadataSchema>;
export const SavedSceneSchema = SavedSceneMetadataSchema.extend({ document: SceneDocumentSchema });
export type SavedScene = z.infer<typeof SavedSceneSchema>;

export function validateSceneDocument(input: unknown): SceneDocument {
  const document = SceneDocumentSchema.parse(input);
  document.decision.scene = validateScene(document.decision.scene);
  document.scene = validateScene(document.scene);
  return document;
}

export function validateSavedScene(input: unknown): SavedScene {
  const saved = SavedSceneSchema.parse(input);
  saved.document = validateSceneDocument(saved.document);
  return saved;
}
