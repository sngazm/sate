import { useCallback, useEffect, useRef } from 'react';
import type { EditorView } from '@milkdown/prose/view';
import type { Node as ProseNode } from '@milkdown/prose/model';
import { caretOnFirstLine } from '../lib/caret';
import './TitleInput.css';

/** 文書で最初の textblock の中身の開始位置。textblock が無ければ null */
function firstTextblockStart(doc: ProseNode): number | null {
  let found: number | null = null;
  doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.isTextblock) {
      found = pos + 1;
      return false;
    }
    return true;
  });
  return found;
}

interface TitleInputProps {
  value: string | null;
  onChange: (title: string | null) => void;
  editorViewRef: React.MutableRefObject<EditorView | null>;
}

export default function TitleInput({ value, onChange, editorViewRef }: TitleInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  // WebKit では変換確定の Enter の keydown が compositionend の後に届き、isComposing が false になる。
  // compositionend から少しの間は変換中とみなして、その Enter を拾わないようにする（FindBar と同じ）。
  const composingRef = useRef(false);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = e.target.value;
      onChange(v || null);
    },
    [onChange]
  );

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // IME 変換中のキーは IME に任せる（確定の Enter・候補選択の ↓・取り消しの Esc で本文へ移ったり抜けたりしないように）
    if (composingRef.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' || e.key === 'ArrowDown') {
      e.preventDefault();
      const editor = document.querySelector('.ProseMirror') as HTMLElement | null;
      editor?.focus();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      inputRef.current?.blur();
    }
  }, []);

  // エディタから上矢印キーでタイトルにフォーカス
  // capture phase で受けて、ProseMirror が処理する前に判定する。
  // 「最初の textblock の最上段 visual line」かつ IME 変換中でない場合のみ移動。
  // 最上段かは endOfTextblock ではなく caretOnFirstLine で見る（折り返した 2 行目の先頭を誤判定するため）。
  // トップレベルのブロック位置ではなく textblock で判定する。箇条書きはリスト全体が
  // 1つのトップレベルブロックなので、ブロック位置だけ見ると2つ目以降の項目からも
  // タイトルへ飛んでしまう。
  useEffect(() => {
    const handleEditorKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowUp') return;
      if (e.isComposing || e.keyCode === 229) return;

      const view = editorViewRef.current;
      if (!view || view.isDestroyed) return;
      if (!view.hasFocus()) return;

      const { state } = view;
      const { $head, empty } = state.selection;
      if (!empty) return;
      if (!$head.parent.isTextblock) return;
      if ($head.start() !== firstTextblockStart(state.doc)) return;
      if (!caretOnFirstLine(view)) return;

      e.preventDefault();
      e.stopPropagation();
      inputRef.current?.focus();
    };

    document.addEventListener('keydown', handleEditorKeyDown, true);
    return () => document.removeEventListener('keydown', handleEditorKeyDown, true);
  }, [editorViewRef]);

  return (
    <div className="title-input-area">
      <input
        ref={inputRef}
        className="title-input"
        type="text"
        value={value ?? ''}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={() => {
          setTimeout(() => { composingRef.current = false; }, 50);
        }}
        placeholder=""
        spellCheck={false}
        autoComplete="off"
      />
    </div>
  );
}
