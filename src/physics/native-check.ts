import { FIXED_TIMESTEP } from './clock.ts';
import type { MechanicsRuntime } from './types.ts';

export const NATIVE_CHECK_WALL_BUDGET_MS = 60_000;
const NATIVE_CHECK_CHUNK_SECONDS = 0.025;
const NATIVE_CHECK_WORK_BUDGET_MS = 10;
const TIME_EPSILON = FIXED_TIMESTEP * 1e-9;

export async function advanceNativeCheckTo(
  runtime: MechanicsRuntime,
  targetSeconds: number,
  deadline: number,
  bodyCount: number,
  onSample: () => void,
  onProgress: (simulatedSeconds: number) => void,
): Promise<void> {
  const budgetError = () => new Error(`Physics check stopped after 60 s: reached ${runtime.time.toFixed(3)} of ${targetSeconds.toFixed(3)} simulated seconds (${bodyCount} bodies). Keep requested values; check initial geometry and contact materials.`);
  while (runtime.time < targetSeconds - TIME_EPSILON) {
    if (performance.now() >= deadline) throw budgetError();
    const chunkTarget = Math.min(targetSeconds, runtime.time + NATIVE_CHECK_CHUNK_SECONDS);
    let queuedSeconds = chunkTarget - runtime.time;
    while (runtime.time < chunkTarget - TIME_EPSILON) {
      const remainingMs = deadline - performance.now();
      if (remainingMs <= 0) throw budgetError();
      const previousTime = runtime.time;
      const advanced = runtime.advance(queuedSeconds, 1, Math.min(NATIVE_CHECK_WORK_BUDGET_MS, remainingMs));
      queuedSeconds = 0;
      if (advanced.pauseReason) throw new Error(advanced.pauseReason);
      if (!(runtime.time > previousTime)) {
        if (performance.now() >= deadline) throw budgetError();
        throw new Error('The scheduled-action smoke check could not advance simulation time.');
      }
      onProgress(runtime.time);
      await new Promise<void>(resolve => setImmediate(resolve));
      if (performance.now() >= deadline) throw budgetError();
    }
    onSample();
  }
}
