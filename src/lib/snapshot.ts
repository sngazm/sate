import Database from '@tauri-apps/plugin-sql';

async function computeHash(content: string): Promise<string> {
  const data = new TextEncoder().encode(content);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hashBuffer)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}

export async function saveSnapshot(db: Database, fileId: string, fullContent: string): Promise<boolean> {
  const contentHash = await computeHash(fullContent);

  // Check if latest snapshot has same hash
  const latest = await db.select<{ content_hash: string }[]>(
    'SELECT content_hash FROM snapshots WHERE file_id = $1 ORDER BY timestamp DESC LIMIT 1',
    [fileId]
  );

  if (latest.length > 0 && latest[0].content_hash === contentHash) {
    return false; // No change, skip
  }

  const timestamp = Date.now();
  await db.execute(
    'INSERT INTO snapshots (file_id, timestamp, content, content_hash) VALUES ($1, $2, $3, $4)',
    [fileId, timestamp, fullContent, contentHash]
  );

  return true;
}

export interface SnapshotEntry {
  id: number;
  timestamp: number;
  content_hash: string;
}

export async function getSnapshots(db: Database, fileId: string): Promise<SnapshotEntry[]> {
  return db.select<SnapshotEntry[]>(
    'SELECT id, timestamp, content_hash FROM snapshots WHERE file_id = $1 ORDER BY timestamp DESC',
    [fileId]
  );
}

export async function getSnapshotContent(db: Database, snapshotId: number): Promise<string | null> {
  const rows = await db.select<{ content: string }[]>(
    'SELECT content FROM snapshots WHERE id = $1',
    [snapshotId]
  );
  return rows.length > 0 ? rows[0].content : null;
}
