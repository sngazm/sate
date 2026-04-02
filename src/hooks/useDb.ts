import { useState, useEffect, useRef } from 'react';
import Database from '@tauri-apps/plugin-sql';
import { initDb, closeDb } from '../lib/db';
import { reconcile } from '../lib/reconcile';

interface UseDbResult {
  db: Database | null;
  ready: boolean;
}

export function useDb(baseDir: string): UseDbResult {
  const [db, setDb] = useState<Database | null>(null);
  const [ready, setReady] = useState(false);
  const initRef = useRef(false);

  useEffect(() => {
    if (!baseDir || initRef.current) return;
    initRef.current = true;

    let cancelled = false;

    (async () => {
      try {
        const database = await initDb(baseDir);
        if (cancelled) return;
        setDb(database);

        // Background reconcile
        try {
          await reconcile(database, baseDir);
        } catch (err) {
          console.error('Reconcile failed:', err);
        }
        if (!cancelled) {
          setReady(true);
        }
      } catch (err) {
        console.error('DB init failed:', err);
        initRef.current = false;
      }
    })();

    return () => {
      cancelled = true;
      closeDb();
    };
  }, [baseDir]);

  return { db, ready };
}
