import { z } from 'zod';
import {
  BodySchema, DecisionSchema, SceneSchema, validateDecision,
  type Body, type Decision, type Scene,
} from './scene.ts';

const count = z.number().int().min(1).max(128);
const GridBodySchema = z.strictObject({
  kind: z.literal('grid'),
  counts: z.tuple([count, count, count]).describe('Separate-body counts along world X, Y and Z. The product is the number of actual bodies, not one combined object.'),
  spacing: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]).describe('Signed world-axis centre-to-centre increments in metres, not surface gaps. An axis used more than once needs nonzero spacing.'),
  body: BodySchema.describe('First-cell body template, including its world reference position. Clones retain all physical properties; IDs become templateId_ix_iy_iz and labels append a one-based ordinal, x then y then z.'),
}).superRefine((grid, context) => {
  grid.counts.forEach((axisCount, axis) => {
    if (axisCount > 1 && grid.spacing[axis] === 0) {
      context.addIssue({ code: 'custom', path: ['spacing', axis], message: 'Grid spacing must be nonzero when its count exceeds one.' });
    }
  });
});
const SceneInputSchema = SceneSchema.extend({
  bodies: z.array(z.union([BodySchema, GridBodySchema])).min(1).max(128),
});

export const AssemblyDecisionSchema = z.discriminatedUnion('kind', [
  DecisionSchema.options[0].extend({ scene: SceneInputSchema }),
  DecisionSchema.options[1],
  DecisionSchema.options[2],
]);
const nativeDecisionSchema = z.toJSONSchema(AssemblyDecisionSchema, { io: 'input' }) as Record<string, unknown>;
delete nativeDecisionSchema.$schema;

function lowerHomogeneousFixedTuples(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) lowerHomogeneousFixedTuples(item);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  const schema = value as Record<string, unknown>;
  for (const child of Object.values(schema)) lowerHomogeneousFixedTuples(child);
  const items = schema.prefixItems;
  if (
    !Array.isArray(items) ||
    items.length === 0 ||
    schema.items !== false ||
    schema.minItems !== items.length ||
    schema.maxItems !== items.length ||
    items.some(item => JSON.stringify(item) !== JSON.stringify(items[0]))
  ) return;
  schema.items = items[0];
  schema.minItems = items.length;
  schema.maxItems = items.length;
  delete schema.prefixItems;
}

// Native tool schemas use items with exact bounds instead of prefixItems.
lowerHomogeneousFixedTuples(nativeDecisionSchema);
export const AssemblyDecisionJsonSchema = nativeDecisionSchema;


export interface BodyCapacity {
  maxBodies: 128;
  currentBodies: number;
  automaticGroundBodies: 0 | 1;
  physicalBodies: number;
  remainingBodies: number;
  source: 'current-scene' | 'default-ground-reservation';
}

export function bodyCapacity(scene: Scene | null): BodyCapacity {
  const currentBodies = scene?.bodies.length ?? 0;
  const automaticGroundBodies: 0 | 1 = scene === null || scene.ground !== null ? 1 : 0;
  const physicalBodies = currentBodies + automaticGroundBodies;
  return {
    maxBodies: 128,
    currentBodies,
    automaticGroundBodies,
    physicalBodies,
    remainingBodies: 128 - physicalBodies,
    source: scene === null ? 'default-ground-reservation' : 'current-scene',
  };
}

function rejectExpandedCapacity(path: (string | number)[]): never {
  throw new z.ZodError([{
    code: 'custom', path,
    message: 'Expanded bodies including automatic ground exceed the 128-body limit.',
  }]);
}

export function parseAssemblyDecision(input: unknown): Decision {
  const parsed = AssemblyDecisionSchema.parse(input);
  if (parsed.kind !== 'scene') return validateDecision(parsed);

  const automaticGroundBodies = parsed.scene.ground === null ? 0 : 1;
  let expandedCount = 0;
  for (const [index, entry] of parsed.scene.bodies.entries()) {
    const entryCount = 'kind' in entry ? entry.counts[0] * entry.counts[1] * entry.counts[2] : 1;
    expandedCount += entryCount;
    if (expandedCount + automaticGroundBodies > 128) rejectExpandedCapacity(['scene', 'bodies', index]);
  }

  const bodies: Body[] = [];
  for (const entry of parsed.scene.bodies) {
    if (!('kind' in entry)) {
      bodies.push(entry);
      continue;
    }
    const [nx, ny, nz] = entry.counts;
    let ordinal = 1;
    for (let ix = 0; ix < nx; ix++) {
      for (let iy = 0; iy < ny; iy++) {
        for (let iz = 0; iz < nz; iz++) {
          bodies.push({
            ...entry.body,
            id: `${entry.body.id}_${ix}_${iy}_${iz}`,
            label: `${entry.body.label} ${ordinal++}`,
            position: [
              entry.body.position[0] + ix * entry.spacing[0],
              entry.body.position[1] + iy * entry.spacing[1],
              entry.body.position[2] + iz * entry.spacing[2],
            ],
          });
        }
      }
    }
  }

  return validateDecision({ ...parsed, scene: { ...parsed.scene, bodies } });
}
