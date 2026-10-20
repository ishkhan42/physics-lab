import { physicalScene } from '../../shared/scene.ts';
import type { Body, Scene, Tendon, Vec3 } from '../../shared/scene.ts';
import type { InspectionSnapshot, MechanicsRuntime } from './types.ts';

export type StructuralRelation = 'world-support' | 'fixed-body-support' | 'moving-body-coupling' | 'fixed-body-link' | 'other';

type CarryRelease = { eventId: string; at: number; kind: 'launch' | 'release' };

export interface StructuralAudit {
  phase: 'initial-before-scheduled-actions';
  carrying: { bodyId: string; carrierId: string; relation: 'fixed-body-support' | 'moving-body-coupling'; release: CarryRelease | null }[];
  bodies: { id: string; parentId: string | null; heldBy: string | null; motion: Body['motion']['kind']; mobility: 'fixed' | 'moving' }[];
  joints: { bodyId: string; parentId: string | null; motion: Body['motion']['kind']; parentRelation: 'world' | 'fixed-body' | 'moving-body' }[];
  connections: { id: string; kind: Scene['connections'][number]['kind']; bodyAId: string; bodyBId: string | null; relation: StructuralRelation }[];
  tendons: {
    id: string;
    mode: Scene['tendons'][number]['mode'];
    route: ({ kind: 'site'; siteId: string; bodyId: string | null } | { kind: 'wrap'; bodyId: string; sideSiteId: string | null; sideSiteBodyId: string | null } | { kind: 'pulley'; divisor: number })[];
    bodyIds: string[];
    movingBodyIds: string[];
    fixedBodyIds: string[];
    worldAnchored: boolean;
    relation: StructuralRelation;
  }[];
}

export function auditSceneStructure(input: Scene): StructuralAudit {
  const scene = physicalScene(input);
  const bodies = new Map(scene.bodies.map(body => [body.id, body]));
  const sites = new Map(scene.sites.map(site => [site.id, site]));
  const mobility = new Map<string, 'fixed' | 'moving'>();
  const isMoving = (id: string): boolean => {
    const cached = mobility.get(id);
    if (cached) return cached === 'moving';
    const body = bodies.get(id)!;
    const moving = body.heldBy !== null ? isMoving(body.heldBy)
      : body.motion.kind !== 'fixed' || (body.parentId !== null && isMoving(body.parentId));
    mobility.set(id, moving ? 'moving' : 'fixed');
    return moving;
  };
  const relation = (bodyIds: string[], worldAnchored: boolean): StructuralRelation => {
    const distinct = [...new Set(bodyIds)];
    const moving = distinct.filter(isMoving);
    const fixed = distinct.filter(id => !isMoving(id));
    if (moving.length > 1) return 'moving-body-coupling';
    if (moving.length === 1 && fixed.length) return 'fixed-body-support';
    if (moving.length === 1 && worldAnchored) return 'world-support';
    return 'other';
  };
  const bodyFacts = scene.bodies.map(body => ({
    id: body.id,
    parentId: body.parentId,
    heldBy: body.heldBy,
    motion: body.motion.kind,
    mobility: isMoving(body.id) ? 'moving' as const : 'fixed' as const,
  }));
  const jointFacts = scene.bodies.filter(body => body.heldBy === null
    && (body.parentId !== null || body.motion.kind === 'hinge' || body.motion.kind === 'slide' || body.motion.kind === 'ball')).map(body => ({
    bodyId: body.id,
    parentId: body.parentId,
    motion: body.motion.kind,
    parentRelation: body.parentId === null ? 'world' as const : isMoving(body.parentId) ? 'moving-body' as const : 'fixed-body' as const,
  }));
  const releases = new Map<string, CarryRelease>();
  for (const event of scene.events) {
    const action = event.action;
    if (action.kind !== 'launch' && action.kind !== 'release') continue;
    const previous = releases.get(action.bodyId);
    if (!previous || event.at < previous.at) releases.set(action.bodyId, { eventId: event.id, at: event.at, kind: action.kind });
  }
  const carrying: StructuralAudit['carrying'] = [];
  for (const body of scene.bodies) {
    if (body.heldBy === null) continue;
    carrying.push({
      bodyId: body.id, carrierId: body.heldBy,
      relation: isMoving(body.heldBy) ? 'moving-body-coupling' : 'fixed-body-support',
      release: releases.get(body.id) ?? null,
    });
  }
  const connectionFacts = scene.connections.map(connection => {
    const bodyBId = connection.bodyB;
    const aMoves = isMoving(connection.bodyA);
    const bMoves = bodyBId === null ? false : isMoving(bodyBId);
    const relation: StructuralRelation = bodyBId === null
      ? 'world-support'
      : aMoves && bMoves ? 'moving-body-coupling'
        : aMoves || bMoves ? 'fixed-body-support'
          : 'fixed-body-link';
    return { id: connection.id, kind: connection.kind, bodyAId: connection.bodyA, bodyBId, relation };
  });
  const tendonFacts = scene.tendons.map(tendon => {
    let worldAnchored = false;
    const bodyIds: string[] = [];
    const route = tendon.path.map(part => {
      if (part.kind === 'site') {
        const site = sites.get(part.siteId)!;
        if (site.bodyId === null) worldAnchored = true;
        else bodyIds.push(site.bodyId);
        return { kind: 'site' as const, siteId: part.siteId, bodyId: site.bodyId };
      }
      if (part.kind === 'wrap') {
        bodyIds.push(part.bodyId);
        let sideSiteBodyId: string | null = null;
        if (part.sideSiteId !== null) {
          const site = sites.get(part.sideSiteId)!;
          sideSiteBodyId = site.bodyId;
          if (site.bodyId === null) worldAnchored = true;
          else bodyIds.push(site.bodyId);
        }
        return { kind: 'wrap' as const, bodyId: part.bodyId, sideSiteId: part.sideSiteId, sideSiteBodyId };
      }
      return { kind: 'pulley' as const, divisor: part.divisor };
    });
    const uniqueBodyIds = [...new Set(bodyIds)];
    const movingBodyIds = uniqueBodyIds.filter(isMoving);
    const fixedBodyIds = uniqueBodyIds.filter(id => !isMoving(id));
    return {
      id: tendon.id,
      mode: tendon.mode,
      route,
      bodyIds: uniqueBodyIds,
      movingBodyIds,
      fixedBodyIds,
      worldAnchored,
      relation: relation(uniqueBodyIds, worldAnchored),
    };
  });
  return { phase: 'initial-before-scheduled-actions', carrying, bodies: bodyFacts, joints: jointFacts, connections: connectionFacts, tendons: tendonFacts };
}

