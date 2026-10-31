import { TextSelection } from '@milkdown/prose/state';
import type { EditorView } from '@milkdown/prose/view';

/** キャレット（選択範囲）。ProseMirror の位置 */
export interface Caret {
  anchor: number;
  head: number;
}

export function caretOf(view: EditorView): Caret {
  return { anchor: view.state.selection.anchor, head: view.state.selection.head };
}

/** キャレットを置き直す。文書が変わっていても落ちないよう、範囲内の近い位置に寄せる */
export function restoreCaret(view: EditorView, { anchor, head }: Caret) {
  const { doc } = view.state;
  const clamp = (pos: number) => Math.max(0, Math.min(pos, doc.content.size));
  const selection = TextSelection.between(doc.resolve(clamp(anchor)), doc.resolve(clamp(head)));
  view.dispatch(view.state.tr.setSelection(selection).scrollIntoView());
}
