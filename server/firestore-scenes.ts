import { randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import type { DocumentReference, DocumentSnapshot, QueryDocumentSnapshot } from '@google-cloud/firestore';
import { InvalidSceneDocumentError } from './scenes.ts';
import {
  SCENE_RETENTION_MS,
  SavedSceneIdSchema,
  SavedSceneMetadataSchema,
  validateSavedScene,
  validateSceneDocument,
} from '../shared/saved-scene.ts';
import type { SavedScene, SavedSceneMetadata, SceneDocument } from '../shared/saved-scene.ts';

type FirestoreSceneStoreOptions = {
  projectId: string;
  now?: () => number;
};

type StoredSceneMetadata = SavedSceneMetadata & { documentChunkCount: number };

const DOCUMENT_CHUNK_COLLECTION = 'documentChunks';
const DOCUMENT_CHUNK_BYTES = 64 * 1024;
// The schema's maxima fit below 8 MiB; this also keeps chunk transactions below Firestore's write/request limits.
const MAX_DOCUMENT_CHUNKS = 128;
const CLEANUP_PAGE_SIZE = 100;

function isoTime(value: number): string {
  if (!Number.isSafeInteger(value) || Number.isNaN(new Date(value).getTime())) throw new Error('The scene storage clock is invalid.');
  return new Date(value).toISOString();
}

function splitDocumentJson(documentJson: string): string[] {
  const bytes = Buffer.from(documentJson, 'utf8');
  const chunks: string[] = [];
  for (let start = 0; start < bytes.length;) {
    let end = Math.min(start + DOCUMENT_CHUNK_BYTES, bytes.length);
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1;
    chunks.push(bytes.subarray(start, end).toString('utf8'));
    start = end;
  }
  if (chunks.length === 0 || chunks.length > MAX_DOCUMENT_CHUNKS) throw new Error('The validated scene exceeds Firestore storage limits.');
  return chunks;
}

function documentChunkReferences(reference: DocumentReference, count: number): DocumentReference[] {
  return Array.from({ length: count }, (_, index) => reference.collection(DOCUMENT_CHUNK_COLLECTION).doc(String(index)));
}

function savedSceneMetadataFromData(id: string, input: unknown): StoredSceneMetadata {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !('id' in input)
    || !('createdAt' in input) || !('lastRunAt' in input) || !('expiresAt' in input)
    || !('documentChunkCount' in input) || input.id !== id) {
    throw new Error('Corrupt saved scene metadata.');
  }
  try {
    const metadata = SavedSceneMetadataSchema.parse({
      id,
      createdAt: input.createdAt,
      lastRunAt: input.lastRunAt,
      expiresAt: input.expiresAt,
    });
    const count = input.documentChunkCount;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1 || count > MAX_DOCUMENT_CHUNKS) {
      throw new Error('Invalid saved scene chunk count.');
    }
    return { ...metadata, documentChunkCount: count };
  } catch {
    throw new Error('Corrupt saved scene metadata.');
  }
}

function documentJsonFromSnapshots(snapshots: DocumentSnapshot[]): string {
  return snapshots.map((snapshot, index) => {
    const data = snapshot.data();
    if (!snapshot.exists || !data || data.index !== index || typeof data.value !== 'string'
      || Buffer.byteLength(data.value) > DOCUMENT_CHUNK_BYTES) {
      throw new Error('Corrupt saved scene record.');
    }
    return data.value;
  }).join('');
}

export class FirestoreSceneStore {
  readonly #firestore: Firestore;
  readonly #now: () => number;
  #initialization: Promise<void> | undefined;
  #closed = false;
  #closing: Promise<void> | undefined;

  constructor({ projectId, now = Date.now }: FirestoreSceneStoreOptions) {
    this.#firestore = new Firestore({ projectId });
    this.#now = now;
  }

