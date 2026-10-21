import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Group,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshStandardMaterial,
  Sphere,
  Vector3,
  type Intersection,
  type Raycaster,
} from 'three';
import type { RenderItem, TendonRenderState } from './physics/types.ts';

export const TENDON_TENSION_COLOR = '#c87932';
export const TENDON_COMPRESSION_COLOR = '#4f78a7';

const SIDES = 12;
const MAX_ROUTE_POINTS = 2048;
const MAX_RINGS = 4096;
const ARROW_SIDES = 12;
const ARROW_VERTICES = ARROW_SIDES * 5 + 2;
const TAU = Math.PI * 2;
const MAX_FLOAT32_COORDINATE = 3.4028234663852886e38;
const FALLBACK_COLOR = '#59616c';



function renderCoordinate(value: number): number {
  if (!Number.isFinite(value) || Math.abs(value) > MAX_FLOAT32_COORDINATE) {
    throw new RangeError('Tendon path contains a position outside the finite Float32 render range.');
  }
  return value;
}

function nonnegativeLength(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`Tendon ${name} must be finite and nonnegative.`);
  return value;
}


function nextCapacity(current: number, required: number, max: number): number {
  let capacity = Math.max(16, current);
  while (capacity < required && capacity < max) capacity *= 2;
  return Math.min(capacity, max);
}
function smoothstep(value: number): number {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

function setBounds(box: Box3, sphere: Sphere, minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): void {
  box.min.set(minX, minY, minZ);
  box.max.set(maxX, maxY, maxZ);
  box.getBoundingSphere(sphere);
}

function perpendicular(tx: number, ty: number, tz: number, out: Float64Array, offset: number): void {
  let rx = 1;
  let ry = 0;
  let rz = 0;
  if (Math.abs(tx) <= Math.abs(ty) && Math.abs(tx) <= Math.abs(tz)) {
    rx = 1; ry = 0; rz = 0;
  } else if (Math.abs(ty) <= Math.abs(tz)) {
    rx = 0; ry = 1; rz = 0;
  } else {
    rx = 0; ry = 0; rz = 1;
  }
  const dot = rx * tx + ry * ty + rz * tz;
  let nx = rx - tx * dot;
  let ny = ry - ty * dot;
  let nz = rz - tz * dot;
  const length = Math.hypot(nx, ny, nz) || 1;
  nx /= length; ny /= length; nz /= length;
  out[offset] = nx; out[offset + 1] = ny; out[offset + 2] = nz;
}

function transportNormal(
  oldTx: number, oldTy: number, oldTz: number,
  newTx: number, newTy: number, newTz: number,
  oldNx: number, oldNy: number, oldNz: number,
  out: Float64Array, offset: number,
): void {
  const cx = oldTy * newTz - oldTz * newTy;
  const cy = oldTz * newTx - oldTx * newTz;
  const cz = oldTx * newTy - oldTy * newTx;
  const sin = Math.hypot(cx, cy, cz);
  const cos = Math.max(-1, Math.min(1, oldTx * newTx + oldTy * newTy + oldTz * newTz));
  let nx = oldNx;
  let ny = oldNy;
  let nz = oldNz;
  if (sin > 1e-10) {
    const ax = cx / sin;
    const ay = cy / sin;
    const az = cz / sin;
    const crossX = ay * nz - az * ny;
    const crossY = az * nx - ax * nz;
    const crossZ = ax * ny - ay * nx;
    const along = ax * nx + ay * ny + az * nz;
    nx = nx * cos + crossX * sin + ax * along * (1 - cos);
    ny = ny * cos + crossY * sin + ay * along * (1 - cos);
    nz = nz * cos + crossZ * sin + az * along * (1 - cos);
  }
  const alongTangent = nx * newTx + ny * newTy + nz * newTz;
  nx -= newTx * alongTangent;
  ny -= newTy * alongTangent;
  nz -= newTz * alongTangent;
  const length = Math.hypot(nx, ny, nz);
  if (length < 1e-10) {
    perpendicular(newTx, newTy, newTz, out, offset);
    return;
  }
  out[offset] = nx / length;
  out[offset + 1] = ny / length;
  out[offset + 2] = nz / length;
}

function safeColor(color: Color, value: string): void {
  try {
    color.set(value);
    if (!Number.isFinite(color.r) || !Number.isFinite(color.g) || !Number.isFinite(color.b)) color.set(FALLBACK_COLOR);
  } catch {
    color.set(FALLBACK_COLOR);
  }
}

function forceStrength(force: number, scale: number): number {
  const magnitude = Math.abs(force);
  if (magnitude > scale) return 1 / (1 + scale / magnitude);
  const ratio = magnitude / scale;
  return ratio / (1 + ratio);
}

export class TendonVisual extends Group {
  readonly pickLine: Line;

  private readonly bodyGeometry = new BufferGeometry();
  private readonly bodyMaterial = new MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.38, metalness: 0.12 });
  private readonly body = new Mesh(this.bodyGeometry, this.bodyMaterial);
  private readonly arrowGeometries = [new BufferGeometry(), new BufferGeometry()] as const;
  private readonly arrowMaterials = [
    new MeshStandardMaterial({ color: 0xffffff, roughness: 0.36, metalness: 0.08, transparent: true, depthTest: false, depthWrite: false }),
    new MeshStandardMaterial({ color: 0xffffff, roughness: 0.36, metalness: 0.08, transparent: true, depthTest: false, depthWrite: false }),
  ] as const;
  private readonly arrows = [
    new Mesh(this.arrowGeometries[0], this.arrowMaterials[0]),
    new Mesh(this.arrowGeometries[1], this.arrowMaterials[1]),
  ] as const;
  private route = new Float64Array(0);
  private routeTangents = new Float64Array(0);
  private routeNormals = new Float64Array(0);
  private edgeLengths = new Float64Array(0);
  private edgeWrapped = new Uint8Array(0);
  private readonly edgeNormalScratch = new Float64Array(3);
  private samples = new Float64Array(0);
  private sampleDistances = new Float64Array(0);
  private sampleTangents = new Float64Array(0);
  private sampleNormals = new Float64Array(0);
  private sampleBinormals = new Float64Array(0);
  private readonly routeColor = new Color();
  private readonly cueColor = new Color();
  private readonly tensionColor = new Color(TENDON_TENSION_COLOR);
  private readonly compressionColor = new Color(TENDON_COMPRESSION_COLOR);
  private readonly bodyBounds = new Box3();
  private readonly bodySphere = new Sphere();
  private readonly lineBounds = new Box3();
  private readonly lineSphere = new Sphere();
  private readonly arrowBounds = [new Box3(), new Box3()] as const;
  private readonly arrowSpheres = [new Sphere(), new Sphere()] as const;
  private readonly pickGeometry: BufferGeometry;
  private readonly pickMaterial: LineBasicMaterial;
  private bodyPositions = new Float32Array(0);
  private bodyNormals = new Float32Array(0);
  private bodyColors = new Float32Array(0);
  private bodyIndices = new Uint16Array(0);
  private bodyPositionAttribute: BufferAttribute | null = null;
  private bodyNormalAttribute: BufferAttribute | null = null;
  private bodyColorAttribute: BufferAttribute | null = null;
  private bodyIndexAttribute: BufferAttribute | null = null;
  private ringCapacity = 0;
  private indexedRingCount = 0;
  private pickPositions = new Float32Array(0);
  private pickPositionAttribute: BufferAttribute | null = null;
  private pickCapacity = 0;
  private routeCapacity = 0;
  private sampleCapacity = 0;
  private routeLength = 0;
  private sampleCount = 0;
  private routeCount = 0;
  private previousFrameTangent = new Vector3(1, 0, 0);
  private previousFrameNormal = new Vector3(0, 1, 0);
  private hasPreviousFrame = false;
  private disposed = false;

  constructor(item: RenderItem) {
    super();
    this.body.frustumCulled = true;
    this.body.castShadow = true;
    this.body.receiveShadow = true;
    this.arrows[0].frustumCulled = true;
    this.arrows[1].frustumCulled = true;
    // Force glyphs are annotations, so attached bodies must not hide their direction.
    this.arrows[0].renderOrder = this.arrows[1].renderOrder = 2;
    this.add(this.body, this.arrows[0], this.arrows[1]);
    this.pickGeometry = new BufferGeometry();
    this.pickMaterial = new LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false });
    this.pickLine = new Line(this.pickGeometry, this.pickMaterial);
    this.pickLine.frustumCulled = false;
    this.ensureBodyCapacity(2);
    this.ensurePickCapacity(2);
    this.initializeArrow(this.arrowGeometries[0]);
    this.initializeArrow(this.arrowGeometries[1]);
    try {
      this.update(item);
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  update(item: RenderItem): void {
    if (this.disposed) return;
    const state = item.tendon;
    const visual = state?.visual;
    if (visual !== undefined && (visual === null || typeof visual !== 'object' || Array.isArray(visual))) {
      throw new RangeError('Tendon visual configuration must be an object.');
    }
    const sourcePoints = item.points;
    const pointCount = sourcePoints?.length ?? 0;
    if (pointCount > MAX_ROUTE_POINTS) throw new RangeError(`Tendon route exceeds ${MAX_ROUTE_POINTS} expanded points.`);
    this.routeCount = Math.max(1, pointCount);
    this.ensureRouteCapacity(Math.max(2, this.routeCount));
    const fallback = item.position;
    let maxPositionComponent = 0;
    for (let index = 0; index < this.routeCount; index += 1) {
      const point = pointCount === 0 ? fallback : sourcePoints![index];
      if (!point) throw new RangeError(`Tendon route point ${index} is missing.`);
      const offset = index * 3;
      const x = renderCoordinate(point[0]);
      const y = renderCoordinate(point[1]);
      const z = renderCoordinate(point[2]);
      this.route[offset] = x;
      this.route[offset + 1] = y;
      this.route[offset + 2] = z;
      maxPositionComponent = Math.max(maxPositionComponent, Math.abs(x), Math.abs(y), Math.abs(z));
    }
    if (this.routeCount === 1) {
      this.route.copyWithin(3, 0, 3);
      this.routeCount = 2;
    }

    let routeLength = 0;
    let freeLength = 0;
    for (let edge = 0; edge < this.routeCount - 1; edge += 1) {
      const offset = edge * 3;
      const dx = this.route[offset + 3] - this.route[offset];
      const dy = this.route[offset + 4] - this.route[offset + 1];
      const dz = this.route[offset + 5] - this.route[offset + 2];
      const length = Math.hypot(dx, dy, dz);
      if (!Number.isFinite(length)) throw new RangeError('Tendon path length exceeds the finite render range.');
      this.edgeLengths[edge] = length;
      routeLength += this.edgeLengths[edge];
      const wrapped = state?.wrapped?.[edge] === true;
      this.edgeWrapped[edge] = wrapped ? 1 : 0;
      if (!wrapped) freeLength += this.edgeLengths[edge];
    }
    if (!Number.isFinite(routeLength) || !Number.isFinite(freeLength)) throw new RangeError('Tendon route length exceeds the finite render range.');

    safeColor(this.routeColor, item.color);
    const restLength = nonnegativeLength(state?.restLength, routeLength, 'restLength');
    const currentLength = nonnegativeLength(state?.length, routeLength, 'length');
    const wireDefault = Math.max(0.002, Math.min(0.012, restLength * 0.004));
    const wireLimit = Math.max(0.002, routeLength * 0.1);
    const explicitWire = visual?.wireRadius;
    if (explicitWire !== undefined && (typeof explicitWire !== 'number' || !Number.isFinite(explicitWire) || explicitWire <= 0 || explicitWire > 100)) {
      throw new RangeError('Tendon wireRadius must be finite, positive, and at most 100.');
    }
    const wireRadius = explicitWire ?? Math.min(100, wireLimit, wireDefault);
    const coilDefault = Math.max(wireRadius * 2, restLength * 0.06);
    const coilLimit = Math.max(wireRadius * 2, Math.min(1000, restLength * 0.2, routeLength * 0.22));
    const explicitCoil = visual?.coilRadius;
    if (explicitCoil !== undefined && (typeof explicitCoil !== 'number' || !Number.isFinite(explicitCoil) || explicitCoil <= 0 || explicitCoil > 1000)) {
      throw new RangeError('Tendon coilRadius must be finite, positive, and at most 1000.');
    }
    const coilRadius = explicitCoil ?? Math.max(wireRadius * 2, Math.min(coilLimit, coilDefault));
    const turnsValue = visual?.turns;
    if (turnsValue !== undefined && (typeof turnsValue !== 'number' || !Number.isInteger(turnsValue) || turnsValue < 2 || turnsValue > 64)) {
      throw new RangeError('Tendon turns must be an integer from 2 through 64.');
    }
    const turns = turnsValue ?? 8;
    const forceScaleValue = visual?.forceScale;
    if (forceScaleValue !== undefined && (typeof forceScaleValue !== 'number' || !Number.isFinite(forceScaleValue) || forceScaleValue <= 0 || forceScaleValue > 1e12)) {
      throw new RangeError('Tendon forceScale must be finite, positive, and at most 1e12.');
    }
    const forceScale = forceScaleValue ?? 25;
    const force = state?.force;
    if (force !== undefined && force !== null && (typeof force !== 'number' || !Number.isFinite(force))) {
      throw new RangeError('Tendon force must be finite or unavailable.');
    }
    const hasForce = typeof force === 'number' && force !== 0;
    if (hasForce && routeLength > 0 && maxPositionComponent + routeLength * 0.25 + coilRadius + wireRadius * 5 > MAX_FLOAT32_COORDINATE) {
      throw new RangeError('Tendon force cue exceeds the finite Float32 render range.');
    }
    const strength = hasForce ? forceStrength(force!, forceScale) : 0;
    const isTension = hasForce && force! > 0;
    const cueStrength = strength * 0.55;
    this.cueColor.copy(this.routeColor).lerp(isTension ? this.tensionColor : this.compressionColor, cueStrength);
    this.pickMaterial.color.copy(this.routeColor);

    this.routeLength = routeLength;
    this.buildRouteFrames();
    const mode = state?.mode ?? 'fixed';
    const slack = mode === 'rope' ? Math.max(0, restLength - currentLength) : 0;
    this.buildCenterline(mode, turns, coilRadius, freeLength, slack);
    this.buildTube(wireRadius, mode !== 'spring');
    this.buildPickLine(wireRadius);
    if (hasForce && routeLength > 0) {
      this.updateArrow(0, 0.3, force! > 0 ? 1 : -1, strength, wireRadius, coilRadius, mode, isTension);
      this.updateArrow(1, 0.7, force! > 0 ? -1 : 1, strength, wireRadius, coilRadius, mode, isTension);
    } else {
      this.hideArrow(0);
      this.hideArrow(1);
    }
  }

  override raycast(raycaster: Raycaster, intersections: Intersection[]): void {
    if (this.disposed || !this.visible) return;
    this.updateWorldMatrix(false, true);
    for (const child of this.children) {
      if (child.visible) child.raycast(raycaster, intersections);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.bodyGeometry.dispose();
    this.bodyMaterial.dispose();
    this.pickGeometry.dispose();
    this.pickMaterial.dispose();
    for (let index = 0; index < this.arrowGeometries.length; index += 1) {
      this.arrowGeometries[index].dispose();
      this.arrowMaterials[index].dispose();
    }
  }

  private ensureRouteCapacity(points: number): void {
    if (points <= this.routeCapacity) return;
    this.routeCapacity = nextCapacity(this.routeCapacity, points, MAX_ROUTE_POINTS);
    this.route = new Float64Array(this.routeCapacity * 3);
    this.routeTangents = new Float64Array(this.routeCapacity * 3);
    this.routeNormals = new Float64Array(this.routeCapacity * 3);
    this.edgeLengths = new Float64Array(this.routeCapacity - 1);
    this.edgeWrapped = new Uint8Array(this.routeCapacity - 1);
  }
  private ensureBodyCapacity(rings: number): void {
    if (rings <= this.ringCapacity) return;
    // Release uploaded buffers before replacing their attributes on a larger route.
    if (this.bodyPositionAttribute) this.bodyGeometry.dispose();
    this.ringCapacity = nextCapacity(this.ringCapacity, rings, MAX_RINGS);
    const vertices = this.ringCapacity * SIDES + 2;
    this.bodyPositions = new Float32Array(vertices * 3);
    this.bodyNormals = new Float32Array(vertices * 3);
    this.bodyColors = new Float32Array(vertices * 3);
    this.bodyIndices = new Uint16Array((this.ringCapacity - 1) * SIDES * 6 + SIDES * 6);
    this.indexedRingCount = 0;
    this.bodyPositionAttribute = new BufferAttribute(this.bodyPositions, 3).setUsage(DynamicDrawUsage);
    this.bodyNormalAttribute = new BufferAttribute(this.bodyNormals, 3).setUsage(DynamicDrawUsage);
    this.bodyColorAttribute = new BufferAttribute(this.bodyColors, 3).setUsage(DynamicDrawUsage);
    this.bodyIndexAttribute = new BufferAttribute(this.bodyIndices, 1).setUsage(DynamicDrawUsage);
    this.bodyGeometry.setAttribute('position', this.bodyPositionAttribute);
    this.bodyGeometry.setAttribute('normal', this.bodyNormalAttribute);
    this.bodyGeometry.setAttribute('color', this.bodyColorAttribute);
    this.bodyGeometry.setIndex(this.bodyIndexAttribute);
  }

  private ensurePickCapacity(points: number): void {
    if (points <= this.pickCapacity) return;
    if (this.pickPositionAttribute) this.pickGeometry.dispose();
    this.pickCapacity = nextCapacity(this.pickCapacity, points, MAX_RINGS);
    this.pickPositions = new Float32Array(this.pickCapacity * 3);
    this.pickPositionAttribute = new BufferAttribute(this.pickPositions, 3).setUsage(DynamicDrawUsage);
    this.pickGeometry.setAttribute('position', this.pickPositionAttribute);
  }
  private ensureSampleCapacity(points: number): void {
    if (points <= this.sampleCapacity) return;
    this.sampleCapacity = nextCapacity(this.sampleCapacity, points, MAX_RINGS);
    const samples = new Float64Array(this.sampleCapacity * 3);
    samples.set(this.samples);
    this.samples = samples;
    this.sampleDistances = new Float64Array(this.sampleCapacity);
    this.sampleTangents = new Float64Array(this.sampleCapacity * 3);
    this.sampleNormals = new Float64Array(this.sampleCapacity * 3);
    this.sampleBinormals = new Float64Array(this.sampleCapacity * 3);
  }

  private buildRouteFrames(): void {
    for (let point = 0; point < this.routeCount; point += 1) {
      const offset = point * 3;
      const prev = Math.max(0, point - 1) * 3;
      const next = Math.min(this.routeCount - 1, point + 1) * 3;
      const tx = this.route[next] - this.route[prev];
      const ty = this.route[next + 1] - this.route[prev + 1];
      const tz = this.route[next + 2] - this.route[prev + 2];
      const length = Math.hypot(tx, ty, tz);
      if (length > 1e-10) {
        this.routeTangents[offset] = tx / length;
        this.routeTangents[offset + 1] = ty / length;
        this.routeTangents[offset + 2] = tz / length;
      } else {
        this.routeTangents[offset] = 0;
        this.routeTangents[offset + 1] = 0;
        this.routeTangents[offset + 2] = 0;
      }
    }
    let hasTangent = false;
    let tx = 0; let ty = 0; let tz = 0;
    for (let point = 0; point < this.routeCount; point += 1) {
      const offset = point * 3;
      if (this.routeTangents[offset] !== 0 || this.routeTangents[offset + 1] !== 0 || this.routeTangents[offset + 2] !== 0) {
        tx = this.routeTangents[offset]; ty = this.routeTangents[offset + 1]; tz = this.routeTangents[offset + 2];
        hasTangent = true;
      } else if (hasTangent) {
        this.routeTangents[offset] = tx; this.routeTangents[offset + 1] = ty; this.routeTangents[offset + 2] = tz;
      }
    }
    hasTangent = false;
    for (let point = this.routeCount - 1; point >= 0; point -= 1) {
      const offset = point * 3;
      if (this.routeTangents[offset] !== 0 || this.routeTangents[offset + 1] !== 0 || this.routeTangents[offset + 2] !== 0) {
        tx = this.routeTangents[offset]; ty = this.routeTangents[offset + 1]; tz = this.routeTangents[offset + 2];
        hasTangent = true;
      } else if (hasTangent) {
        this.routeTangents[offset] = tx; this.routeTangents[offset + 1] = ty; this.routeTangents[offset + 2] = tz;
      } else {
        this.routeTangents[offset] = this.hasPreviousFrame ? this.previousFrameTangent.x : 1;
        this.routeTangents[offset + 1] = this.hasPreviousFrame ? this.previousFrameTangent.y : 0;
        this.routeTangents[offset + 2] = this.hasPreviousFrame ? this.previousFrameTangent.z : 0;
      }
    }

    const firstTx = this.routeTangents[0];
    const firstTy = this.routeTangents[1];
    const firstTz = this.routeTangents[2];
    if (this.hasPreviousFrame) {
      transportNormal(
        this.previousFrameTangent.x, this.previousFrameTangent.y, this.previousFrameTangent.z,
        firstTx, firstTy, firstTz,
        this.previousFrameNormal.x, this.previousFrameNormal.y, this.previousFrameNormal.z,
        this.routeNormals, 0,
      );
    } else {
      perpendicular(firstTx, firstTy, firstTz, this.routeNormals, 0);
    }
    this.previousFrameTangent.set(firstTx, firstTy, firstTz);
    this.previousFrameNormal.set(this.routeNormals[0], this.routeNormals[1], this.routeNormals[2]);
    this.hasPreviousFrame = true;

    for (let point = 1; point < this.routeCount; point += 1) {
      const offset = point * 3;
      transportNormal(
        this.routeTangents[offset - 3], this.routeTangents[offset - 2], this.routeTangents[offset - 1],
        this.routeTangents[offset], this.routeTangents[offset + 1], this.routeTangents[offset + 2],
        this.routeNormals[offset - 3], this.routeNormals[offset - 2], this.routeNormals[offset - 1],
        this.routeNormals, offset,
      );
    }
  }

  private buildCenterline(mode: TendonRenderState['mode'], turns: number, coilRadius: number, freeLength: number, slack: number): void {
    this.sampleCount = 0;
    this.appendSample(this.route[0], this.route[1], this.route[2]);
    let phaseTurns = 0;
    for (let edge = 0; edge < this.routeCount - 1; edge += 1) {
      const offset = edge * 3;
      const ax = this.route[offset];
      const ay = this.route[offset + 1];
      const az = this.route[offset + 2];
      const bx = this.route[offset + 3];
      const by = this.route[offset + 4];
      const bz = this.route[offset + 5];
      const length = this.edgeLengths[edge];
      const wrapped = this.edgeWrapped[edge] !== 0;
      if (mode === 'spring' && !wrapped && freeLength > 1e-10 && length > 1e-10) {
        const edgeTurns = turns * length / freeLength;
        const steps = Math.max(1, Math.ceil(edgeTurns * 16));
        const tx = (bx - ax) / length;
        const ty = (by - ay) / length;
        const tz = (bz - az) / length;
        const routeNormalOffset = offset;
        let nx = this.routeNormals[routeNormalOffset] - tx * (this.routeNormals[routeNormalOffset] * tx + this.routeNormals[routeNormalOffset + 1] * ty + this.routeNormals[routeNormalOffset + 2] * tz);
        let ny = this.routeNormals[routeNormalOffset + 1] - ty * (this.routeNormals[routeNormalOffset] * tx + this.routeNormals[routeNormalOffset + 1] * ty + this.routeNormals[routeNormalOffset + 2] * tz);
        let nz = this.routeNormals[routeNormalOffset + 2] - tz * (this.routeNormals[routeNormalOffset] * tx + this.routeNormals[routeNormalOffset + 1] * ty + this.routeNormals[routeNormalOffset + 2] * tz);
        let nLength = Math.hypot(nx, ny, nz);
        if (nLength < 1e-10) {
          perpendicular(tx, ty, tz, this.edgeNormalScratch, 0);
          nx = this.edgeNormalScratch[0]; ny = this.edgeNormalScratch[1]; nz = this.edgeNormalScratch[2];
          nLength = Math.hypot(nx, ny, nz) || 1;
        }
        nx /= nLength; ny /= nLength; nz /= nLength;
        const vx = ty * nz - tz * ny;
        const vy = tz * nx - tx * nz;
        const vz = tx * ny - ty * nx;
        const lead = 0.08;
        for (let step = 1; step <= steps; step += 1) {
          const t = step / steps;
          const envelope = Math.min(smoothstep(t / lead), smoothstep((1 - t) / lead));
          const angle = TAU * (phaseTurns + edgeTurns * t);
          const radius = coilRadius * envelope;
          const x = ax + (bx - ax) * t + radius * (Math.cos(angle) * nx + Math.sin(angle) * vx);
          const y = ay + (by - ay) * t + radius * (Math.cos(angle) * ny + Math.sin(angle) * vy);
          const z = az + (bz - az) * t + radius * (Math.cos(angle) * nz + Math.sin(angle) * vz);
          this.appendSample(step === steps ? bx : x, step === steps ? by : y, step === steps ? bz : z);
        }
        phaseTurns += edgeTurns;
      } else if (mode === 'rope' && !wrapped && slack > 0 && length > 1e-10) {
        const tx = (bx - ax) / length;
        const ty = (by - ay) / length;
        const tz = (bz - az) / length;
        const routeNormalOffset = offset;
        let nx = this.routeNormals[routeNormalOffset];
        let ny = this.routeNormals[routeNormalOffset + 1];
        let nz = this.routeNormals[routeNormalOffset + 2];
        const projection = nx * tx + ny * ty + nz * tz;
        nx -= tx * projection; ny -= ty * projection; nz -= tz * projection;
        const nLength = Math.hypot(nx, ny, nz);
        if (nLength > 1e-10) { nx /= nLength; ny /= nLength; nz /= nLength; }
        else {
          perpendicular(tx, ty, tz, this.edgeNormalScratch, 0);
          nx = this.edgeNormalScratch[0]; ny = this.edgeNormalScratch[1]; nz = this.edgeNormalScratch[2];
        }
        const ratio = Math.min(1, slack / length);
        const sag = length * Math.min(0.2, Math.sqrt(ratio / 6));
        const steps = Math.max(8, Math.ceil(64 * length / this.routeLength));
        for (let step = 1; step <= steps; step += 1) {
          const t = step / steps;
          const bow = sag * Math.sin(Math.PI * t);
          this.appendSample(step === steps ? bx : ax + (bx - ax) * t + nx * bow,
            step === steps ? by : ay + (by - ay) * t + ny * bow, step === steps ? bz : az + (bz - az) * t + nz * bow);
        }
      } else {
        const steps = wrapped || mode === 'spring' || length === 0 ? 1 : Math.max(1, Math.ceil(64 * length / this.routeLength));
        for (let step = 1; step <= steps; step++) {
          const t = step / steps;
          this.appendSample(step === steps ? bx : ax + (bx - ax) * t,
            step === steps ? by : ay + (by - ay) * t, step === steps ? bz : az + (bz - az) * t);
        }
      }
    }
    if (this.sampleCount < 2) this.appendSample(this.route[0], this.route[1], this.route[2]);
    this.buildSampleFrames();
  }

  private appendSample(x: number, y: number, z: number): void {
    if (this.sampleCount >= MAX_RINGS) throw new RangeError(`Tendon visual exceeds ${MAX_RINGS} centerline rings.`);
    this.ensureSampleCapacity(this.sampleCount + 1);
    const offset = this.sampleCount * 3;
    this.samples[offset] = renderCoordinate(x);
    this.samples[offset + 1] = renderCoordinate(y);
    this.samples[offset + 2] = renderCoordinate(z);
    this.sampleCount += 1;
  }

  private buildSampleFrames(): void {
    this.sampleDistances[0] = 0;
    for (let point = 0; point < this.sampleCount; point += 1) {
      const offset = point * 3;
      const prev = Math.max(0, point - 1) * 3;
      const next = Math.min(this.sampleCount - 1, point + 1) * 3;
      let tx = this.samples[next] - this.samples[prev];
      let ty = this.samples[next + 1] - this.samples[prev + 1];
      let tz = this.samples[next + 2] - this.samples[prev + 2];
      let length = Math.hypot(tx, ty, tz);
      if (length < 1e-10 && point > 0) {
        tx = this.sampleTangents[offset - 3]; ty = this.sampleTangents[offset - 2]; tz = this.sampleTangents[offset - 1];
        length = 1;
      }
      if (length < 1e-10) {
        tx = this.routeTangents[0]; ty = this.routeTangents[1]; tz = this.routeTangents[2];
        length = 1;
      }
      this.sampleTangents[offset] = tx / length;
      this.sampleTangents[offset + 1] = ty / length;
      this.sampleTangents[offset + 2] = tz / length;
      if (point > 0) {
        this.sampleDistances[point] = this.sampleDistances[point - 1] + Math.hypot(
          this.samples[offset] - this.samples[offset - 3],
          this.samples[offset + 1] - this.samples[offset - 2],
          this.samples[offset + 2] - this.samples[offset - 1],
        );
      }
    }
    transportNormal(
      this.routeTangents[0], this.routeTangents[1], this.routeTangents[2],
      this.sampleTangents[0], this.sampleTangents[1], this.sampleTangents[2],
      this.routeNormals[0], this.routeNormals[1], this.routeNormals[2],
      this.sampleNormals, 0,
    );
    for (let point = 1; point < this.sampleCount; point += 1) {
      const offset = point * 3;
      transportNormal(
        this.sampleTangents[offset - 3], this.sampleTangents[offset - 2], this.sampleTangents[offset - 1],
        this.sampleTangents[offset], this.sampleTangents[offset + 1], this.sampleTangents[offset + 2],
        this.sampleNormals[offset - 3], this.sampleNormals[offset - 2], this.sampleNormals[offset - 1],
        this.sampleNormals, offset,
      );
    }
    for (let point = 0; point < this.sampleCount; point += 1) {
      const offset = point * 3;
      const tx = this.sampleTangents[offset];
      const ty = this.sampleTangents[offset + 1];
      const tz = this.sampleTangents[offset + 2];
      const nx = this.sampleNormals[offset];
      const ny = this.sampleNormals[offset + 1];
      const nz = this.sampleNormals[offset + 2];
      this.sampleBinormals[offset] = ty * nz - tz * ny;
      this.sampleBinormals[offset + 1] = tz * nx - tx * nz;
      this.sampleBinormals[offset + 2] = tx * ny - ty * nx;
    }
  }

  private buildTube(wireRadius: number, braided: boolean): void {
    const rings = Math.max(2, this.sampleCount);
    this.ensureBodyCapacity(rings);
    let minX = Infinity; let minY = Infinity; let minZ = Infinity;
    let maxX = -Infinity; let maxY = -Infinity; let maxZ = -Infinity;
    const totalLength = this.sampleDistances[this.sampleCount - 1];
    for (let ring = 0; ring < rings; ring += 1) {
      const offset = ring * 3;
      const centerX = this.samples[offset];
      const centerY = this.samples[offset + 1];
      const centerZ = this.samples[offset + 2];
      const nx = this.sampleNormals[offset];
      const ny = this.sampleNormals[offset + 1];
      const nz = this.sampleNormals[offset + 2];
      const bx = this.sampleBinormals[offset];
      const by = this.sampleBinormals[offset + 1];
      const bz = this.sampleBinormals[offset + 2];
      const progress = totalLength > 1e-10 ? this.sampleDistances[ring] / totalLength : 0;
      for (let side = 0; side < SIDES; side += 1) {
        const angle = TAU * side / SIDES;
        const cosine = Math.cos(angle);
        const sine = Math.sin(angle);
        const braid = braided ? 1 + 0.055 * Math.cos(2 * angle - TAU * progress * 5) : 1;
        const radialX = cosine * nx + sine * bx;
        const radialY = cosine * ny + sine * by;
        const radialZ = cosine * nz + sine * bz;
        const radius = wireRadius * braid;
        const vertex = ring * SIDES + side;
        const vertexOffset = vertex * 3;
        const x = centerX + radialX * radius;
        const y = centerY + radialY * radius;
        const z = centerZ + radialZ * radius;
        this.bodyPositions[vertexOffset] = x;
        this.bodyPositions[vertexOffset + 1] = y;
        this.bodyPositions[vertexOffset + 2] = z;
        this.bodyNormals[vertexOffset] = radialX;
        this.bodyNormals[vertexOffset + 1] = radialY;
        this.bodyNormals[vertexOffset + 2] = radialZ;
        const shade = braided ? 0.86 + 0.14 * Math.cos(3 * angle - TAU * progress * 4) : 1;
        this.bodyColors[vertexOffset] = this.cueColor.r * shade;
        this.bodyColors[vertexOffset + 1] = this.cueColor.g * shade;
        this.bodyColors[vertexOffset + 2] = this.cueColor.b * shade;
        minX = Math.min(minX, this.bodyPositions[vertexOffset]); minY = Math.min(minY, this.bodyPositions[vertexOffset + 1]); minZ = Math.min(minZ, this.bodyPositions[vertexOffset + 2]);
        maxX = Math.max(maxX, this.bodyPositions[vertexOffset]); maxY = Math.max(maxY, this.bodyPositions[vertexOffset + 1]); maxZ = Math.max(maxZ, this.bodyPositions[vertexOffset + 2]);
      }
    }
    const firstCenter = rings * SIDES;
    const lastCenter = firstCenter + 1;
    for (let cap = 0; cap < 2; cap += 1) {
      const ring = cap === 0 ? 0 : rings - 1;
      const pointOffset = ring * 3;
      const vertex = cap === 0 ? firstCenter : lastCenter;
      const vertexOffset = vertex * 3;
      const tx = this.sampleTangents[pointOffset] * (cap === 0 ? -1 : 1);
      const ty = this.sampleTangents[pointOffset + 1] * (cap === 0 ? -1 : 1);
      const tz = this.sampleTangents[pointOffset + 2] * (cap === 0 ? -1 : 1);
      this.bodyPositions[vertexOffset] = this.samples[pointOffset];
      this.bodyPositions[vertexOffset + 1] = this.samples[pointOffset + 1];
      this.bodyPositions[vertexOffset + 2] = this.samples[pointOffset + 2];
      this.bodyNormals[vertexOffset] = tx; this.bodyNormals[vertexOffset + 1] = ty; this.bodyNormals[vertexOffset + 2] = tz;
      this.bodyColors[vertexOffset] = this.cueColor.r; this.bodyColors[vertexOffset + 1] = this.cueColor.g; this.bodyColors[vertexOffset + 2] = this.cueColor.b;
      minX = Math.min(minX, this.bodyPositions[vertexOffset]); minY = Math.min(minY, this.bodyPositions[vertexOffset + 1]); minZ = Math.min(minZ, this.bodyPositions[vertexOffset + 2]);
      maxX = Math.max(maxX, this.bodyPositions[vertexOffset]); maxY = Math.max(maxY, this.bodyPositions[vertexOffset + 1]); maxZ = Math.max(maxZ, this.bodyPositions[vertexOffset + 2]);
    }
    if (this.indexedRingCount !== rings) {
      let index = 0;
      for (let ring = 0; ring < rings - 1; ring += 1) {
        for (let side = 0; side < SIDES; side += 1) {
          const next = (side + 1) % SIDES;
          const a = ring * SIDES + side;
          const b = ring * SIDES + next;
          const c = (ring + 1) * SIDES + side;
          const d = (ring + 1) * SIDES + next;
          this.bodyIndices[index++] = a; this.bodyIndices[index++] = b; this.bodyIndices[index++] = c;
          this.bodyIndices[index++] = b; this.bodyIndices[index++] = d; this.bodyIndices[index++] = c;
        }
      }
      for (let side = 0; side < SIDES; side += 1) {
        const next = (side + 1) % SIDES;
        const last = (rings - 1) * SIDES;
        this.bodyIndices[index++] = firstCenter; this.bodyIndices[index++] = next; this.bodyIndices[index++] = side;
        this.bodyIndices[index++] = lastCenter; this.bodyIndices[index++] = last + side; this.bodyIndices[index++] = last + next;
      }
      this.indexedRingCount = rings;
      this.bodyIndexAttribute!.needsUpdate = true;
    }
    this.bodyGeometry.setDrawRange(0, rings * SIDES * 6);
    this.bodyPositionAttribute!.needsUpdate = true;
    this.bodyNormalAttribute!.needsUpdate = true;
    this.bodyColorAttribute!.needsUpdate = true;
    setBounds(this.bodyBounds, this.bodySphere, minX, minY, minZ, maxX, maxY, maxZ);
    this.bodyGeometry.boundingBox = this.bodyBounds;
    this.bodyGeometry.boundingSphere = this.bodySphere;
  }


  private buildPickLine(wireRadius: number): void {
    this.ensurePickCapacity(this.sampleCount);
    for (let point = 0; point < this.sampleCount; point += 1) {
      const offset = point * 3;
      this.pickPositions[offset] = this.samples[offset];
      this.pickPositions[offset + 1] = this.samples[offset + 1];
      this.pickPositions[offset + 2] = this.samples[offset + 2];
    }
    this.pickGeometry.setDrawRange(0, this.sampleCount);
    this.pickPositionAttribute!.needsUpdate = true;
    setBounds(this.lineBounds, this.lineSphere,
      this.bodyBounds.min.x - wireRadius, this.bodyBounds.min.y - wireRadius, this.bodyBounds.min.z - wireRadius,
      this.bodyBounds.max.x + wireRadius, this.bodyBounds.max.y + wireRadius, this.bodyBounds.max.z + wireRadius);
    this.pickGeometry.boundingBox = this.lineBounds;
    this.pickGeometry.boundingSphere = this.lineSphere;
  }

  private initializeArrow(geometry: BufferGeometry): void {
    const positions = new Float32Array(ARROW_VERTICES * 3);
    const normals = new Float32Array(ARROW_VERTICES * 3);
    const indices = new Uint16Array(ARROW_SIDES * 6 + ARROW_SIDES * 3 + ARROW_SIDES * 6 + ARROW_SIDES * 3);
    geometry.setAttribute('position', new BufferAttribute(positions, 3).setUsage(DynamicDrawUsage));
    geometry.setAttribute('normal', new BufferAttribute(normals, 3).setUsage(DynamicDrawUsage));
    geometry.setIndex(new BufferAttribute(indices, 1));
    let index = 0;
    for (let side = 0; side < ARROW_SIDES; side += 1) {
      const next = (side + 1) % ARROW_SIDES;
      const a = side;
      const b = next;
      const c = ARROW_SIDES + side;
      const d = ARROW_SIDES + next;
      indices[index++] = a; indices[index++] = b; indices[index++] = c;
      indices[index++] = b; indices[index++] = d; indices[index++] = c;
      indices[index++] = 24 + side; indices[index++] = 24 + next; indices[index++] = 36;
      indices[index++] = 37 + side; indices[index++] = 49 + side; indices[index++] = 37 + next;
      indices[index++] = 37 + next; indices[index++] = 49 + side; indices[index++] = 49 + next;
      indices[index++] = 61; indices[index++] = next; indices[index++] = side;
    }
    geometry.setDrawRange(0, index);
    geometry.boundingBox = new Box3();
    geometry.boundingSphere = new Sphere();
  }

  private updateArrow(index: 0 | 1, fraction: number, directionSign: number, strength: number, wireRadius: number, coilRadius: number, mode: TendonRenderState['mode'], tension: boolean): void {
    let remaining = this.routeLength * fraction;
    let edge = 0;
    while (edge < this.routeCount - 1 && remaining > this.edgeLengths[edge]) {
      remaining -= this.edgeLengths[edge];
      edge += 1;
    }
    edge = Math.min(edge, this.routeCount - 2);
    const edgeLength = this.edgeLengths[edge];
    const offset = edge * 3;
    const t = edgeLength > 1e-10 ? Math.max(0, Math.min(1, remaining / edgeLength)) : 0;
    const ax = this.route[offset]; const ay = this.route[offset + 1]; const az = this.route[offset + 2];
    const bx = this.route[offset + 3]; const by = this.route[offset + 4]; const bz = this.route[offset + 5];
    let tx = edgeLength > 1e-10 ? (bx - ax) / edgeLength : this.routeTangents[offset];
    let ty = edgeLength > 1e-10 ? (by - ay) / edgeLength : this.routeTangents[offset + 1];
    let tz = edgeLength > 1e-10 ? (bz - az) / edgeLength : this.routeTangents[offset + 2];
    tx *= directionSign; ty *= directionSign; tz *= directionSign;
    let nx = this.routeNormals[offset];
    let ny = this.routeNormals[offset + 1];
    let nz = this.routeNormals[offset + 2];
    const projection = nx * tx + ny * ty + nz * tz;
    nx -= tx * projection; ny -= ty * projection; nz -= tz * projection;
    const normalLength = Math.hypot(nx, ny, nz);
    if (normalLength > 1e-10) { nx /= normalLength; ny /= normalLength; nz /= normalLength; }
    else {
      perpendicular(tx, ty, tz, this.edgeNormalScratch, 0);
      nx = this.edgeNormalScratch[0]; ny = this.edgeNormalScratch[1]; nz = this.edgeNormalScratch[2];
    }
    if (index === 1) { nx = -nx; ny = -ny; nz = -nz; }
    const coilOffset = mode === 'spring' && this.edgeWrapped[edge] === 0 ? coilRadius : 0;
    const offsetDistance = coilOffset + wireRadius * 3;
    const baseX = ax + (bx - ax) * t + nx * offsetDistance;
    const baseY = ay + (by - ay) * t + ny * offsetDistance;
    const baseZ = az + (bz - az) * t + nz * offsetDistance;
    const arrowLength = this.routeLength * 0.25 * strength;
    const shaftRadius = Math.min(Math.max(wireRadius * 0.65, arrowLength * 0.02), arrowLength * 0.08);
    const headRadius = shaftRadius * 2.6;
    const vx = ty * nz - tz * ny;
    const vy = tz * nx - tx * nz;
    const vz = tx * ny - ty * nx;
    const geometry = this.arrowGeometries[index];
    const positions = geometry.getAttribute('position').array as Float32Array;
    const normals = geometry.getAttribute('normal').array as Float32Array;
    const shaftEnd = arrowLength * 0.62;
    const bounds = this.arrowBounds[index];
    bounds.makeEmpty();
    for (let side = 0; side < ARROW_SIDES; side += 1) {
      const angle = TAU * side / ARROW_SIDES;
      const cosine = Math.cos(angle); const sine = Math.sin(angle);
      const radialX = nx * cosine + vx * sine;
      const radialY = ny * cosine + vy * sine;
      const radialZ = nz * cosine + vz * sine;
      this.writeArrowVertex(index, positions, normals, side, baseX, baseY, baseZ, tx, ty, tz, radialX, radialY, radialZ, 0, shaftRadius, 1);
      this.writeArrowVertex(index, positions, normals, ARROW_SIDES + side, baseX, baseY, baseZ, tx, ty, tz, radialX, radialY, radialZ, shaftEnd, shaftRadius, 1);
      const coneLength = Math.max(arrowLength - shaftEnd, 1e-8);
      const coneNormalLength = Math.hypot(coneLength, headRadius);
      this.writeArrowVertex(index, positions, normals, 24 + side, baseX, baseY, baseZ, tx, ty, tz, radialX, radialY, radialZ, shaftEnd, headRadius, coneLength / coneNormalLength, headRadius / coneNormalLength);
      this.writeArrowVertex(index, positions, normals, 37 + side, baseX, baseY, baseZ, tx, ty, tz, radialX, radialY, radialZ, shaftEnd, headRadius, 0, -1);
      this.writeArrowVertex(index, positions, normals, 49 + side, baseX, baseY, baseZ, tx, ty, tz, radialX, radialY, radialZ, shaftEnd, shaftRadius, 0, -1);
    }
    this.writeArrowVertex(index, positions, normals, 36, baseX, baseY, baseZ, tx, ty, tz, 0, 0, 0, arrowLength, 0, 0, 1);
    this.writeArrowVertex(index, positions, normals, 61, baseX, baseY, baseZ, tx, ty, tz, 0, 0, 0, 0, 0, 0, -1);
    this.arrowMaterials[index].color.copy(tension ? this.tensionColor : this.compressionColor);
    bounds.getBoundingSphere(this.arrowSpheres[index]);
    geometry.boundingBox = bounds;
    geometry.boundingSphere = this.arrowSpheres[index];
    (geometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
    (geometry.getAttribute('normal') as BufferAttribute).needsUpdate = true;
    this.arrows[index].visible = true;
    this.arrows[index].updateMatrix();
  }

  private writeArrowVertex(
    arrow: 0 | 1, positions: Float32Array, normals: Float32Array, vertex: number,
    baseX: number, baseY: number, baseZ: number,
    tx: number, ty: number, tz: number,
    radialX: number, radialY: number, radialZ: number,
    axial: number, radius: number, radialNormal: number, axialNormal = 0,
  ): void {
    const offset = vertex * 3;
    const x = baseX + tx * axial + radialX * radius;
    const y = baseY + ty * axial + radialY * radius;
    const z = baseZ + tz * axial + radialZ * radius;
    positions[offset] = x; positions[offset + 1] = y; positions[offset + 2] = z;
    normals[offset] = radialX * radialNormal + tx * axialNormal;
    normals[offset + 1] = radialY * radialNormal + ty * axialNormal;
    normals[offset + 2] = radialZ * radialNormal + tz * axialNormal;
    const bounds = this.arrowBounds[arrow];
    bounds.min.x = Math.min(bounds.min.x, positions[offset]); bounds.min.y = Math.min(bounds.min.y, positions[offset + 1]); bounds.min.z = Math.min(bounds.min.z, positions[offset + 2]);
    bounds.max.x = Math.max(bounds.max.x, positions[offset]); bounds.max.y = Math.max(bounds.max.y, positions[offset + 1]); bounds.max.z = Math.max(bounds.max.z, positions[offset + 2]);
  }

  private hideArrow(index: 0 | 1): void {
    this.arrows[index].visible = false;
    this.arrowBounds[index].copy(this.bodyBounds);
    this.arrowSpheres[index].copy(this.bodySphere);
    this.arrowGeometries[index].boundingBox = this.arrowBounds[index];
    this.arrowGeometries[index].boundingSphere = this.arrowSpheres[index];
  }
}
