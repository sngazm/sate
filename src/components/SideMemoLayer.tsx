import { useCallback, useRef, useEffect, useState } from 'react';
import type { Memo } from '../lib/frontmatter';
import type { EditorView } from '@milkdown/prose/view';
import { memoPluginKey, MEMO_ANCHORS_UPDATED_EVENT } from './memoDecorationPlugin';
import './SideMemoLayer.css';

/** メモ間の最低限の縦の間隔 (px) */
const MEMO_GAP = 8;

/** エディタ水平中央の Y 座標にあたる doc 内 pos を取得 */
function posAtClientY(view: EditorView, clientY: number): number | null {
  const editorRect = view.dom.getBoundingClientRect();
  const x = editorRect.left + editorRect.width / 2;
  return view.posAtCoords({ left: x, top: clientY })?.pos ?? null;
}

interface SideMemoLayerProps {
  memos: Memo[];
  onChange: (memos: Memo[]) => void;
  editorViewRef: React.RefObject<EditorView | null>;
}

/**
 * レイアウト対象 1 メモ分の情報。
 * - anchor: 衝突回避前の自然な top (px、container 基準)
 * - height: 実測したカード高さ
 * - el: 対応する DOM 要素
 */
interface LayoutItem {
  id: string;
  side: 'left' | 'right';
  anchor: number;
  height: number;
  el: HTMLElement;
}

/**
 * 同じ side のメモ群を、anchor 順にソートしつつ衝突を解消した top を返す。
 *
 * - フォーカス中のメモがあるとき: そのメモは anchor の位置に固定し、
 *   上側にあるメモは上方向に、下側にあるメモは下方向に押し出す。
 * - フォーカスがないとき: 上から順に貪欲に詰める。
 */
function resolveSide(items: LayoutItem[], focusedId: string | null): Map<string, number> {
  const sorted = [...items].sort((a, b) => a.anchor - b.anchor);
  const result = new Map<string, number>();

  const focusedIdx = focusedId ? sorted.findIndex((i) => i.id === focusedId) : -1;

  if (focusedIdx === -1) {
    let lastBottom = -Infinity;
    for (const item of sorted) {
      const top = Math.max(item.anchor, lastBottom + MEMO_GAP);
      result.set(item.id, top);
      lastBottom = top + item.height;
    }
    return result;
  }

  const focused = sorted[focusedIdx];
  result.set(focused.id, focused.anchor);

  // フォーカスより下: 通常の貪欲スイープ
  let lastBottom = focused.anchor + focused.height;
  for (let i = focusedIdx + 1; i < sorted.length; i++) {
    const item = sorted[i];
    const top = Math.max(item.anchor, lastBottom + MEMO_GAP);
    result.set(item.id, top);
    lastBottom = top + item.height;
  }

  // フォーカスより上: 逆向きにスイープ。anchor より上には上げない
  let lastTop = focused.anchor;
  for (let i = focusedIdx - 1; i >= 0; i--) {
    const item = sorted[i];
    const top = Math.min(item.anchor, lastTop - MEMO_GAP - item.height);
    result.set(item.id, top);
    lastTop = top;
  }

  return result;
}

export default function SideMemoLayer({ memos, onChange, editorViewRef }: SideMemoLayerProps) {
  const layerRef = useRef<HTMLDivElement>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const initialLayoutDoneRef = useRef(false);

  // ── 衝突回避レイアウト ──
  const relayout = useCallback(() => {
    const layer = layerRef.current;
    if (!layer) return;
    const cards = Array.from(layer.querySelectorAll<HTMLElement>('[data-memo-id]'));
    if (cards.length === 0) return;

    const left: LayoutItem[] = [];
    const right: LayoutItem[] = [];
    for (const el of cards) {
      const anchorRaw = el.dataset.anchorTop;
      if (anchorRaw == null) continue;
      const anchor = parseFloat(anchorRaw);
      if (!Number.isFinite(anchor)) continue;
      const memoId = el.dataset.memoId;
      if (!memoId) continue;
      const memo = memos.find((m) => m.id === memoId);
      if (!memo) continue;
      const item: LayoutItem = {
        id: memoId,
        side: memo.side,
        anchor,
        height: el.getBoundingClientRect().height,
        el,
      };
      if (memo.side === 'left') left.push(item);
      else right.push(item);
    }

    const tops = new Map<string, number>();
    resolveSide(left, focusedId).forEach((v, k) => tops.set(k, v));
    resolveSide(right, focusedId).forEach((v, k) => tops.set(k, v));

    const isFirst = !initialLayoutDoneRef.current;
    if (isFirst) {
      for (const el of cards) el.classList.add('memo-card--no-transition');
    }
    for (const item of [...left, ...right]) {
      const top = tops.get(item.id);
      if (top != null) item.el.style.top = `${top}px`;
      item.el.style.opacity = '1';
    }
    if (isFirst) {
      // 強制リフロー → クラス除去で次回以降はトランジションが効くようにする
      void layer.offsetHeight;
      requestAnimationFrame(() => {
        for (const el of cards) el.classList.remove('memo-card--no-transition');
      });
      initialLayoutDoneRef.current = true;
    }
  }, [memos, focusedId]);

  // ── アンカー位置更新 (プラグイン経由) を購読 ──
  useEffect(() => {
    const layer = layerRef.current;
    const container = layer?.parentElement;
    if (!container) return;
    const handler = () => relayout();
    container.addEventListener(MEMO_ANCHORS_UPDATED_EVENT, handler);
    return () => container.removeEventListener(MEMO_ANCHORS_UPDATED_EVENT, handler);
  }, [relayout]);

  // ── フォーカス変化、メモ配列変化のときに再レイアウト
  // (relayout の identity が memos / focusedId に依存しているのでこれだけで足りる) ──
  useEffect(() => {
    relayout();
  }, [relayout]);

  // ── 各カードの高さ変化を監視 ──
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => relayout());
    const cards = layer.querySelectorAll<HTMLElement>('[data-memo-id]');
    cards.forEach((c) => ro.observe(c));
    return () => ro.disconnect();
  }, [memos, relayout]);

  // ── ガターダブルクリックでメモ作成 ──
  const handleGutterDoubleClick = useCallback(
    (side: 'left' | 'right', e: React.MouseEvent) => {
      const view = editorViewRef.current;
      if (!view) return;
      const pos = posAtClientY(view, e.clientY);
      if (pos == null) return;
      const size = view.state.doc.content.size;
      const relativePos = size > 0 ? Math.max(0, Math.min(1, pos / size)) : 0;
      onChange([...memos, { id: crypto.randomUUID().slice(0, 8), side, relativePos, content: '' }]);
    },
    [memos, onChange, editorViewRef],
  );

  return (
    <div className="side-memo-layer" ref={layerRef}>
      <div className="side-memo-gutter side-memo-gutter-left" onDoubleClick={(e) => handleGutterDoubleClick('left', e)} />
      <div className="side-memo-gutter side-memo-gutter-right" onDoubleClick={(e) => handleGutterDoubleClick('right', e)} />
      {memos.map((m) => (
        <MemoCard
          key={m.id}
          memo={m}
          onChange={(id, content) => onChange(memos.map((x) => (x.id === id ? { ...x, content } : x)))}
          onDelete={(id) => onChange(memos.filter((x) => x.id !== id))}
          onFocusChange={(id, focused) => setFocusedId((cur) => (focused ? id : cur === id ? null : cur))}
          editorViewRef={editorViewRef}
        />
      ))}
    </div>
  );
}

