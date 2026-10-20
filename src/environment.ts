import {
  DataTexture,
  DirectionalLight,
  HemisphereLight,
  DoubleSide,
  LinearFilter,
  LinearMipmapLinearFilter,
  MeshStandardMaterial,
  NoColorSpace,
  PlaneGeometry,
  Quaternion,
  RepeatWrapping,
  RGBAFormat,
  SRGBColorSpace,
  TextureLoader,
  UVMapping,
  UnsignedByteType,
  Vector3,
} from 'three';
import type { Mesh, Scene, Texture, WebGLRenderer } from 'three';
import type { Appearance } from '../shared/appearance.ts';
import asphaltColor from './assets/environment/asphalt-color-4k.webp';
import asphaltNormal from './assets/environment/asphalt-normal-2k.webp';
import asphaltPreview from './assets/environment/asphalt-128.webp';
import asphaltRoughness from './assets/environment/asphalt-roughness-2k.webp';
import concreteColor from './assets/environment/concrete-color-4k.webp';
import concreteNormal from './assets/environment/concrete-normal-2k.webp';
import concretePreview from './assets/environment/concrete-128.webp';
import concreteRoughness from './assets/environment/concrete-roughness-2k.webp';
import iceColor from './assets/environment/ice-color-4k.webp';
import iceNormal from './assets/environment/ice-normal-2k.webp';
import icePreview from './assets/environment/ice-128.webp';
import iceRoughness from './assets/environment/ice-roughness-2k.webp';
import plainPreview from './assets/environment/plain-128.webp';
import stoneColor from './assets/environment/stone-color-4k.webp';
import stoneNormal from './assets/environment/stone-normal-2k.webp';
import stonePreview from './assets/environment/stone-128.webp';
import stoneRoughness from './assets/environment/stone-roughness-2k.webp';
import rubberColor from './assets/environment/rubber-color-4k.webp';
import rubberNormal from './assets/environment/rubber-normal-2k.webp';
import rubberPreview from './assets/environment/rubber-128.webp';
import rubberRoughness from './assets/environment/rubber-roughness-2k.webp';

export const SURFACE_PREVIEWS: Record<Appearance['surface'], string> = {
  ice: icePreview,
  stone: stonePreview,
  concrete: concretePreview,
  asphalt: asphaltPreview,
  rubber: rubberPreview,
  plain: plainPreview,
};

type SurfaceId = Appearance['surface'];
type SkyId = Appearance['sky'];
type SurfaceDefinition = {
  label: string;
  color: number;
  roughness: number;
  normalStrength: number;
  tileMeters: number;
  colorMap?: string;
  normalMap?: string;
  roughnessMap?: string;
};

type SkyDefinition = {
  top: number;
  horizon: number;
  bottom: number;
  hemisphereSky: number;
  hemisphereGround: number;
  hemisphereIntensity: number;
  keyColor: number;
  keyIntensity: number;
  fillColor: number;
  fillIntensity: number;
};

type LoadState = { error: Error | null };
type PlaneState = {
  originalMaterial: Mesh['material'];
  repeatX: number;
  repeatY: number;
};

const SURFACES: Record<SurfaceId, SurfaceDefinition> = {
  ice: {
    // shortcut: Ice 003 has no physical scale, 1 m repeats until calibrated ice dimensions are available.
    label: 'Ice 003', color: 0xf1f8fa, roughness: 0.32, normalStrength: 0.26, tileMeters: 1,
    colorMap: iceColor, normalMap: iceNormal, roughnessMap: iceRoughness,
  },
  stone: {
    label: 'Marble 01', color: 0xf6f2e9, roughness: 0.72, normalStrength: 0.32, tileMeters: 1.5,
    colorMap: stoneColor, normalMap: stoneNormal, roughnessMap: stoneRoughness,
  },
  concrete: {
    label: 'Rough Concrete', color: 0xf1f2ee, roughness: 0.84, normalStrength: 0.42, tileMeters: 1.23,
    colorMap: concreteColor, normalMap: concreteNormal, roughnessMap: concreteRoughness,
  },
  asphalt: {
    label: 'Clean Asphalt', color: 0xf2f3f0, roughness: 0.86, normalStrength: 0.34, tileMeters: 2.1,
    colorMap: asphaltColor, normalMap: asphaltNormal, roughnessMap: asphaltRoughness,
  },
  rubber: {
    label: 'Rubber Tiles', color: 0xf2f3f1, roughness: 0.8, normalStrength: 0.3, tileMeters: 2,
    colorMap: rubberColor, normalMap: rubberNormal, roughnessMap: rubberRoughness,
  },
  plain: { label: 'Plain', color: 0xd7dedd, roughness: 0.82, normalStrength: 0, tileMeters: 1 },
};

