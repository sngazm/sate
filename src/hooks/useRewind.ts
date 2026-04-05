import { useState, useRef, useCallback, useEffect } from 'react';
import { getSnapshots, type SnapshotRecord } from '../lib/db';
import { parseFrontMatter } from '../lib/frontmatter';

export interface RewindState {
  active: boolean;
  snapshots: SnapshotRecord[];
  currentIndex: number;
  currentContent: string | null;
}

export function useRewind(fileId: string | null) {
  const [state, setState] = useState<RewindState>({
    active: false,
    snapshots: [],
    currentIndex: -1,
    currentContent: null,
  });

  const snapshotsRef = useRef<SnapshotRecord[]>([]);
  const indexRef = useRef(-1);
  const activeRef = useRef(false);
  const accumulatedDeltaRef = useRef(0);

  const activate = useCallback(async () => {
    if (!fileId || activeRef.current) return;

    try {
      const snapshots = await getSnapshots(fileId);
      if (snapshots.length === 0) return;

      snapshotsRef.current = snapshots;
      const lastIndex = snapshots.length - 1;
      indexRef.current = lastIndex;
      activeRef.current = true;
      accumulatedDeltaRef.current = 0;

      setState({
        active: true,
        snapshots,
        currentIndex: lastIndex,
        currentContent: null,
      });
    } catch {
      // DB not ready
    }
  }, [fileId]);

  const deactivate = useCallback(() => {
    activeRef.current = false;
    indexRef.current = -1;
    snapshotsRef.current = [];
    accumulatedDeltaRef.current = 0;
    setState({
      active: false,
      snapshots: [],
      currentIndex: -1,
      currentContent: null,
    });
  }, []);

  const navigateTo = useCallback((index: number) => {
    const snapshots = snapshotsRef.current;
    if (snapshots.length === 0) return;

    const clamped = Math.max(0, Math.min(index, snapshots.length - 1));
    indexRef.current = clamped;

    // If at the latest snapshot, deactivate
    if (clamped === snapshots.length - 1) {
      deactivate();
      return;
    }

    const snapshot = snapshots[clamped];
    const { body } = parseFrontMatter(snapshot.content);

    setState({
      active: true,
      snapshots,
      currentIndex: clamped,
      currentContent: body,
    });
  }, [deactivate]);

  // Handle Cmd+scroll
  useEffect(() => {
    const DELTA_THRESHOLD = 80;

    const handleWheel = (e: WheelEvent) => {
      if (!e.metaKey) {
        // If rewind is active and user scrolls without Cmd, ignore (let normal scroll happen)
        return;
      }

      if (!activeRef.current) {
        // Only activate on scroll up (negative deltaY)
        if (e.deltaY < 0) {
          e.preventDefault();
          activate().then(() => {
            // After activation, move one step back
            if (snapshotsRef.current.length > 1) {
              navigateTo(snapshotsRef.current.length - 2);
            }
          });
        }
        return;
      }

      e.preventDefault();

      accumulatedDeltaRef.current += e.deltaY;

      if (accumulatedDeltaRef.current <= -DELTA_THRESHOLD) {
        // Scroll up → go back in time
        accumulatedDeltaRef.current = 0;
        navigateTo(indexRef.current - 1);
      } else if (accumulatedDeltaRef.current >= DELTA_THRESHOLD) {
        // Scroll down → go forward in time
        accumulatedDeltaRef.current = 0;
        navigateTo(indexRef.current + 1);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && activeRef.current) {
        e.preventDefault();
        deactivate();
      }
    };

    window.addEventListener('wheel', handleWheel, { passive: false });
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('wheel', handleWheel);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [activate, navigateTo, deactivate]);

  return {
    ...state,
    deactivate,
  };
}
