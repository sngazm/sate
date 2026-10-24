import { useRef, useEffect } from 'react';
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from '@milkdown/core';
import { commonmark, codeBlockKeymap } from '@milkdown/preset-commonmark';
import { history } from '@milkdown/plugin-history';
import { listener, listenerCtx } from '@milkdown/plugin-listener';
import { useEditor, Milkdown, MilkdownProvider, useInstance } from '@milkdown/react';
import { ProsemirrorAdapterProvider } from '@prosemirror-adapter/react';
import { $prose } from '@milkdown/utils';
import { Plugin, PluginKey, TextSelection } from '@milkdown/prose/state';
import { Decoration, DecorationSet } from '@milkdown/prose/view';
import { splitBlock } from '@milkdown/prose/commands';
import { closeHistory } from '@milkdown/prose/history';
import type { Memo } from '../lib/frontmatter';
import { createMemoPlugin, memoPluginKey, getPositions, syncPositionsToMemos } from './memoDecorationPlugin';
import { searchPlugin } from './searchPlugin';
import { controlCharFilterPlugin } from './controlCharFilterPlugin';
import { imeCommitGuardPlugin } from './imeCommitGuardPlugin';

interface EditorComponentProps {
  onChange: (markdown: string) => void;
  initialContent?: string;
  memosRef: React.RefObject<Memo[]>;
  memos: Memo[];
  onMemosChange: (memos: Memo[]) => void;
  editorViewRef: React.MutableRefObject<import('@milkdown/prose/view').EditorView | null>;
  containerRef: React.RefObject<HTMLDivElement | null>;
}

// Shift+Enter を通常のEnter（段落分割）と同じにする
const shiftEnterAsSplitPlugin = $prose(() => {
  return new Plugin({
    key: new PluginKey('shift-enter-as-split'),
    props: {
      handleKeyDown(view, event) {
        if (event.key === 'Enter' && event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
          return splitBlock(view.state, view.dispatch);
        }
        return false;
      },
    },
  });
});

// 箇条書きの操作（Enter での項目追加、Tab / Shift+Tab 等での階層変更）の前後で
// Undo 履歴を区切る。history は短時間に続いた隣接する編集を1つにまとめるため、
// 項目に文字を打ってすぐ Enter → Cmd+Z とすると、直前の文字入力まで消えてしまう。
//
// keymap より先に確実に走らせるため handleDOMEvents で拾う（handleKeyDown は
// プラグインの登録順によっては keymap に先に処理されてしまう）。
// 操作後の区切りは、keymap のコマンドが同期的に dispatch し終えてから入れる。
function isListKey(event: KeyboardEvent): boolean {
  if (event.altKey) return false;
  const mod = event.metaKey || event.ctrlKey;
  if (!mod && (event.key === 'Enter' || event.key === 'Tab')) return true;
  return mod && (event.key === '[' || event.key === ']');
}

const listHistoryBoundaryPlugin = $prose(() => {
  return new Plugin({
    key: new PluginKey('list-history-boundary'),
    props: {
      handleDOMEvents: {
        keydown(view, event) {
          // IME の確定 Enter は対象外
          if (event.isComposing || event.keyCode === 229) return false;
          if (!isListKey(event)) return false;
          const { $from } = view.state.selection;
          let inListItem = false;
          for (let d = $from.depth; d > 0; d--) {
            if ($from.node(d).type.name === 'list_item') {
              inListItem = true;
              break;
            }
          }
          if (!inListItem) return false;

          view.dispatch(closeHistory(view.state.tr));
          queueMicrotask(() => {
            if (!view.isDestroyed) view.dispatch(closeHistory(view.state.tr));
          });
          return false;
        },
      },
    },
  });
});

// コピー時のプレーンテキストを段落ごとに改行1つで区切る（デフォルトは\n\n）
const clipboardTextSerializerPlugin = $prose(() => {
  return new Plugin({
    key: new PluginKey('clipboard-text-serializer'),
    props: {
      clipboardTextSerializer(slice) {
        return slice.content.textBetween(0, slice.content.size, '\n');
      },
    },
  });
});

// タイプライター方式のスクロール。書いている行が画面の垂直中央より下に
// 行かないように、ProseMirror がカーソルを画面内に収めるタイミング
// （入力・改行・貼り付け・Undo 等）でカーソル行を中央まで持ち上げる。
// 中央より上で書いている間はスクロールしない（上のほうを直しているときに
// 1文字目で画面が跳ばないように）。
//
// ただし上下キーでのカーソル移動には適用しない。上下キーの移動は WebKit が行い、
// カーソルが画面外に出れば WebKit 自身が画面中央へスクロールさせる。そこへ
// ProseMirror が後追いでスクロールすると、WebKit が描いたカーソルの残像が
// 元の位置に残ることがある。
//
// 上下キーの keydown から、ProseMirror がカーソル移動を読み取ってスクロールを
// 要求するまでの猶予（ProseMirror 内部ではキー由来とみなす期間が 50ms）
const VERTICAL_KEY_WINDOW_MS = 100;

/** 一番近いスクロールコンテナ（Sate では .app） */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p);
    if (overflowY === 'auto' || overflowY === 'scroll') return p;
  }
  return null;
}

