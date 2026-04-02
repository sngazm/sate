import Database from '@tauri-apps/plugin-sql';
import { readDir, readTextFile } from '@tauri-apps/plugin-fs';
import { parseFrontMatter, getFirstLine } from './fileUtils';
import { isFts5Supported } from './db';

export async function reconcile(db: Database, baseDir: string): Promise<void> {
  const entries = await readDir(baseDir);
  const mdFiles = entries
    .filter((e) => e.name?.endsWith('.md'))
    .map((e) => e.name!);

  // Load existing DB state for diff comparison
  const dbRows = await db.select<{ file_id: string; updated_at: number; current_path: string }[]>(
    'SELECT file_id, updated_at, current_path FROM files'
  );
  const dbMap = new Map(dbRows.map((r) => [r.file_id, r]));

  const diskFileIds = new Set<string>();

  for (const name of mdFiles) {
    try {
      const text = await readTextFile(`${baseDir}/${name}`);
      const { metadata, body } = parseFrontMatter(text);
      if (!metadata) continue;

      const firstLine = getFirstLine(body);
      const createdTs = new Date(metadata.createdAt).getTime();
      const updatedTs = new Date(metadata.updatedAt).getTime();

      diskFileIds.add(metadata.uuid);

      // Check if file is unchanged (same updated_at and same path)
      const existing = dbMap.get(metadata.uuid);
      if (existing && existing.updated_at === updatedTs && existing.current_path === name) {
        continue; // No change, skip DB writes entirely
      }

      // Upsert files row
      await db.execute(
        `INSERT INTO files (file_id, created_at, updated_at, first_line, current_path)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT(file_id) DO UPDATE SET
           updated_at = $3, first_line = $4, current_path = $5`,
        [metadata.uuid, createdTs, updatedTs, firstLine, name]
      );

      // Update search index only for changed files
      if (isFts5Supported()) {
        await db.execute('DELETE FROM search_index WHERE file_id = $1', [metadata.uuid]);
        await db.execute('INSERT INTO search_index (file_id, content) VALUES ($1, $2)', [metadata.uuid, body]);
      } else {
        await db.execute('UPDATE files SET content_cache = $1 WHERE file_id = $2', [body, metadata.uuid]);
      }
    } catch (err) {
      console.error(`Reconcile: failed to process ${name}:`, err);
    }
  }

  // Remove files from DB that no longer exist on disk (keep snapshots)
  for (const row of dbRows) {
    if (!diskFileIds.has(row.file_id)) {
      await db.execute('DELETE FROM files WHERE file_id = $1', [row.file_id]);
      if (isFts5Supported()) {
        await db.execute('DELETE FROM search_index WHERE file_id = $1', [row.file_id]);
      }
    }
  }
}
