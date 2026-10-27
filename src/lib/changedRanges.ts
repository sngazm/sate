import type { Transaction } from '@milkdown/prose/state';

export interface Range {
  from: number;
  to: number;
}

/** trs で変更された範囲を、最後のドキュメント上の位置で返す */
export function changedRanges(trs: readonly Transaction[]): Range[] {
  let ranges: Range[] = [];
  for (const tr of trs) {
    if (!tr.docChanged) continue;
    ranges = ranges.map((r) => ({ from: tr.mapping.map(r.from, -1), to: tr.mapping.map(r.to, 1) }));
    tr.mapping.maps.forEach((map, i) => {
      const rest = tr.mapping.slice(i + 1);
      map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
        ranges.push({ from: rest.map(newStart, -1), to: rest.map(newEnd, 1) });
      });
    });
  }
  return ranges;
}
