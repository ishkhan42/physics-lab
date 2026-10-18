import { SavedSceneIdSchema, SavedSceneMetadataSchema, validateSavedScene, type SavedScene, type SavedSceneMetadata, type SceneDocument } from '../shared/saved-scene.ts';

const RECENTS_KEY = 'physics-lab.recent-scenes';
const RECENT_LIMIT = 8;

export interface RecentScene {
  id: string;
  title: string;
  expiresAt: string;
}

export class SavedSceneApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'SavedSceneApiError';
    this.status = status;
  }
}

function errorMessage(payload: unknown, status: number): string {
  if (typeof payload === 'object' && payload !== null) {
    if ('error' in payload && typeof payload.error === 'object' && payload.error !== null && 'message' in payload.error && typeof payload.error.message === 'string') {
      return payload.error.message;
    }
    if ('message' in payload && typeof payload.message === 'string') return payload.message;
  }
  return `The local API returned HTTP ${status}.`;
}

async function savedScenePayload(url: string, init?: RequestInit): Promise<unknown> {
  const deadline = AbortSignal.timeout(15_000);
  const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  const response = await fetch(url, { ...init, signal });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new SavedSceneApiError(errorMessage(payload, response.status), response.status);
  return payload;
}

async function savedSceneRequest(url: string, init?: RequestInit): Promise<SavedScene> {
  return validateSavedScene(await savedScenePayload(url, init));
}

export function createSavedScene(document: SceneDocument, signal?: AbortSignal): Promise<SavedScene> {
  return savedSceneRequest('/api/scenes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(document),
    signal,
  });
}

export function getSavedScene(id: string, signal?: AbortSignal): Promise<SavedScene> {
  return savedSceneRequest(`/api/scenes/${SavedSceneIdSchema.parse(id)}`, { signal });
}

export function renewSavedScene(id: string, signal?: AbortSignal): Promise<SavedSceneMetadata> {
  return savedScenePayload(`/api/scenes/${SavedSceneIdSchema.parse(id)}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    signal,
  }).then(payload => SavedSceneMetadataSchema.parse(payload));
}

function writeRecentScenes(scenes: RecentScene[]): RecentScene[] {
  const recent = scenes.slice(0, RECENT_LIMIT);
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(recent));
  } catch {
    // Local storage can be disabled; scene links still work for this session.
  }
  return recent;
}

export function readRecentScenes(): RecentScene[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? 'null');
    if (!Array.isArray(stored)) return [];
    const recent: RecentScene[] = [];
    for (const item of stored) {
      if (typeof item !== 'object' || item === null || !('id' in item) || !SavedSceneIdSchema.safeParse(item.id).success) continue;
      if (!('title' in item) || typeof item.title !== 'string' || !('expiresAt' in item) || typeof item.expiresAt !== 'string') continue;
      if (!Number.isFinite(Date.parse(item.expiresAt)) || recent.some(candidate => candidate.id === item.id)) continue;
      recent.push({ id: item.id, title: item.title, expiresAt: item.expiresAt });
    }
    return writeRecentScenes(recent);
  } catch {
    return [];
  }
}

export function rememberRecentScene(id: string, title: string, expiresAt: string): RecentScene[] {
  const item: RecentScene = { id, title, expiresAt };
  return writeRecentScenes([item, ...readRecentScenes().filter(recent => recent.id !== id)]);
}

export function forgetRecentScene(id: string): RecentScene[] {
  return writeRecentScenes(readRecentScenes().filter(recent => recent.id !== id));
}
