import { useEffect, useRef, useCallback } from 'react';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
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

  // Snapshot on app close via Tauri close event
  useEffect(() => {
    const window = getCurrentWebviewWindow();
    const unlisten = window.onCloseRequested(async () => {
      await doSnapshot();
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [doSnapshot]);
}