// ── 個別メモカード ──

interface MemoCardProps {
  memo: Memo;
  onChange: (id: string, content: string) => void;
  onDelete: (id: string) => void;
  onFocusChange: (id: string, focused: boolean) => void;
  editorViewRef: React.RefObject<EditorView | null>;
}

function MemoCard({ memo, onChange, onDelete, onFocusChange, editorViewRef }: MemoCardProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(false);
  const isNew = useRef(memo.content === '');

  // ── 自動高さ調整 ──
  const autoResize = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  }, []);

  useEffect(() => { autoResize(); }, [memo.content, autoResize]);
  useEffect(() => { requestAnimationFrame(autoResize); }, [autoResize]);

  // ── 新規作成時にフォーカス ──
  useEffect(() => {
    if (isNew.current) {
      setTimeout(() => textareaRef.current?.focus(), 50);
    }
  }, []);

  // ── Blur で空メモ削除 ──
  const handleBlur = useCallback(() => {
    setFocused(false);
    onFocusChange(memo.id, false);
    if (memo.content.trim() === '') onDelete(memo.id);
  }, [memo.content, memo.id, onDelete, onFocusChange]);

  const handleFocus = useCallback(() => {
    setFocused(true);
    onFocusChange(memo.id, true);
  }, [memo.id, onFocusChange]);

  // ── キーボード ──
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      (document.querySelector('.ProseMirror') as HTMLElement | null)?.focus();
    }
    e.stopPropagation();
  }, []);

  // ── ドラッグ ──
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const card = cardRef.current;
    const view = editorViewRef.current;
    if (!card || !view) return;
    const startY = e.clientY;
    // マウスはカード上端からこの距離分下にある。ドロップ時にこの分を差し引いて
    // カード上端の位置を基準に pos を解決することで見た目のズレを抑える。
    const mouseOffsetFromCardTop = startY - card.getBoundingClientRect().top;

    card.classList.add('memo-card--dragging');
    const onMove = (ev: MouseEvent) => {
      card.style.transform = `translateY(${ev.clientY - startY}px)`;
      card.style.opacity = '0.7';
    };
    const onUp = (ev: MouseEvent) => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      card.style.transform = '';
      card.style.opacity = '';
      card.classList.remove('memo-card--dragging');

      // カードの上端が来るべき Y 座標 = マウス位置 - ハンドルまでのオフセット
      // posAtCoords は文字の行の上端にスナップする（行単位の離散化）
      const pos = posAtClientY(view, ev.clientY - mouseOffsetFromCardTop);
      if (pos != null) {
        view.dispatch(view.state.tr.setMeta(memoPluginKey, { memoId: memo.id, pos }));
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [memo.id, editorViewRef]);

  return (
    <div
      ref={cardRef}
      data-memo-id={memo.id}
      className={`memo-card memo-card--${memo.side}${focused ? ' memo-card--focused' : ''}`}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <div className="memo-card-drag" onMouseDown={handleDragStart} />
      <button className="memo-card-delete" onClick={() => onDelete(memo.id)}>×</button>
      <textarea
        ref={textareaRef}
        className="memo-card-textarea"
        value={memo.content}
        placeholder="memo"
        rows={1}
        onChange={(e) => { onChange(memo.id, e.target.value); autoResize(); }}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
      />
    </div>
  );
}