export interface JointGeometry {
  bodyId: string;
  worldAnchor: Vec3;
  worldBodyOrigin: Vec3;
  anchorToBodyOriginMeters: number;
  angleFromGravityDegrees: number | null;
}

export function measureJointGeometry(runtime: Pick<MechanicsRuntime, 'scene' | 'frame'>): JointGeometry[] {
  const gravity = runtime.scene.gravity;
  const gravityLength = Math.hypot(...gravity);
  return runtime.frame().filter(item => item.shape.kind === 'line' && item.selectable === false && item.points?.length === 2).map(item => {
    const [anchor, origin] = item.points!;
    const dx = origin[0] - anchor[0], dy = origin[1] - anchor[1], dz = origin[2] - anchor[2];
    const length = Math.hypot(dx, dy, dz);
    const cosine = length > 0 && gravityLength > 0 ? (dx * gravity[0] + dy * gravity[1] + dz * gravity[2]) / (length * gravityLength) : null;
    return {
      bodyId: item.entityId,
      worldAnchor: [...anchor],
      worldBodyOrigin: [...origin],
      anchorToBodyOriginMeters: length,
      angleFromGravityDegrees: cosine === null ? null : Math.acos(Math.max(-1, Math.min(1, cosine))) * 180 / Math.PI,
    };
  });
}
export interface NativeBoxBounds {
  bodyId: string;
  provenance: 'native-runtime-frame';
  worldAabb: { min: Vec3; max: Vec3 };
}

export function measureNativeBoxBounds(runtime: Pick<MechanicsRuntime, 'scene' | 'frame'>): NativeBoxBounds[] {
  const bodyIds = new Set(runtime.scene.bodies.slice(0, 128).map(body => body.id));
  const bounds: NativeBoxBounds[] = [];
  for (const item of runtime.frame()) {
    if (!bodyIds.has(item.id) || item.shape.kind !== 'box') continue;
    const [qx, qy, qz, qw] = item.quaternion;
    const [sizeX, sizeY, sizeZ] = item.shape.size;
    const halfX = sizeX / 2, halfY = sizeY / 2, halfZ = sizeZ / 2;
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let xSign = -1; xSign <= 1; xSign += 2) {
      for (let ySign = -1; ySign <= 1; ySign += 2) {
        for (let zSign = -1; zSign <= 1; zSign += 2) {
          const x = xSign * halfX, y = ySign * halfY, z = zSign * halfZ;
          const tx = 2 * (qy * z - qz * y);
          const ty = 2 * (qz * x - qx * z);
          const tz = 2 * (qx * y - qy * x);
          const worldX = item.position[0] + x + qw * tx + qy * tz - qz * ty;
          const worldY = item.position[1] + y + qw * ty + qz * tx - qx * tz;
          const worldZ = item.position[2] + z + qw * tz + qx * ty - qy * tx;
          min[0] = Math.min(min[0], worldX);
          min[1] = Math.min(min[1], worldY);
          min[2] = Math.min(min[2], worldZ);
          max[0] = Math.max(max[0], worldX);
          max[1] = Math.max(max[1], worldY);
          max[2] = Math.max(max[2], worldZ);
        }
      }
    }
    bounds.push({ bodyId: item.id, provenance: 'native-runtime-frame', worldAabb: { min, max } });
  }
  return bounds;
}


