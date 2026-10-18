import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { SQLTagStore } from 'node:sqlite';
import {
  SCENE_RETENTION_MS,
  SavedSceneIdSchema,
  SavedSceneMetadataSchema,
  validateSavedScene,
  validateSceneDocument,
} from '../shared/saved-scene.ts';
import type { SavedScene, SavedSceneMetadata, SceneDocument } from '../shared/saved-scene.ts';

const CLEANUP_INTERVAL_MS = 60_000;
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

type SceneStoreOptions = {
  path?: string;
  now?: () => number;
};


export class InvalidSceneDocumentError extends Error {
  constructor() {
    super('The saved scene document is invalid.');
    this.name = 'InvalidSceneDocumentError';
  }
}

function defaultDatabasePath(): string {
  const base = process.platform === 'win32'
    ? process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    : process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support')
      : process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(base, 'physics-lab', 'scenes.sqlite');
}

function isInside(root: string, path: string): boolean {
  const relativePath = relative(root, path);
  return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}

function isoTime(value: unknown): string {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error('Corrupt saved scene timestamp.');
  return new Date(value).toISOString();
}

function savedSceneFromRow(input: unknown): SavedScene {
  if (!input || typeof input !== 'object'
    || !('id' in input) || !('created_at' in input) || !('last_run_at' in input) || !('expires_at' in input) || !('document' in input)) {
    throw new Error('Corrupt saved scene record.');
  }
  const row = input;
  if (typeof row.id !== 'string' || typeof row.document !== 'string') throw new Error('Corrupt saved scene record.');
  return validateSavedScene({
    id: row.id,
    createdAt: isoTime(row.created_at),
    lastRunAt: row.last_run_at === null ? null : isoTime(row.last_run_at),
    expiresAt: isoTime(row.expires_at),
    document: JSON.parse(row.document),
  });
}

function savedSceneMetadataFromRow(input: unknown): SavedSceneMetadata {
  if (!input || typeof input !== 'object'
    || !('id' in input) || !('created_at' in input) || !('last_run_at' in input) || !('expires_at' in input)) {
    throw new Error('Corrupt saved scene metadata.');
  }
  const row = input;
  if (typeof row.id !== 'string') throw new Error('Corrupt saved scene metadata.');
  return SavedSceneMetadataSchema.parse({
    id: row.id,
    createdAt: isoTime(row.created_at),
    lastRunAt: row.last_run_at === null ? null : isoTime(row.last_run_at),
    expiresAt: isoTime(row.expires_at),
  });
}

export class SceneStore {
  readonly #path: string;
  readonly #now: () => number;
  #database: DatabaseSync | undefined;
  #queries: SQLTagStore | undefined;
  #opening: Promise<void> | undefined;
  #cleanupTimer: NodeJS.Timeout | undefined;
  #maintenanceError: unknown;
  #closed = false;

  constructor(options: SceneStoreOptions = {}) {
    this.#path = options.path || process.env.SCENE_DB_PATH || defaultDatabasePath();
    this.#now = options.now || Date.now;
  }
  async initialize(): Promise<void> {
    await this.#ready();
  }

