import { validateScene } from '../shared/scene.ts';
import type { Scene } from '../shared/scene.ts';

export function projectile(): Scene {
  return validateScene({
    category: 'mechanics', title: 'Horizontal launch', gravity: [0, 0, -9.81],
    ground: null,
    bodies: [{ id: 'ball', label: 'Projectile', parentId: null, position: [0, 0, 20],
      shape: { kind: 'sphere', radius: 0.1 }, mass: 2,
      motion: { kind: 'free', linearVelocity: [5, 0, 0], angularVelocity: [0, 0, 0] }, color: '#67d9ce' }],
    sites: [], tendons: [], connections: [], loads: [],
  });
}

export function atwood(): Scene {
  return validateScene({
    category: 'mechanics', title: 'Two masses and an ideal cable', gravity: [0, 0, -9.81],
    ground: null,
    bodies: [
      { id: 'beam', label: 'Fixed support', position: [0, 0, 2.2], shape: { kind: 'box', size: [2.4, 0.15, 0.15] }, mass: null, motion: { kind: 'fixed' }, color: '#9cabb5' },
      { id: 'light', label: '1 kg mass', position: [-1, 0, 0], shape: { kind: 'sphere', radius: 0.1 }, mass: 1,
        motion: { kind: 'slide', axis: [0, 0, 1], anchor: [-1, 0, 0] }, color: '#67d9ce' },
      { id: 'heavy', label: '2 kg mass', position: [1, 0, 0], shape: { kind: 'sphere', radius: 0.13 }, mass: 2,
        motion: { kind: 'slide', axis: [0, 0, 1], anchor: [1, 0, 0] }, color: '#f2c178' },
    ],
    sites: [
      { id: 'light_end', label: 'Light attachment', bodyId: 'light', position: [0, 0, 0] },
      { id: 'left_guide', label: 'Left ideal guide', bodyId: null, position: [-1, 0, 2] },
      { id: 'right_guide', label: 'Right ideal guide', bodyId: null, position: [1, 0, 2] },
      { id: 'heavy_end', label: 'Heavy attachment', bodyId: 'heavy', position: [0, 0, 0] },
    ],
    tendons: [{ id: 'cord', label: 'Ideal massless cable', mode: 'fixed', length: 6,
      path: [{ kind: 'site', siteId: 'light_end' }, { kind: 'site', siteId: 'left_guide' }, { kind: 'site', siteId: 'right_guide' }, { kind: 'site', siteId: 'heavy_end' }] }],
    connections: [], loads: [],
  });
}

export function changingWrap(): Scene {
  return validateScene({
    category: 'mechanics', title: 'Cable loses contact with a guide', gravity: [0, 0, 0],
    ground: null,
    bodies: [
      { id: 'guide', label: 'Spherical guide', position: [0, 0, 0], shape: { kind: 'sphere', radius: 0.5 }, mass: null, motion: { kind: 'fixed' } },
      { id: 'load', label: 'Moving endpoint', position: [2, 0, 0], shape: { kind: 'sphere', radius: 0.1 }, mass: 1,
        motion: { kind: 'free', linearVelocity: [0, 0, 2], angularVelocity: [0, 0, 0] } },
    ],
    sites: [
      { id: 'left', label: 'Fixed end', bodyId: null, position: [-2, 0, 0] },
      { id: 'right', label: 'Moving end', bodyId: 'load', position: [0, 0, 0] },
      { id: 'side', label: 'Wrap side', bodyId: null, position: [0, 0, 1] },
    ],
    tendons: [{ id: 'spring', label: 'Routed spring', mode: 'spring', length: 4, stiffness: 0.1, damping: 0,
      path: [{ kind: 'site', siteId: 'left' }, { kind: 'wrap', bodyId: 'guide', sideSiteId: 'side' }, { kind: 'site', siteId: 'right' }] }],
  });
}