const typewriterScrollPlugin = $prose(() => {
  let verticalKeyAt = 0;
  return new Plugin({
    key: new PluginKey('typewriter-scroll'),
    props: {
      handleKeyDown(_view, event) {
        verticalKeyAt = event.key === 'ArrowUp' || event.key === 'ArrowDown' ? Date.now() : 0;
        return false;
      },
      // true を返すと ProseMirror 標準のスクロールは行われない
      handleScrollToSelection(view) {
        const { selection } = view.state;
        // ノード選択（区切り線など）は ProseMirror 標準のスクロールに任せる
        if (!(selection instanceof TextSelection)) return false;
        // 上下キーでの移動は WebKit のスクロールに任せる
        if (Date.now() - verticalKeyAt < VERTICAL_KEY_WINDOW_MS) return true;

        const scroller = scrollParent(view.dom as HTMLElement);
        if (!scroller) return false;
        const caret = view.coordsAtPos(selection.head);
        const box = scroller.getBoundingClientRect();
        const caretMid = (caret.top + caret.bottom) / 2;
        const center = box.top + box.height / 2;
        // 中央より下に来た、または画面の上に外れた（Undo 等）ときだけ中央へ
        if (caretMid > center || caret.top < box.top) {
          scroller.scrollTop += caretMid - center;
        }
        return true;
      },
    },
  });
});

// テキスト選択のハイライトをカスタムデコレーションで描画
const selectionHighlightPlugin = $prose(() => {
  return new Plugin({
    key: new PluginKey('selection-highlight'),
    props: {
      decorations(state) {
        const { from, to } = state.selection;
        if (from === to) return DecorationSet.empty;
        return DecorationSet.create(state.doc, [
          Decoration.inline(from, to, {
            class: 'sate-selection',
            style: 'background-color: #555048;',
          }),
        ]);
      },
    },
  });
});

function MilkdownEditor({ onChange, initialContent = '', memosRef, editorViewRef, containerRef }: Omit<EditorComponentProps, 'memos' | 'onMemosChange'>) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // メモ位置追跡プラグイン（Widget Decoration なし）
  const memoPlugin = useRef(
    $prose(() => createMemoPlugin(memosRef, containerRef)),
  ).current;

  useEditor((root) =>
    Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, initialContent);
        ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
          onChangeRef.current(markdown);
        });
      })
      .use(commonmark)
      .use(history)
      .use(listener)
      .use(shiftEnterAsSplitPlugin)
      .use(imeCommitGuardPlugin)
      .use(listHistoryBoundaryPlugin)
      .use(typewriterScrollPlugin)
      .use(selectionHighlightPlugin)
      .use(clipboardTextSerializerPlugin)
      .use(searchPlugin)
      .use(controlCharFilterPlugin)
      .use(memoPlugin)
      .config((ctx) => {
        ctx.set(codeBlockKeymap.key, {
          CreateCodeBlock: { shortcuts: '' },
        });
      }),
    []
  );

  // EditorView の参照を親に公開
  const [loading, getInstance] = useInstance();
  const didInitialFocusRef = useRef(false);
  useEffect(() => {
    if (loading) return;
    const editor = getInstance();
    if (!editor) return;
    try {
      const view = editor.ctx.get(editorViewCtx);
      editorViewRef.current = view;
      if (!didInitialFocusRef.current && view && !view.isDestroyed) {
        didInitialFocusRef.current = true;
        view.focus();
      }
    } catch { /* not ready */ }
  }, [loading, getInstance, editorViewRef]);

  return <Milkdown />;
}

/**
 * メモ構造変化(追加/削除)を検知して ProseMirror プラグインに通知する。
 * また、プラグインの位置マップを定期的に React state に書き戻す。
 */
function MemoSync({ memos, onMemosChange }: { memos: Memo[]; onMemosChange: (memos: Memo[]) => void }) {
  const [loading, getInstance] = useInstance();
  const prevIdsRef = useRef('');
  const onMemosChangeRef = useRef(onMemosChange);
  onMemosChangeRef.current = onMemosChange;
  const memosRef = useRef(memos);
  memosRef.current = memos;

  // メモ追加/削除時にプラグインに通知
  useEffect(() => {
    const ids = memos.map((m) => m.id).sort().join(',');
    if (ids === prevIdsRef.current) return;
    prevIdsRef.current = ids;

    if (loading) return;
    const editor = getInstance();
    if (!editor) return;
    queueMicrotask(() => {
      try {
        const view = editor.ctx.get(editorViewCtx);
        if (view && !view.isDestroyed) {
          view.dispatch(view.state.tr.setMeta(memoPluginKey, true));
        }
      } catch { /* not ready */ }
    });
  }, [memos, loading, getInstance]);

  // プラグインの位置マップ → React state への定期同期
  useEffect(() => {
    if (loading) return;
    const editor = getInstance();
    if (!editor) return;

    let lastJson = '';
    const timer = setInterval(() => {
      try {
        const view = editor.ctx.get(editorViewCtx);
        if (!view || view.isDestroyed) return;
        const positions = getPositions(view.state);
        if (!positions) return;
        const json = JSON.stringify([...positions]);
        if (json === lastJson) return;
        lastJson = json;
        const updated = syncPositionsToMemos(view.state.doc, memosRef.current, positions);
        if (updated) onMemosChangeRef.current(updated);
      } catch { /* not ready */ }
    }, 500);

    return () => clearInterval(timer);
  }, [loading, getInstance]);

  return null;
}

export default function EditorComponent({ onChange, initialContent, memosRef, memos, onMemosChange, editorViewRef, containerRef }: EditorComponentProps) {
  return (
    <MilkdownProvider>
      <ProsemirrorAdapterProvider>
        <MilkdownEditor onChange={onChange} initialContent={initialContent} memosRef={memosRef} editorViewRef={editorViewRef} containerRef={containerRef} />
        <MemoSync memos={memos} onMemosChange={onMemosChange} />
      </ProsemirrorAdapterProvider>
    </MilkdownProvider>
  );
}