  async initialize(): Promise<void> {
    if (this.#closed) throw new Error('Scene storage is closed.');
    let initialization = this.#initialization;
    if (!initialization) {
      initialization = this.#firestore.collection('scenes').limit(1).get().then(() => undefined);
      this.#initialization = initialization;
    }
    try {
      await initialization;
    } catch (error) {
      if (this.#initialization === initialization) this.#initialization = undefined;
      throw error;
    }
    if (this.#closed) throw new Error('Scene storage is closed.');
  }

  async create(input: unknown): Promise<SavedScene> {
    let document: SceneDocument;
    try {
      document = validateSceneDocument(input);
    } catch {
      throw new InvalidSceneDocumentError();
    }

    await this.initialize();
    const now = this.#timestamp();
    const saved: SavedScene = {
      id: randomUUID(),
      createdAt: isoTime(now),
      lastRunAt: null,
      expiresAt: isoTime(now + SCENE_RETENTION_MS),
      document,
    };
    const chunks = splitDocumentJson(JSON.stringify(document));
    const reference = this.#firestore.collection('scenes').doc(saved.id);
    const chunkReferences = documentChunkReferences(reference, chunks.length);
    await this.#firestore.runTransaction(async transaction => {
      const existing = await transaction.get(reference);
      if (existing.exists) throw new Error('Saved scene ID already exists.');
      transaction.create(reference, {
        id: saved.id,
        createdAt: saved.createdAt,
        lastRunAt: saved.lastRunAt,
        expiresAt: saved.expiresAt,
        documentChunkCount: chunks.length,
      });
      chunks.forEach((value, index) => transaction.create(chunkReferences[index]!, { index, value }));
    });
    return saved;
  }

  async get(id: string): Promise<SavedScene | null> {
    if (!SavedSceneIdSchema.safeParse(id).success) return null;
    await this.initialize();
    const now = this.#timestamp();
    const reference = this.#firestore.collection('scenes').doc(id);
    return this.#firestore.runTransaction(async transaction => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists) return null;
      const { documentChunkCount, ...metadata } = savedSceneMetadataFromData(id, snapshot.data());
      if (Date.parse(metadata.expiresAt) <= now) return null;
      const chunkReferences = documentChunkReferences(reference, documentChunkCount);
      const chunks = await transaction.getAll(...chunkReferences);
      try {
        return validateSavedScene({ ...metadata, document: JSON.parse(documentJsonFromSnapshots(chunks)) });
      } catch {
        throw new Error('Corrupt saved scene record.');
      }
    });
  }

  async run(id: string): Promise<SavedSceneMetadata | null> {
    if (!SavedSceneIdSchema.safeParse(id).success) return null;
    await this.initialize();
    const now = this.#timestamp();
    const lastRunAt = isoTime(now);
    const expiresAt = isoTime(now + SCENE_RETENTION_MS);
    const reference = this.#firestore.collection('scenes').doc(id);
    return this.#firestore.runTransaction(async transaction => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists) return null;
      const metadata = savedSceneMetadataFromData(id, snapshot.data());
      if (Date.parse(metadata.expiresAt) <= now) return null;
      const renewed = SavedSceneMetadataSchema.parse({
        id: metadata.id,
        createdAt: metadata.createdAt,
        lastRunAt,
        expiresAt,
      });
      transaction.update(reference, { lastRunAt, expiresAt });
      return renewed;
    });
  }

  async cleanupExpired(): Promise<void> {
    await this.initialize();
    const now = this.#timestamp();
    const collection = this.#firestore.collection('scenes');
    const cutoff = isoTime(now);
    let cursor: QueryDocumentSnapshot | undefined;
    while (true) {
      let query = collection.where('expiresAt', '<=', cutoff).orderBy('expiresAt').limit(CLEANUP_PAGE_SIZE);
      if (cursor) query = query.startAfter(cursor);
      const expired = await query.get();
      if (expired.empty) return;
      const last = expired.docs.at(-1);
      if (!last) return;
      for (const candidate of expired.docs) {
        await this.#firestore.runTransaction(async transaction => {
          const snapshot = await transaction.get(candidate.ref);
          if (!snapshot.exists) return;
          const { documentChunkCount, ...metadata } = savedSceneMetadataFromData(candidate.id, snapshot.data());
          if (Date.parse(metadata.expiresAt) > now) return;
          const chunkReferences = documentChunkReferences(candidate.ref, documentChunkCount);
          await transaction.getAll(...chunkReferences);
          transaction.delete(candidate.ref);
          for (const chunkReference of chunkReferences) transaction.delete(chunkReference);
        });
      }
      cursor = last;
    }
  }

  close(): Promise<void> {
    this.#closed = true;
    this.#closing ??= this.#firestore.terminate();
    return this.#closing;
  }

  #timestamp(): number {
    const now = this.#now();
    isoTime(now);
    return now;
  }
}