export interface TendonGeometry {
  tendonId: string;
  mode: Tendon['mode'];
  declaredLengthMeters: number;
  nativePathLengthMeters: number;
  signedPathLengthResidualMeters: number;
  signedPathLengthResidualFractionOfDeclaredLength: number;
  straightSpan: {
    start: Vec3;
    end: Vec3;
    endToEndDistanceMeters: number;
    worldZSeparationMeters: number;
    angleFromWorldVerticalDegrees: number | null;
  } | null;
}

export function measureTendonGeometry(runtime: Pick<MechanicsRuntime, 'scene' | 'frame'>, snapshot: InspectionSnapshot): TendonGeometry[] {
  if (runtime.scene.tendons.length === 0) return [];
  const lengths = new Map<string, number>();
  for (const entity of snapshot.entities) {
    if (entity.kind !== 'tendon') continue;
    const value = entity.properties.find(property => property.label === 'Length')?.value;
    if (typeof value === 'number' && Number.isFinite(value)) lengths.set(entity.id, value);
  }
  const lines = new Map<string, Vec3[]>();
  for (const item of runtime.frame()) {
    if (item.shape.kind === 'line' && item.selectable !== false && item.points) lines.set(item.entityId, item.points);
  }
  return runtime.scene.tendons.map(tendon => {
    const nativePathLengthMeters = lengths.get(tendon.id);
    if (nativePathLengthMeters === undefined) throw new Error('The native cord path length is unavailable.');
    let straightSpan: TendonGeometry['straightSpan'] = null;
    if (tendon.path.length === 2 && tendon.path.every(part => part.kind === 'site')) {
      const points = lines.get(tendon.id);
      if (!points || points.length !== 2) throw new Error('The native straight-cord endpoints are unavailable.');
      const [start, end] = points;
      const dx = end[0] - start[0], dy = end[1] - start[1], dz = end[2] - start[2];
      const distance = Math.hypot(dx, dy, dz);
      straightSpan = {
        start: [...start], end: [...end], endToEndDistanceMeters: distance, worldZSeparationMeters: Math.abs(dz),
        angleFromWorldVerticalDegrees: distance > 0 ? Math.atan2(Math.hypot(dx, dy), Math.abs(dz)) * 180 / Math.PI : null,
      };
    }
    const signedPathLengthResidualMeters = nativePathLengthMeters - tendon.length;
    return {
      tendonId: tendon.id, mode: tendon.mode, declaredLengthMeters: tendon.length, nativePathLengthMeters,
      signedPathLengthResidualMeters,
      signedPathLengthResidualFractionOfDeclaredLength: signedPathLengthResidualMeters / tendon.length,
      straightSpan,
    };
  });
}

export interface MotionSampleReport {
  bodyId: string;
  samples: number;
  fromTime: number;
  toTime: number;
  maxTranslation: number;
  totalTranslation: number;
  maxAngularChange: number;
  totalAngularChange: number;
}

export interface MotionTracker {
  sample(): void;
  report(): MotionSampleReport[];
}
export interface CheckpointBodyReport {
  bodyId: string;
  position: Vec3;
  maxTranslation: number;
  maxAngularChange: number;
}

export interface StateCheckpoint {
  name: string;
  simulatedTime: number;
  provenance: 'native-runtime-frame';
  bodies: CheckpointBodyReport[];
  omittedBodyCount: number;
}

export function captureStateCheckpoint(
  name: string,
  runtime: Pick<MechanicsRuntime, 'scene' | 'frame' | 'time'>,
  motionReport: MotionSampleReport[],
): StateCheckpoint {
  const bodyIds = runtime.scene.bodies.slice(0, 128).map(body => body.id);
  const includedBodyIds = new Set(bodyIds);
  const reports = new Map(motionReport.map(report => [report.bodyId, report]));
  const bodies: CheckpointBodyReport[] = [];
  for (const item of runtime.frame()) {
    if (!includedBodyIds.has(item.id)) continue;
    const report = reports.get(item.id);
    if (report) bodies.push({
      bodyId: report.bodyId,
      position: [...item.position],
      maxTranslation: report.maxTranslation,
      maxAngularChange: report.maxAngularChange,
    });
  }
  return {
    name,
    simulatedTime: runtime.time,
    provenance: 'native-runtime-frame',
    bodies,
    omittedBodyCount: Math.max(0, runtime.scene.bodies.length - includedBodyIds.size),
  };
}