// Static sky/lighting presets; these are not physically based atmospheric scattering.
const SKIES: Record<SkyId, SkyDefinition> = {
  studio: {
    top: 0xcbdde3, horizon: 0xf5f6f2, bottom: 0xd1dad9,
    hemisphereSky: 0xf2f7f8, hemisphereGround: 0x8d9997, hemisphereIntensity: 1.3,
    keyColor: 0xfffdf8, keyIntensity: 1.85, fillColor: 0xaac2c7, fillIntensity: 0.72,
  },
  day: {
    top: 0x78b3d9, horizon: 0xf1f4ef, bottom: 0xdce4e1,
    hemisphereSky: 0xeaf5ff, hemisphereGround: 0x87918e, hemisphereIntensity: 1.2,
    keyColor: 0xfff8eb, keyIntensity: 2.1, fillColor: 0xa8c9dc, fillIntensity: 0.65,
  },
  overcast: {
    top: 0xa4b4bc, horizon: 0xe9edec, bottom: 0xcbd4d4,
    hemisphereSky: 0xe6edef, hemisphereGround: 0x929d9b, hemisphereIntensity: 1.45,
    keyColor: 0xf5f7f6, keyIntensity: 1.15, fillColor: 0xd4e0e2, fillIntensity: 0.9,
  },
  sunset: {
    top: 0x58698b, horizon: 0xf0a878, bottom: 0xd29079,
    hemisphereSky: 0xd5b6a7, hemisphereGround: 0x727b84, hemisphereIntensity: 1.15,
    keyColor: 0xffbd88, keyIntensity: 1.9, fillColor: 0x91aec4, fillIntensity: 0.78,
  },
};

const SKY_WIDTH = 1;
const SKY_HEIGHT = 128;
const HORIZONTAL_NORMAL_DOT = 0.9995;

function channel(color: number, shift: number): number {
  return (color >> shift) & 0xff;
}

function paintGradient(data: Uint8Array, sky: SkyDefinition): void {
  for (let y = 0; y < SKY_HEIGHT; y += 1) {
    const amount = y / (SKY_HEIGHT - 1);
    const from = amount < 0.5 ? sky.bottom : sky.horizon;
    const to = amount < 0.5 ? sky.horizon : sky.top;
    const mix = amount < 0.5 ? amount * 2 : (amount - 0.5) * 2;
    const offset = y * 4;
    data[offset] = Math.round(channel(from, 16) * (1 - mix) + channel(to, 16) * mix);
    data[offset + 1] = Math.round(channel(from, 8) * (1 - mix) + channel(to, 8) * mix);
    data[offset + 2] = Math.round(channel(from, 0) * (1 - mix) + channel(to, 0) * mix);
    data[offset + 3] = 255;
  }
}

function describeLoadError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  if (error && typeof error === 'object') {
    const message = 'message' in error ? error.message : undefined;
    if (typeof message === 'string' && message) return message;
    const type = 'type' in error ? error.type : undefined;
    if (typeof type === 'string' && type) return `${type} event`;
  }
  return 'unknown image loading error';
}

