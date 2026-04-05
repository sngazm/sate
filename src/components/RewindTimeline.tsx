import { useMemo } from 'react';
import type { SnapshotRecord } from '../lib/db';
import './RewindTimeline.css';

interface Props {
  visible: boolean;
  snapshots: SnapshotRecord[];
  currentIndex: number;
}

function formatTimeAgo(timestampSec: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - timestampSec;

  if (diff < 60) return 'たった今';
  if (diff < 3600) return `${Math.floor(diff / 60)}分前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}時間前`;
  return `${Math.floor(diff / 86400)}日前`;
}

function formatTime(timestampSec: number): string {
  const d = new Date(timestampSec * 1000);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

export default function RewindTimeline({ visible, snapshots, currentIndex }: Props) {
  const currentSnapshot = snapshots[currentIndex];

  // Calculate tick positions relative to the current snapshot
  const ticks = useMemo(() => {
    if (snapshots.length === 0) return [];

    const current = snapshots[currentIndex];
    if (!current) return [];

    // Time range: from oldest to newest snapshot
    const oldest = snapshots[0].timestamp;
    const newest = snapshots[snapshots.length - 1].timestamp;
    const totalRange = newest - oldest || 1;

    return snapshots.map((snap, i) => {
      // Position: 0 = oldest (left), 1 = newest (right)
      // But we want current to be at center (50%)
      const relativeToRange = totalRange > 0
        ? (snap.timestamp - current.timestamp) / totalRange
        : 0;
      // Shift so current is at 50%, scale to fill visible area
      const position = 50 + relativeToRange * 80;

      return {
        id: snap.id,
        index: i,
        position,
        time: formatTime(snap.timestamp),
        isCurrent: i === currentIndex,
      };
    });
  }, [snapshots, currentIndex]);

  if (!visible || !currentSnapshot) return null;

  const timeAgo = formatTimeAgo(currentSnapshot.timestamp);

  return (
    <div className="rewind-overlay">
      <div className="rewind-label">{timeAgo}</div>
      <div className="rewind-timeline">
        <div className="rewind-needle" />
        <div className="rewind-track">
          {ticks.map((tick) => (
            <div
              key={tick.id}
              className={`rewind-tick ${tick.isCurrent ? 'rewind-tick-active' : ''}`}
              style={{ left: `${tick.position}%` }}
            >
              <div className="rewind-tick-mark" />
            </div>
          ))}
        </div>
      </div>
      <div className="rewind-hint">Cmd+スクロールで移動 · Escで戻る</div>
    </div>
  );
}