export interface DeclaredLaunchProperties {
  eventId: string;
  bodyId: string;
  provenance: 'declared-scene-event';
  velocityFrame: 'world' | 'carrier-relative';
  declaredVelocity: Vec3;
  speedMetersPerSecond: number;
  worldXYElevationDegrees: number | null;
}

export function measureDeclaredLaunchProperties(scene: Scene): DeclaredLaunchProperties[] {
  const launches: DeclaredLaunchProperties[] = [];
  for (const event of scene.events) {
    const action = event.action;
    if (action.kind !== 'launch') continue;
    const speed = Math.hypot(...action.velocity);
    launches.push({
      eventId: event.id,
      bodyId: action.bodyId,
      provenance: 'declared-scene-event',
      velocityFrame: action.frame === 'world' ? 'world' : 'carrier-relative',
      declaredVelocity: [...action.velocity],
      speedMetersPerSecond: speed,
      worldXYElevationDegrees: action.frame === 'world' && speed > 0
        ? Math.atan2(action.velocity[2], Math.hypot(action.velocity[0], action.velocity[1])) * 180 / Math.PI
        : null,
    });
  }
  return launches;
}


interface TrackedPose extends MotionSampleReport {
  initialPosition: [number, number, number];
  previousPosition: [number, number, number];
  initialQuaternion: [number, number, number, number];
  previousQuaternion: [number, number, number, number];
}

function angularDistance(a: readonly number[], b: readonly number[]): number {
  const dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return 2 * Math.acos(Math.min(1, dot));
}

export function createMotionTracker(runtime: Pick<MechanicsRuntime, 'scene' | 'frame' | 'time'>): MotionTracker {
  const bodyIds = runtime.scene.bodies.map(body => body.id);
  const bodyIdSet = new Set(bodyIds);
  const poses = new Map<string, TrackedPose>();
  return {
    sample() {
      const frame = runtime.frame();
      const time = runtime.time;
      for (const item of frame) {
        if (!bodyIdSet.has(item.id)) continue;
        const position = item.position;
        const quaternion = item.quaternion;
        let pose = poses.get(item.id);
        if (!pose) {
          pose = {
            bodyId: item.id,
            samples: 1,
            fromTime: time,
            toTime: time,
            maxTranslation: 0,
            totalTranslation: 0,
            maxAngularChange: 0,
            totalAngularChange: 0,
            initialPosition: [...position],
            previousPosition: [...position],
            initialQuaternion: [...quaternion],
            previousQuaternion: [...quaternion],
          };
          poses.set(item.id, pose);
          continue;
        }
        const dx = position[0] - pose.previousPosition[0];
        const dy = position[1] - pose.previousPosition[1];
        const dz = position[2] - pose.previousPosition[2];
        pose.totalTranslation += Math.hypot(dx, dy, dz);
        const initialDx = position[0] - pose.initialPosition[0];
        const initialDy = position[1] - pose.initialPosition[1];
        const initialDz = position[2] - pose.initialPosition[2];
        pose.maxTranslation = Math.max(pose.maxTranslation, Math.hypot(initialDx, initialDy, initialDz));
        pose.totalAngularChange += angularDistance(pose.previousQuaternion, quaternion);
        pose.maxAngularChange = Math.max(pose.maxAngularChange, angularDistance(pose.initialQuaternion, quaternion));
        pose.previousPosition[0] = position[0];
        pose.previousPosition[1] = position[1];
        pose.previousPosition[2] = position[2];
        pose.previousQuaternion[0] = quaternion[0];
        pose.previousQuaternion[1] = quaternion[1];
        pose.previousQuaternion[2] = quaternion[2];
        pose.previousQuaternion[3] = quaternion[3];
        pose.samples++;
        pose.toTime = time;
      }
    },
    report() {
      const report: MotionSampleReport[] = [];
      for (const bodyId of bodyIds) {
        const pose = poses.get(bodyId);
        if (!pose) continue;
        report.push({
          bodyId: pose.bodyId,
          samples: pose.samples,
          fromTime: pose.fromTime,
          toTime: pose.toTime,
          maxTranslation: pose.maxTranslation,
          totalTranslation: pose.totalTranslation,
          maxAngularChange: pose.maxAngularChange,
          totalAngularChange: pose.totalAngularChange,
        });
      }
      return report;
    },
  };
}