export class SceneEnvironment {
  private readonly previousBackground: Scene['background'];
  private readonly scene: Scene;
  private readonly invalidate: (upload?: boolean) => void;
  private readonly onIssue: (message: string) => void;
  private readonly maxTextureSize: number;

  private readonly loader = new TextureLoader();
  private readonly groundMaterial = new MeshStandardMaterial({
    color: SURFACES.concrete.color,
    roughness: SURFACES.concrete.roughness,
    metalness: 0,
    transparent: false,
    opacity: 1,
    depthWrite: true,
    side: DoubleSide,
  });
  private readonly hemisphere = new HemisphereLight(0xffffff, 0x8d9997, 1.3);
  private readonly key = new DirectionalLight(0xfffdf8, 1.85);
  private readonly fill = new DirectionalLight(0xaac2c7, 0.72);
  private readonly skyData = new Uint8Array(SKY_WIDTH * SKY_HEIGHT * 4);
  private readonly skyTexture = new DataTexture(this.skyData, SKY_WIDTH, SKY_HEIGHT, RGBAFormat, UnsignedByteType);
  private readonly planeStates = new Map<Mesh, PlaneState>();
  private readonly ownedTextures = new Set<Texture>();
  private readonly worldPosition = new Vector3();
  private readonly worldQuaternion = new Quaternion();
  private readonly worldScale = new Vector3();
  private readonly planeNormal = new Vector3();
  private currentAppearance: Appearance | null = null;
  private sky: SkyId | null = null;
  private requestedSurface: SurfaceId | null = null;
  private loadGeneration = 0;
  private loadPromise: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(scene: Scene, renderer: WebGLRenderer, invalidate: (upload?: boolean) => void, onIssue: (message: string) => void) {
    this.scene = scene;
    this.invalidate = invalidate;
    this.onIssue = onIssue;
    this.maxTextureSize = Math.min(renderer.capabilities.maxTextureSize, window.matchMedia('(max-width: 640px)').matches ? 2048 : 4096);
    this.previousBackground = this.scene.background;
    this.maxAnisotropy = Math.max(1, renderer.capabilities.getMaxAnisotropy());
    this.groundMaterial.userData.environmentOwned = true;
    this.key.position.set(-4, -5, 8);
    this.fill.position.set(5, 4, 5);
    this.hemisphere.position.set(0, 0, 1);
    this.scene.add(this.hemisphere, this.key, this.fill);

    this.skyTexture.mapping = UVMapping;
    this.skyTexture.colorSpace = SRGBColorSpace;
    this.skyTexture.minFilter = LinearFilter;
    this.skyTexture.magFilter = LinearFilter;
    this.skyTexture.generateMipmaps = false;
    this.skyTexture.needsUpdate = true;
    this.scene.background = this.skyTexture;
    this.setSky('day', false);

  }

  private readonly maxAnisotropy: number;

  setAppearance(appearance: Appearance, planes: Mesh[]): void {
    if (this.disposed) return;
    this.currentAppearance = appearance;
    this.setSky(appearance.sky);
    this.setSurfaceStyle(appearance.surface);
    this.syncGround(planes);
    this.invalidate(true);
  }

  syncGround(planes: Mesh[]): void {
    if (this.disposed) return;
    const visibleGrounds = new Set<Mesh>();
    let changed = false;

    for (const plane of planes) {
      if (!(plane.geometry instanceof PlaneGeometry)) continue;
      plane.updateWorldMatrix(true, false);
      plane.matrixWorld.decompose(this.worldPosition, this.worldQuaternion, this.worldScale);
      this.planeNormal.set(0, 0, 1).applyQuaternion(this.worldQuaternion);
      if (Math.abs(this.planeNormal.z) < HORIZONTAL_NORMAL_DOT) continue;

      visibleGrounds.add(plane);
      let state = this.planeStates.get(plane);
      if (!state) {
        state = this.attachPlane(plane);
        changed = true;
      }
      const size = SURFACES[this.currentAppearance?.surface ?? 'concrete'].tileMeters;
      const { width, height } = plane.geometry.parameters;
      const repeatX = Math.abs(width * this.worldScale.x) / size;
      const repeatY = Math.abs(height * this.worldScale.y) / size;
      if (state.repeatX !== repeatX || state.repeatY !== repeatY) {
        this.setPlaneRepeat(plane, repeatX, repeatY);
        changed = true;
      }
      state.repeatX = repeatX;
      state.repeatY = repeatY;
    }

    for (const [plane] of this.planeStates) {
      if (visibleGrounds.has(plane)) continue;
      this.detachPlane(plane);
      changed = true;
    }

    if (changed) this.invalidate();
    this.ensureSurfaceTextures();
  }

