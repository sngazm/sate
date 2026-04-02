import Database from '@tauri-apps/plugin-sql';
import { ensureDir } from './fileUtils';

const SCHEMA_VERSION = 1;

let db: Database | null = null;
let fts5Supported = true;

export function getDb(): Database | null {
  return db;
}

export function isFts5Supported(): boolean {
  return fts5Supported;
}

export async function initDb(baseDir: string): Promise<Database> {
  const sateDir = `${baseDir}/.sate`;
  await ensureDir(sateDir);

  const dbPath = `${sateDir}/sate.db`;
  db = await Database.load(`sqlite:${dbPath}`);

  await db.execute('PRAGMA journal_mode = WAL');
  await db.execute('PRAGMA foreign_keys = ON');

  await createSchema(db);
  await migrateIfNeeded(db);

  return db;
}

async function createSchema(db: Database): Promise<void> {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS files (
      file_id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      first_line TEXT DEFAULT '',
      current_path TEXT NOT NULL
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      FOREIGN KEY (file_id) REFERENCES files(file_id)
    )
  `);

  await db.execute(
    'CREATE INDEX IF NOT EXISTS idx_snapshots_file_timestamp ON snapshots(file_id, timestamp)'
  );

  // Try FTS5, fallback to content_cache column
  try {
    await db.execute(`
      CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
        file_id UNINDEXED,
        content,
        tokenize='unicode61'
      )
    `);
    fts5Supported = true;
  } catch {
    console.warn('FTS5 not available, falling back to LIKE search');
    fts5Supported = false;
    // Add content_cache column to files if not exists
    try {
      await db.execute('ALTER TABLE files ADD COLUMN content_cache TEXT DEFAULT ""');
    } catch {
      // Column already exists, ignore
    }
  }
}

async function migrateIfNeeded(db: Database): Promise<void> {
  const result = await db.select<{ user_version: number }[]>('PRAGMA user_version');
  const currentVersion = result[0]?.user_version ?? 0;

  if (currentVersion < SCHEMA_VERSION) {
    // Future migrations go here
    await db.execute(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }
}

export async function closeDb(): Promise<void> {
  if (db) {
    await db.close();
    db = null;
  }
}
