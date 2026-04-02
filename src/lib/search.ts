import Database from '@tauri-apps/plugin-sql';
import { isFts5Supported } from './db';

export interface FileEntry {
  file_id: string;
  current_path: string;
  first_line: string;
  updated_at: number;
}

export async function listFiles(db: Database): Promise<FileEntry[]> {
  return db.select<FileEntry[]>(
    'SELECT file_id, current_path, first_line, updated_at FROM files ORDER BY updated_at DESC'
  );
}

export async function searchFiles(db: Database, query: string): Promise<FileEntry[]> {
  if (isFts5Supported()) {
    // FTS5 search — escape special chars and add prefix matching
    const safeQuery = query.replace(/['"]/g, '');
    return db.select<FileEntry[]>(
      `SELECT f.file_id, f.current_path, f.first_line, f.updated_at
       FROM search_index s
       JOIN files f ON f.file_id = s.file_id
       WHERE search_index MATCH $1
       ORDER BY f.updated_at DESC`,
      [`"${safeQuery}"`]
    );
  } else {
    // LIKE fallback
    const pattern = `%${query}%`;
    return db.select<FileEntry[]>(
      `SELECT file_id, current_path, first_line, updated_at FROM files
       WHERE current_path LIKE $1 OR first_line LIKE $1
         OR content_cache LIKE $1
       ORDER BY updated_at DESC`,
      [pattern]
    );
  }
}