  ready(): Promise<void> {
    return this.loadPromise;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.loadGeneration += 1;
    this.loadPromise = Promise.resolve();

    for (const plane of this.planeStates.keys()) this.detachPlane(plane);
    this.scene.remove(this.hemisphere, this.key, this.fill);
    if (this.scene.background === this.skyTexture) this.scene.background = this.previousBackground;
    this.skyTexture.dispose();
    this.releaseTextures();
    this.groundMaterial.dispose();
  }

  private setSurfaceStyle(surface: SurfaceId): void {
    const definition = SURFACES[surface];
    this.groundMaterial.color.setHex(definition.color);
    this.groundMaterial.roughness = definition.roughness;
    this.groundMaterial.normalScale.set(definition.normalStrength, definition.normalStrength);
  }

  private setSky(sky: SkyId, notify = true): void {
    if (this.sky === sky) return;
    const definition = SKIES[sky];
    paintGradient(this.skyData, definition);
    this.skyTexture.needsUpdate = true;
    this.hemisphere.color.setHex(definition.hemisphereSky);
    this.hemisphere.groundColor.setHex(definition.hemisphereGround);
    this.hemisphere.intensity = definition.hemisphereIntensity;
    this.key.color.setHex(definition.keyColor);
    this.key.intensity = definition.keyIntensity;
    this.fill.color.setHex(definition.fillColor);
    this.fill.intensity = definition.fillIntensity;
    this.sky = sky;
    if (notify) this.invalidate();
  }

  private attachPlane(plane: Mesh): PlaneState {
    const state = {
      originalMaterial: plane.material,
      repeatX: 1,
      repeatY: 1,
    } satisfies PlaneState;
    plane.material = this.groundMaterial;
    this.planeStates.set(plane, state);
    return state;
  }

  private detachPlane(plane: Mesh): void {
    const state = this.planeStates.get(plane);
    if (!state) return;
    if (plane.material === this.groundMaterial) plane.material = state.originalMaterial;
    this.setPlaneRepeat(plane, 1, 1);
    this.planeStates.delete(plane);
  }

  private setPlaneRepeat(plane: Mesh, x: number, y: number): void {
    if (!(plane.geometry instanceof PlaneGeometry)) return;
    const { width, height } = plane.geometry.parameters;
    const position = plane.geometry.getAttribute('position');
    const uv = plane.geometry.getAttribute('uv');
    for (let index = 0; index < uv.count; index += 1) {
      uv.setXY(index, (position.getX(index) / width + 0.5) * x, (position.getY(index) / height + 0.5) * y);
    }
    uv.needsUpdate = true;
  }

