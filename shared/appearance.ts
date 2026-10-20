import { z } from 'zod';

const SURFACES = ['ice', 'stone', 'concrete', 'asphalt', 'rubber', 'plain'] as const;
const SKIES = ['studio', 'day', 'overcast', 'sunset'] as const;

type SurfaceId = typeof SURFACES[number];
type SkyId = typeof SKIES[number];

const surfaceLabels: Record<SurfaceId, string> = {
  ice: 'Ice', stone: 'Stone', concrete: 'Concrete', asphalt: 'Asphalt', rubber: 'Rubber', plain: 'Plain',
};
const skyLabels: Record<SkyId, string> = {
  studio: 'Studio', day: 'Daylight', overcast: 'Overcast', sunset: 'Sunset',
};

export const SURFACE_PRESETS = SURFACES.map(id => ({ id, label: surfaceLabels[id] }));
export const SKY_PRESETS = SKIES.map(id => ({ id, label: skyLabels[id] }));

export const DEFAULT_APPEARANCE = Object.freeze({ surface: 'concrete', sky: 'day', textured: true, grid: true } as const);

export const AppearanceSchema = z.strictObject({
  surface: z.enum(SURFACES).default(DEFAULT_APPEARANCE.surface).describe('Cosmetic ground material preset; it does not set physical friction.'),
  sky: z.enum(SKIES).default(DEFAULT_APPEARANCE.sky).describe('Visual sky preset only; it does not model weather, wind, or temperature.'),
  textured: z.boolean().default(DEFAULT_APPEARANCE.textured).describe('Whether to show ground texture; false keeps a plain visual ground.'),
  grid: z.boolean().default(DEFAULT_APPEARANCE.grid).describe('Show the visual reference grid; hiding it does not remove ground or change physics.'),
}).default(DEFAULT_APPEARANCE).describe('Cosmetic scene appearance. It never removes the physical ground or changes the physics.');

export type Appearance = z.infer<typeof AppearanceSchema>;
