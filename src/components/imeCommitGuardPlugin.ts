/**
 * IME の確定で箇条書きの項目が分割・複製されるのを防ぐプラグイン
 *
 * WebKit（Tauri の WebView）は IME の確定時に、変換中の文字列をいったん消してから
 * 確定した文字列を入れ直す（deleteCompositionText → insertFromComposition）。
 * 項目の中身が変換中の文字列だけだと、消した時点で WebKit が <li> ごと取り除き、
 * DOM が <ul><br></ul> になる。ProseMirror はこの DOM 変化を「Enter で分割された」と
 * 推定して Enter のコマンド（項目の分割）を実行し、そのあと WebKit が確定文字列を
 * カーソルのある新しい項目に入れ直す。結果、確定しただけで項目が増え、直前の項目と
 * 同じ文字列が次の項目にも入る（変換中の文節が選択されていた場合は、文字列が次の
 * 項目へ移って元の項目が空になる）。
 *
 * 変換中に handleKeyDown へ Enter が届くのは、この DOM 変化からの推定だけ
 * （本物の Enter キーは、変換中は ProseMirror が handleKeyDown に渡さない）。
 * そこで推定の Enter が来たら分割はせず、変換中の文字列だけを消す。続く
 * insertFromComposition で確定文字列が同じ位置に入り、1 つの項目に収まる。
 *
 * 変換中の文字列の位置は、composition メタの付いたトランザクションが変更した範囲を
 * 追って求める。念のため、その範囲の文字列が直近の compositionupdate の内容と
 * 一致するときだけ消す（一致しなければ ProseMirror の既定の動作に任せる）。
 */
import { Plugin, PluginKey } from '@milkdown/prose/state';
import type { Transaction } from '@milkdown/prose/state';
import { $prose } from '@milkdown/utils';

interface ComposedRange {
  /** ProseMirror が振る composition の ID（composition メタの値） */
  id: number;
  from: number;
  to: number;
}

const key = new PluginKey<ComposedRange | null>('ime-commit-guard');

/** tr が変更した範囲を、tr 適用後の位置で返す */
function changedRange(tr: Transaction): { from: number; to: number } | null {
  let from = Infinity;
  let to = -Infinity;
  tr.mapping.maps.forEach((map, i) => {
    const rest = tr.mapping.slice(i + 1);
    map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      from = Math.min(from, rest.map(newStart, -1));
      to = Math.max(to, rest.map(newEnd, 1));
    });
  });
  return from === Infinity ? null : { from, to };
}

function track(tr: Transaction, prev: ComposedRange | null): ComposedRange | null {
  if (!tr.docChanged) return prev;
  const mapped = prev && { ...prev, from: tr.mapping.map(prev.from, -1), to: tr.mapping.map(prev.to, 1) };
  const id = tr.getMeta('composition') as number | undefined;
  if (id === undefined) return mapped;
  const changed = changedRange(tr);
  if (!changed) return mapped;
  if (!mapped || mapped.id !== id) return { id, ...changed };
  return { id, from: Math.min(mapped.from, changed.from), to: Math.max(mapped.to, changed.to) };
}

export function createImeCommitGuardPlugin() {
  // 直近の compositionupdate の内容（変換中の文字列そのもの）
  let composing = '';

  return new Plugin<ComposedRange | null>({
    key,
    state: {
      init: () => null,
      apply: (tr, prev) => track(tr, prev),
    },
    props: {
      handleDOMEvents: {
        compositionstart() {
          composing = '';
          return false;
        },
        compositionupdate(_view, event) {
          composing = event.data;
          return false;
        },
      },
      handleKeyDown(view, event) {
        if (!view.composing || event.key !== 'Enter') return false;
        const range = key.getState(view.state);
        if (!range || range.from >= range.to || !composing) return false;
        if (view.state.doc.textBetween(range.from, range.to) !== composing) return false;
        view.dispatch(view.state.tr.delete(range.from, range.to));
        return true;
      },
    },
  });
}

export const imeCommitGuardPlugin = $prose(() => createImeCommitGuardPlugin());
