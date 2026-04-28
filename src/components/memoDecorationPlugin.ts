/**
 * メモ位置追跡プラグイン
 *
 * Widget Decoration は使わない。代わりに:
 * 1. Plugin state で各メモの doc 内 pos を Map<id, pos> で管理
 * 2. docChanged 時は tr.mapping.map() で自動追跡
 * 3. view.update + MutationObserver で coordsAtPos → style.top を直接設定
 */
import { Plugin, PluginKey } from '@milkdown/prose/state';
import type { EditorState } from '@milkdown/prose/state';
import type { Node as ProseMirrorNode } from '@milkdown/prose/model';
import type { Memo } from '../lib/frontmatter';

export const memoPluginKey = new PluginKey<Map<string, number>>('memo-positions');

/** アンカー位置が更新されたときに container 上で発火するイベント名 */
export const MEMO_ANCHORS_UPDATED_EVENT = 'memo-anchors-updated';

/** relativePos (0〜1) → ドキュメント pos */
function toAbsolutePos(doc: ProseMirrorNode, relativePos: number): number {
  const size = doc.content.size;
  if (size === 0) return 1;
  return Math.max(1, Math.min(Math.round(size * Math.max(0, Math.min(1, relativePos))), size));
}

/** memosRef から全メモの pos を計算 */
function computeAll(doc: ProseMirrorNode, memos: Memo[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const memo of memos) {
    m.set(memo.id, toAbsolutePos(doc, memo.relativePos));
  }
  return m;
}

export function createMemoPlugin(
  memosRef: React.RefObject<Memo[]>,
  containerRef: React.RefObject<HTMLDivElement | null>,
) {
  return new Plugin<Map<string, number>>({
    key: memoPluginKey,

    state: {
      init(_, state) {
        return computeAll(state.doc, memosRef.current ?? []);
      },
      apply(tr, old, _oldState, newState) {
        const meta = tr.getMeta(memoPluginKey);
        if (meta && typeof meta === 'object' && 'memoId' in meta) {
          const next = new Map(old);
          next.set(meta.memoId as string, meta.pos as number);
          return next;
        }
        if (meta === true) {
          return computeAll(newState.doc, memosRef.current ?? []);
        }
        if (tr.docChanged) {
          const next = new Map<string, number>();
          for (const [id, pos] of old) {
            next.set(id, tr.mapping.map(pos));
          }
          return next;
        }
        return old;
      },
    },

    view(editorView) {
      /**
       * 各メモカードの「アンカー位置」(衝突回避前の自然位置) を計算して
       * dataset.anchorTop に書き込む。実際の表示位置 (style.top) は
       * SideMemoLayer のレイアウト計算で決定する。
       *
       * 計算後 MEMO_ANCHORS_UPDATED_EVENT を container に dispatch して
       * SideMemoLayer に再レイアウトを促す。
       */
      function syncDOM(view: typeof editorView) {
        const container = containerRef.current;
        if (!container) return;
        const positions = memoPluginKey.getState(view.state);
        if (!positions || positions.size === 0) return;

        const containerRect = container.getBoundingClientRect();

        for (const [memoId, pos] of positions) {
          const el = container.querySelector(`[data-memo-id="${memoId}"]`) as HTMLElement | null;
          if (!el) continue;
          try {
            const clampedPos = Math.max(1, Math.min(pos, view.state.doc.content.size));
            const coords = view.coordsAtPos(clampedPos);
            el.dataset.anchorTop = String(coords.top - containerRect.top);
          } catch {
            // 無効な pos
          }
        }

        container.dispatchEvent(new CustomEvent(MEMO_ANCHORS_UPDATED_EVENT));
      }

      // ProseMirror の状態変更時に位置を同期
      // + MutationObserver で React が新しいカードを描画したタイミングも検知
      let observer: MutationObserver | null = null;

      function startObserver() {
        const container = containerRef.current;
        if (!container || observer) return;
        // メモカードが追加されたタイミングだけを検知（エディタの編集には反応しない）
        observer = new MutationObserver((mutations) => {
          const hasNewMemo = mutations.some((m) =>
            Array.from(m.addedNodes).some((n) =>
              n instanceof HTMLElement && (n.hasAttribute('data-memo-id') || n.querySelector?.('[data-memo-id]')),
            ),
          );
          if (hasNewMemo) syncDOM(editorView);
        });
        observer.observe(container, { childList: true, subtree: true });
      }

      // 初回位置設定: container が準備できるのを待つ
      const initTimer = setInterval(() => {
        if (containerRef.current) {
          clearInterval(initTimer);
          syncDOM(editorView);
          startObserver();
        }
      }, 50);
      setTimeout(() => clearInterval(initTimer), 3000);

      return {
        update(view) { syncDOM(view); },
        destroy() {
          clearInterval(initTimer);
          observer?.disconnect();
        },
      };
    },
  });
}

/** プラグインから位置マップを取得 */
export function getPositions(state: EditorState): Map<string, number> | undefined {
  return memoPluginKey.getState(state) ?? undefined;
}

/** 位置マップから relativePos を同期。変更があれば新しい配列を返す */
export function syncPositionsToMemos(
  doc: ProseMirrorNode,
  memos: Memo[],
  positions: Map<string, number>,
): Memo[] | null {
  const size = doc.content.size;
  if (size === 0) return null;
  let changed = false;
  const updated = memos.map((m) => {
    const pos = positions.get(m.id);
    if (pos == null) return m;
    const newRel = Math.max(0, Math.min(1, pos / size));
    if (Math.abs(m.relativePos - newRel) > 0.001) {
      changed = true;
      return { ...m, relativePos: newRel };
    }
    return m;
  });
  return changed ? updated : null;
}
