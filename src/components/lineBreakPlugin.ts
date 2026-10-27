/**
 * 改行と改段落をプレーンテキストと同じ感覚で扱うプラグイン
 *
 * - Return 1 回: 段落内の強制改行（hardbreak）。Markdown では行末スペース 2 つ
 * - Return 2 回: 改段落。直前の強制改行を取り除いて段落を分ける
 * - Shift+Return: すぐに改段落
 * - 段落先頭での Backspace: 前の段落とつないで強制改行にする（Return 2 回の逆）
 *
 * 画面上は段落の間に空行 1 つぶんの余白を置く（App.css）ので、
 * 見た目は「改行 = 1 行」「改段落 = 空行を挟む」というプレーンテキストと同じになる。
 * コピー・貼り付けのプレーンテキストも同じ対応で変換する。
 *
 * リスト・見出し・コードブロックの中では Milkdown 標準の挙動のまま。
 */
import { Plugin, PluginKey, TextSelection } from '@milkdown/prose/state';
import type { EditorState, Transaction } from '@milkdown/prose/state';
import { Fragment, Slice } from '@milkdown/prose/model';
import type { Node, ResolvedPos, Schema } from '@milkdown/prose/model';
import { splitBlock } from '@milkdown/prose/commands';
import { $prose } from '@milkdown/utils';

/** カーソル位置が、強制改行を使う段落（リストの中ではない段落）か */
function inPlainParagraph($pos: ResolvedPos): boolean {
  if ($pos.parent.type.name !== 'paragraph') return false;
  for (let d = $pos.depth - 1; d > 0; d--) {
    if ($pos.node(d).type.name === 'list_item') return false;
  }
  return true;
}

function handleEnter(state: EditorState, dispatch: (tr: Transaction) => void): boolean {
  const { selection } = state;
  if (!(selection instanceof TextSelection) || !inPlainParagraph(selection.$from)) return false;
  const hardbreak = state.schema.nodes.hardbreak;

  // 2 回目: 直前の強制改行を消して段落を分ける
  if (selection.empty && selection.$from.nodeBefore?.type === hardbreak) {
    const pos = selection.from - 1;
    const tr = state.tr.delete(pos, pos + 1).split(pos);
    tr.setSelection(TextSelection.create(tr.doc, pos + 2));
    dispatch(tr.scrollIntoView());
    return true;
  }

  dispatch(state.tr.replaceSelectionWith(hardbreak.create()).scrollIntoView());
  return true;
}

function handleBackspace(state: EditorState, dispatch: (tr: Transaction) => void): boolean {
  const { selection } = state;
  if (!(selection instanceof TextSelection) || !selection.empty) return false;
  const $pos = selection.$from;
  if ($pos.parentOffset !== 0 || !inPlainParagraph($pos)) return false;
  const boundary = $pos.before();
  const prev = state.doc.resolve(boundary).nodeBefore;
  // 前が空でない段落のときだけ。空段落や見出しなどは標準の挙動に任せる
  if (!prev || prev.type.name !== 'paragraph' || prev.content.size === 0) return false;

  const tr = state.tr.join(boundary);
  tr.insert(boundary - 1, state.schema.nodes.hardbreak.create());
  tr.setSelection(TextSelection.create(tr.doc, boundary));
  dispatch(tr.scrollIntoView());
  return true;
}

/**
 * プレーンテキスト → 段落の並び。
 * 改行 1 つは強制改行、空行は改段落。空行が 2 つ以上続くぶんは空段落にする。
 */
function parsePlainText(text: string, schema: Schema): Slice {
  const { paragraph, hardbreak } = schema.nodes;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Node[] = [];
  let inline: Node[] = [];
  let blankRun = 0;
  for (const line of lines) {
    if (line.trim() === '') {
      blankRun++;
      continue;
    }
    if (blankRun > 0 && inline.length > 0) {
      blocks.push(paragraph.create(null, inline));
      inline = [];
      blankRun--;
    }
    for (; blankRun > 0; blankRun--) blocks.push(paragraph.create());
    if (inline.length > 0) inline.push(hardbreak.create());
    inline.push(schema.text(line));
  }
  blocks.push(paragraph.create(null, inline));
  return new Slice(Fragment.from(blocks), 1, 1);
}

/**
 * 段落の並び → プレーンテキスト（parsePlainText の逆）。
 * 段落の後ろは空行を挟み、空段落の後ろは改行 1 つだけにする。
 */
function serializePlainText(slice: Slice): string {
  let text = '';
  let prevEmpty: boolean | null = null;
  slice.content.forEach((block) => {
    if (prevEmpty !== null) text += prevEmpty ? '\n' : '\n\n';
    text += Fragment.from(block).textBetween(0, block.nodeSize, '\n');
    prevEmpty = block.isTextblock && block.content.size === 0;
  });
  return text;
}

export const lineBreakPlugin = $prose(() => {
  return new Plugin({
    key: new PluginKey('line-break'),
    props: {
      handleKeyDown(view, event) {
        if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return false;
        if (event.key === 'Enter') {
          if (event.shiftKey) {
            if (!inPlainParagraph(view.state.selection.$from)) return false;
            return splitBlock(view.state, view.dispatch);
          }
          return handleEnter(view.state, view.dispatch);
        }
        if (event.key === 'Backspace' && !event.shiftKey) {
          return handleBackspace(view.state, view.dispatch);
        }
        return false;
      },
      clipboardTextParser(text, $context) {
        return parsePlainText(text, $context.doc.type.schema);
      },
      clipboardTextSerializer(slice) {
        return serializePlainText(slice);
      },
    },
  });
});
