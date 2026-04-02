import { useEffect, useRef, useCallback } from 'react';
import Database from '@tauri-apps/plugin-sql';
import { saveSnapshot } from '../lib/snapshot';
import type { FileMetadata } from '../lib/fileUtils';
import { buildFrontMatter } from '../lib/fileUtils';

const SNAPSHOT_DELAY = 3000; // 3 seconds after typing stops

interface UseSnapshotOptions {
  db: Database | null;
  metadataRef: React.RefObject<FileMetadata | null>;
  contentRef: React.RefObject<string>;
  content: string; // reactive content to detect changes
}

export function useSnapshot({ db, metadataRef, contentRef, content }: UseSnapshotOptions) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const doSnapshot = useCallback(async () => {
    if (!db || !metadataRef.current) return;
    const meta = metadataRef.current;
    const body = contentRef.current;
    if (!body) return;

    const fullContent = buildFrontMatter(meta) + body;
    try {
      await saveSnapshot(db, meta.uuid, fullContent);
    } catch (err) {
      console.error('Snapshot save failed:', err);
    }
  }, [db, metadataRef, contentRef]);

  // Reset timer on content change
  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }

    if (content && db) {
      timerRef.current = setTimeout(() => {
        doSnapshot();
      }, SNAPSHOT_DELAY);
    }

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, [content, db, doSnapshot]);

  // Snapshot on unmount (file switch / app close)
  useEffect(() => {
    const currentMetadataRef = metadataRef;
    const currentContentRef = contentRef;
    const currentDb = db;
    return () => {
      const meta = currentMetadataRef.current;
      const body = currentContentRef.current;
      if (currentDb && meta && body) {
        const fullContent = buildFrontMatter(meta) + body;
        saveSnapshot(currentDb, meta.uuid, fullContent).catch(() => {});
      }
    };
  }, [db, metadataRef, contentRef]);
}