  async create(input: unknown): Promise<SavedScene> {
    let document: SceneDocument;
    try {
      document = validateSceneDocument(input);
    } catch {
      throw new InvalidSceneDocumentError();
    }

    await this.#ready();
    const now = this.#timestamp();
    const saved: SavedScene = {
      id: randomUUID(),
      createdAt: new Date(now).toISOString(),
      lastRunAt: null,
      expiresAt: new Date(now + SCENE_RETENTION_MS).toISOString(),
      document,
    };
    this.#queries!.run`
      INSERT INTO scenes (id, created_at, last_run_at, expires_at, document)
      VALUES (${saved.id}, ${now}, NULL, ${now + SCENE_RETENTION_MS}, ${JSON.stringify(document)})
    `;
    return saved;
  }

  async get(id: string): Promise<SavedScene | null> {
    if (!SavedSceneIdSchema.safeParse(id).success) return null;
    await this.#ready();
    const now = this.#timestamp();
    const row = this.#queries!.get`
      SELECT id, created_at, last_run_at, expires_at, document
      FROM scenes WHERE id = ${id} AND expires_at > ${now}
    `;
    return row ? savedSceneFromRow(row) : null;
  }

  async run(id: string): Promise<SavedSceneMetadata | null> {
    if (!SavedSceneIdSchema.safeParse(id).success) return null;
    await this.#ready();
    const now = this.#timestamp();
    const expiresAt = now + SCENE_RETENTION_MS;
    this.#database!.exec('BEGIN IMMEDIATE');
    try {
      const row = this.#queries!.get`
        UPDATE scenes SET last_run_at = ${now}, expires_at = ${expiresAt}
        WHERE id = ${id} AND expires_at > ${now}
        RETURNING id, created_at, last_run_at, expires_at
      `;
      const metadata = row ? savedSceneMetadataFromRow(row) : null;
      this.#database!.exec('COMMIT');
      return metadata;
    } catch (error) {
      if (this.#database!.isTransaction) this.#database!.exec('ROLLBACK');
      throw error;
    }
  }

  async cleanupExpired(): Promise<void> {
    await this.#ready();
    this.#deleteExpired(this.#timestamp());
  }

  close(): void {
    this.#closed = true;
    clearInterval(this.#cleanupTimer);
    this.#cleanupTimer = undefined;
    this.#queries?.clear();
    this.#queries = undefined;
    this.#database?.close();
    this.#database = undefined;
  }

  async #ready(): Promise<void> {
    if (this.#closed) throw new Error('Scene storage is closed.');
    if (this.#maintenanceError) throw this.#maintenanceError;
    if (!this.#database) {
      this.#opening ??= this.#open();
      try {
        await this.#opening;
      } finally {
        this.#opening = undefined;
      }
    }
    if (this.#maintenanceError) throw this.#maintenanceError;
  }

  #timestamp(): number {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || Number.isNaN(new Date(now).getTime())) throw new Error('The scene storage clock is invalid.');
    return now;
  }

  async #open(): Promise<void> {
    const databasePath = resolve(this.#path);
    const databaseDirectory = dirname(databasePath);
    const projectRoot = await realpath(PROJECT_ROOT);
    if (isInside(projectRoot, databaseDirectory) || isInside(PROJECT_ROOT, databaseDirectory)) {
      throw new Error('SCENE_DB_PATH must be outside the project directory.');
    }
    let existingDirectory = databaseDirectory;
    while (true) {
      try {
        if (isInside(projectRoot, await realpath(existingDirectory))) throw new Error('SCENE_DB_PATH must be outside the project directory.');
        break;
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        const parent = dirname(existingDirectory);
        if (parent === existingDirectory) throw error;
        existingDirectory = parent;
      }
    }
    if (this.#closed) throw new Error('Scene storage is closed.');
    const createdDirectory = await mkdir(databaseDirectory, { recursive: true, mode: 0o700 });
    const privateDirectory = await realpath(databaseDirectory);
    if (isInside(projectRoot, privateDirectory)) throw new Error('SCENE_DB_PATH must be outside the project directory.');
    const directory = await stat(privateDirectory);
    if (createdDirectory) await chmod(privateDirectory, 0o700);
    else if ((directory.mode & 0o077) !== 0) throw new Error('The scene database directory must have mode 0700.');

    const actualPath = join(privateDirectory, basename(databasePath));
    try {
      const existing = await lstat(actualPath);
      if (!existing.isFile()) throw new Error('Scene database path is not a regular file.');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    if (this.#closed) throw new Error('Scene storage is closed.');
    const file = await open(actualPath, 'a', 0o600);
    try {
      await file.chmod(0o600);
    } finally {
      await file.close();
    }

    const database = new DatabaseSync(actualPath, { timeout: 5_000 });
    let queries: SQLTagStore | undefined;
    try {
      queries = database.createTagStore(8);
      await chmod(actualPath, 0o600);
      const integrity = queries.all`PRAGMA quick_check`;
      if (integrity.length !== 1 || !integrity[0] || typeof integrity[0] !== 'object'
        || !('quick_check' in integrity[0]) || integrity[0].quick_check !== 'ok') {
        throw new Error('Scene database integrity check failed.');
      }

      database.exec('BEGIN IMMEDIATE');
      try {
        const version = queries.get`PRAGMA user_version`;
        if (!version || typeof version !== 'object' || !('user_version' in version)) throw new Error('Scene database schema version is missing.');
        if (version?.user_version === 0) {
          database.exec(`
            CREATE TABLE scenes (
              id TEXT PRIMARY KEY,
              created_at INTEGER NOT NULL,
              last_run_at INTEGER,
              expires_at INTEGER NOT NULL,
              document TEXT NOT NULL
            ) STRICT
          `);
          database.exec('PRAGMA user_version = 1');
        } else if (version?.user_version !== 1) {
          throw new Error('Unsupported scene database schema version.');
        }
        queries.get`SELECT id, created_at, last_run_at, expires_at, document FROM scenes LIMIT 0`;
        database.exec('COMMIT');
      } catch (error) {
        if (database.isTransaction) database.exec('ROLLBACK');
        throw error;
      }
      if (this.#closed) throw new Error('Scene storage is closed.');
      const now = this.#timestamp();
      queries.run`DELETE FROM scenes WHERE expires_at <= ${now}`;
      this.#database = database;
      this.#queries = queries;
      this.#cleanupTimer = setInterval(() => {
        void this.cleanupExpired().catch(error => {
          this.#maintenanceError = error;
          clearInterval(this.#cleanupTimer);
          this.#cleanupTimer = undefined;
        });
      }, CLEANUP_INTERVAL_MS);
      this.#cleanupTimer.unref();
    } catch (error) {
      queries?.clear();
      database.close();
      throw error;
    }
  }

  #deleteExpired(at: number): void {
    this.#queries!.run`DELETE FROM scenes WHERE expires_at <= ${at}`;
  }
}
