import { TextSelection } from '@milkdown/prose/state';
import type { EditorView } from '@milkdown/prose/view';

/**
 * メイン画面とバイザーのあいだで受け渡す、編集中の状態（src-tauri/src/visor.rs のバトン）。
 * 手放す側は保存を確定させてから渡すので、本文は含めない（受け取る側がファイルから読む）。
 */
export interface Baton {
  /** 開いているファイル名。null なら受け取る側は自分のファイルのまま */
  file: string | null;
  /** キャレット（選択範囲）。ProseMirror の位置なので、同じ内容の文書どうしでだけ意味がある */
  anchor?: number;
  head?: number;
}

export interface Caret {
  anchor: number;
  head: number;
}

export function caretOf(baton: Baton): Caret | null {
  if (baton.anchor === undefined || baton.head === undefined) return null;
  return { anchor: baton.anchor, head: baton.head };
}

/** キャレットを置き直す。文書が変わっていても落ちないよう、範囲内の近い位置に寄せる */
export function restoreCaret(view: EditorView, { anchor, head }: Caret) {
  const { doc } = view.state;
  const clamp = (pos: number) => Math.max(0, Math.min(pos, doc.content.size));
  const selection = TextSelection.between(doc.resolve(clamp(anchor)), doc.resolve(clamp(head)));
  view.dispatch(view.state.tr.setSelection(selection).scrollIntoView());
}
