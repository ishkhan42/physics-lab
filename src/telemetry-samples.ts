import type { InspectionSnapshot, Observation } from './physics/types.ts';

const MAX_SAMPLES = 4000;
type BodyValues = { id: string; label: string; color: string; height: number | null; speed: number; energy: number | null };
export type Sample = { time: number; bodies: Map<string, BodyValues> };

function vector3(value: Observation['value'] | undefined): [number, number, number] | null {
  if (!Array.isArray(value) || value.length < 3) return null;
  const [x, y, z] = value;
  return typeof x === 'number' && Number.isFinite(x)
    && typeof y === 'number' && Number.isFinite(y)
    && typeof z === 'number' && Number.isFinite(z)
    ? [x, y, z]
    : null;
}

function sampleSnapshot(snapshot: InspectionSnapshot): Sample {
  const bodies = new Map<string, BodyValues>();
  for (const entity of snapshot.entities) {
    // Fixed supports never move; plotting them adds flat zero lines.
    if (entity.kind !== 'body' || entity.properties.some(property => property.label === 'Motion' && property.value === 'fixed')) continue;
    const velocity = vector3(entity.properties.find(property => property.label === 'Velocity')?.value);
    if (!velocity) continue;
    const position = vector3(entity.properties.find(property => property.label === 'Position')?.value);
    const energy = entity.properties.find(property => property.label === 'Translational kinetic energy')?.value;
    const speed = Math.hypot(velocity[0], velocity[1], velocity[2]);
    if (!Number.isFinite(speed)) continue;
    bodies.set(entity.id, {
      id: entity.id,
      label: entity.label,
      color: entity.color,
      height: position?.[2] ?? null,
      speed,
      energy: typeof energy === 'number' && Number.isFinite(energy) ? energy : null,
    });
  }
  return { time: snapshot.time, bodies };
}

export function appendSnapshot(samples: Sample[], snapshot: InspectionSnapshot): 'added' | 'reset' | 'unchanged' {
  const last = samples[samples.length - 1];
  let reset = false;
  if (last && snapshot.time < last.time) {
    samples.length = 0;
    reset = true;
  } else if (last && snapshot.time === last.time) {
    return 'unchanged';
  }
  samples.push(sampleSnapshot(snapshot));
  if (samples.length > MAX_SAMPLES) samples.shift();
  return reset ? 'reset' : 'added';
}