  private ensureSurfaceTextures(): void {
    const appearance = this.currentAppearance;
    const surface = appearance?.surface;
    if (!appearance?.textured || surface === undefined || surface === 'plain' || this.planeStates.size === 0) {
      if (this.requestedSurface !== null || this.ownedTextures.size > 0) {
        this.loadGeneration += 1;
        this.requestedSurface = null;
        this.loadPromise = Promise.resolve();
        this.releaseTextures();
      }
      this.onIssue('');
      return;
    }
    if (this.requestedSurface === surface) return;

    const definition = SURFACES[surface];
    if (!definition.colorMap || !definition.normalMap || !definition.roughnessMap) return;
    const generation = ++this.loadGeneration;
    const state: LoadState = { error: null };
    this.requestedSurface = surface;
    this.releaseTextures();
    this.onIssue('');

    this.loadPromise = Promise.all([
      this.loadTexture(definition.colorMap, surface, 'color', SRGBColorSpace, generation, state),
      this.loadTexture(definition.normalMap, surface, 'normal', NoColorSpace, generation, state),
      this.loadTexture(definition.roughnessMap, surface, 'roughness', NoColorSpace, generation, state),
    ]).then(([colorMap, normalMap, roughnessMap]) => {
      if (this.disposed || generation !== this.loadGeneration || state.error) {
        this.releaseTexture(colorMap);
        this.releaseTexture(normalMap);
        this.releaseTexture(roughnessMap);
        return;
      }
      this.groundMaterial.map = colorMap;
      this.groundMaterial.normalMap = normalMap;
      this.groundMaterial.roughnessMap = roughnessMap;
      this.groundMaterial.needsUpdate = true;
      this.onIssue('');
      this.invalidate(true);
    }).catch(error => {
      if (this.disposed || generation !== this.loadGeneration) return;
      this.releaseTextures();
      console.warn(`Ground texture ${definition.label} failed: ${describeLoadError(error)}`);
      this.onIssue('This surface texture could not load. Showing a plain surface; physics is unchanged.');
      this.invalidate();
    });
  }

  private loadTexture(
    url: string,
    surface: SurfaceId,
    kind: 'color' | 'normal' | 'roughness',
    colorSpace: typeof SRGBColorSpace | typeof NoColorSpace,
    generation: number,
    state: LoadState,
  ): Promise<Texture> {
    const { promise, resolve, reject } = Promise.withResolvers<Texture>();
    let texture: Texture | undefined;
    try {
      texture = this.loader.load(url, loaded => {
        if (this.disposed || generation !== this.loadGeneration || state.error) {
          this.releaseTexture(loaded);
          resolve(loaded);
          return;
        }
        const sampledTexture: Texture = loaded;
        const image = sampledTexture.image;
        if (image instanceof HTMLImageElement && Math.max(image.width, image.height) > this.maxTextureSize) {
          const canvas = document.createElement('canvas');
          const scale = this.maxTextureSize / Math.max(image.width, image.height);
          canvas.width = Math.max(1, Math.round(image.width * scale));
          canvas.height = Math.max(1, Math.round(image.height * scale));
          const context = canvas.getContext('2d');
          if (context) {
            context.drawImage(image, 0, 0, canvas.width, canvas.height);
            sampledTexture.image = canvas;
          }
        }
        loaded.wrapS = RepeatWrapping;
        loaded.wrapT = RepeatWrapping;
        loaded.colorSpace = colorSpace;
        loaded.generateMipmaps = true;
        loaded.minFilter = LinearMipmapLinearFilter;
        loaded.magFilter = LinearFilter;
        loaded.anisotropy = this.maxAnisotropy;
        resolve(loaded);
      }, undefined, error => {
        const failure = new Error(`${SURFACES[surface].label} ${kind} map (${url}) failed: ${describeLoadError(error)}`);
        if (!state.error) state.error = failure;
        if (texture) this.releaseTexture(texture);
        reject(failure);
      });
      this.ownedTextures.add(texture);
    } catch (error) {
      const failure = new Error(`${SURFACES[surface].label} ${kind} map (${url}) failed: ${describeLoadError(error)}`);
      if (!state.error) state.error = failure;
      reject(failure);
    }
    return promise;
  }

  private releaseTexture(texture: Texture): void {
    if (this.ownedTextures.delete(texture)) texture.dispose();
  }

  private releaseTextures(): void {
    for (const texture of this.ownedTextures) texture.dispose();
    this.ownedTextures.clear();
    this.groundMaterial.map = null;
    this.groundMaterial.normalMap = null;
    this.groundMaterial.roughnessMap = null;
    this.groundMaterial.needsUpdate = true;
  }
}
