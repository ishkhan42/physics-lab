import type { AdvanceResult } from './types.ts';

export const FIXED_TIMESTEP = 0.001;
const MAX_FRAME_GAP = 0.25;
const MAX_STEPS_PER_FRAME = 512;
const MIN_SPEED = 0.1;
const MAX_SPEED = 10;

// Foreground solver/render work is not a suspended browser; keep debt bounded without skipping native steps.
export function browserFrameSeconds(previousStart: number, previousEnd: number, now: number): number | null {
  if (now - Math.max(previousStart, previousEnd) > MAX_FRAME_GAP * 1000) return null;
  return Math.min(Math.max(0, now - previousStart) / 1000, MAX_FRAME_GAP);
}

export interface ClockStepResult {
  advanced: boolean;
  pauseReason: string | null;
}

export class FixedStepClock {
  readonly stepSeconds: number;
  private remainder = 0;

  constructor(stepSeconds = FIXED_TIMESTEP) {
    if (!Number.isFinite(stepSeconds) || stepSeconds <= 0) throw new RangeError('The fixed timestep must be finite and positive.');
    this.stepSeconds = stepSeconds;
  }

  reset(): void {
    this.remainder = 0;
  }

  advance(wallSeconds: number, speed: number, step: () => ClockStepResult, visible = true): AdvanceResult {
    if (!Number.isFinite(wallSeconds) || wallSeconds < 0) throw new RangeError('Elapsed wall time must be finite and nonnegative.');
    if (!Number.isFinite(speed) || speed < MIN_SPEED || speed > MAX_SPEED) throw new RangeError(`Playback speed must be between ${MIN_SPEED}× and ${MAX_SPEED}×.`);
    if (!visible) return { steps: 0, pauseReason: 'Simulation paused while the page is hidden.' };
    if (wallSeconds > MAX_FRAME_GAP) return { steps: 0, pauseReason: 'Simulation paused after a long frame gap.' };

    this.remainder += wallSeconds * speed;
    let steps = 0;
    let pauseReason: string | null = null;
    const epsilon = this.stepSeconds * 1e-9;
    while (steps < MAX_STEPS_PER_FRAME && this.remainder + epsilon >= this.stepSeconds) {
      const result = step();
      if (result.advanced) {
        this.remainder = Math.max(0, this.remainder - this.stepSeconds);
        steps++;
      }
      if (result.pauseReason) {
        pauseReason = result.pauseReason;
        break;
      }
      if (!result.advanced) break;
    }
    const maxQueued = MAX_STEPS_PER_FRAME * this.stepSeconds;
    if (!pauseReason && this.remainder > maxQueued) {
      // The device is slower than the selected speed: keep integrating every fixed step, but stop owing wall time.
      this.remainder = maxQueued;
      return { steps, pauseReason, throttled: true };
    }
    return { steps, pauseReason };
  }
}
