import assert from 'node:assert/strict';
import test from 'node:test';
import type { InspectionSnapshot } from '../src/physics/types.ts';
import { appendSnapshot, type Sample } from '../src/telemetry-samples.ts';

function observation(time: number): InspectionSnapshot {
  return {
    time,
    entities: [{
      id: 'brick', label: 'Brick 1', kind: 'body', color: '#67d9ce',
      properties: [
        { label: 'Motion', value: 'free' },
        { label: 'Position', value: [0, 0, time] },
        { label: 'Velocity', value: [0, 0, time + 1] },
        { label: 'Translational kinetic energy', value: time + 2 },
      ],
    }],
    notes: [],
  };
}

test('telemetry history keeps distinct samples and resets cleanly on rewind', () => {
  const history: Sample[] = [];
  const times = Array.from({ length: 20 }, (_, index) => index / 20);
  for (const time of times) assert.equal(appendSnapshot(history, observation(time)), 'added');

  assert.deepEqual(history.map(sample => sample.time), times);
  assert.deepEqual(history.at(-1)!.bodies.get('brick'), {
    id: 'brick', label: 'Brick 1', color: '#67d9ce', height: 0.95, speed: 1.95, energy: 2.95,
  });
  assert.equal(appendSnapshot(history, observation(times.at(-1)!)), 'unchanged');
  assert.equal(history.length, 20);
  assert.equal(appendSnapshot(history, observation(0.05)), 'reset');
  assert.deepEqual(history.map(sample => sample.time), [0.05]);
});

test('telemetry history retains the latest 4000 samples', () => {
  const history: Sample[] = [];
  for (let index = 0; index <= 4000; index += 1) {
    assert.equal(appendSnapshot(history, observation(index / 20)), 'added');
  }
  assert.equal(history.length, 4000);
  assert.equal(history[0]!.time, 0.05);
  assert.equal(history.at(-1)!.time, 200);
});
