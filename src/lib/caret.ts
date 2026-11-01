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

/**
 * キャレットが、いまいる textblock の最上段（見た目の 1 行目）にあるか。上矢印でその textblock の上へ出るかの判定に使う。
 *
 * ProseMirror の `endOfTextblock('up')` は使わない。WebKit は折り返した行の先頭の 1 文字の矩形として
 * 前の行の右端も返すので、折り返した 2 行目の先頭にいても最上段だと判定されてしまう。
 */
export function caretOnFirstLine(view: EditorView): boolean {
  const { $head } = view.state.selection;
  const offset = $head.parentOffset;
  if (offset === 0) return true;

  // 強制改行（コードブロックなら \n）より後ろなら 2 行目以降
  let afterBreak = false;
  $head.parent.forEach((child, childOffset) => {
    if (childOffset >= offset) return;
    if (child.type.name === 'hardbreak') afterBreak = true;
    else if (child.isText && child.text!.slice(0, offset - childOffset).includes('\n')) afterBreak = true;
  });
  if (afterBreak) return false;

  // ここから先は折り返し。最初の文字の行より下にあるかで見る
  const first = view.coordsAtPos($head.start(), 1);
  const below = (rect: { top: number }) => rect.top > (first.top + first.bottom) / 2;
  // 前の文字が 2 行目以降なら、キャレットも 2 行目以降
  if (below(view.coordsAtPos($head.pos, -1))) return false;
  // 後ろの文字も最上段なら、最上段の途中
  const after = glyphRectAfter(view, $head.pos);
  if (!after || !below(after)) return true;
  // 折り返し位置。同じ位置が「最上段の右端」にも「2 行目の先頭」にもなり、どちらに描いているかは DOM の選択範囲しか知らない
  return domCaretOnLineOf(view, $head.start());
}

/** pos の直後の文字の矩形。文字でなければ null。WebKit が混ぜる幅 0 の矩形（前の行の右端）は除く */
function glyphRectAfter(view: EditorView, pos: number): DOMRect | null {
  const { node, offset } = view.domAtPos(pos, 1);
  const text = node.nodeType === Node.TEXT_NODE ? (node.nodeValue ?? '') : '';
  if (offset >= text.length) return null;
  const code = text.charCodeAt(offset);
  const end = code >= 0xd800 && code <= 0xdbff ? offset + 2 : offset + 1; // サロゲートペアは割らない
  const range = node.ownerDocument!.createRange();
  range.setStart(node, offset);
  range.setEnd(node, Math.min(end, text.length));
  const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0);
  return rects[rects.length - 1] ?? null;
}

/** 画面上のキャレット（DOM の選択範囲）が、pos と同じ行にあるか。選択範囲は元に戻す */
function domCaretOnLineOf(view: EditorView, pos: number): boolean {
  const sel = view.dom.ownerDocument.getSelection();
  if (!sel || !sel.isCollapsed || !sel.focusNode || !view.dom.contains(sel.focusNode)) return false;
  const { focusNode, focusOffset } = sel;
  let lineStart: number | null = null;
  try {
    sel.modify('move', 'backward', 'lineboundary');
    if (sel.focusNode) lineStart = view.posAtDOM(sel.focusNode, sel.focusOffset);
  } catch {
    /* 判定できなければ 2 行目の先頭とみなす */
  } finally {
    sel.collapse(focusNode, focusOffset);
  }
  return lineStart === pos;
}

/** キャレットを置き直す。文書が変わっていても落ちないよう、範囲内の近い位置に寄せる。`scroll` が false ならスクロールしない */
export function restoreCaret(view: EditorView, { anchor, head }: Caret, { scroll = true } = {}) {
  const { doc } = view.state;
  const clamp = (pos: number) => Math.max(0, Math.min(pos, doc.content.size));
  const selection = TextSelection.between(doc.resolve(clamp(anchor)), doc.resolve(clamp(head)));
  const tr = view.state.tr.setSelection(selection);
  view.dispatch(scroll ? tr.scrollIntoView() : tr);
}
