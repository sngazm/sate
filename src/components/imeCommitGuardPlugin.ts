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
 * ProseMirror が DOM 変化から推定した Enter は keyEvent() で作った素の Event で、
 * 本物のキー入力（KeyboardEvent）と区別できる。推定の Enter が来たら分割はせず、
 * 変換中の文字列だけを消す。続く insertFromComposition で確定文字列が同じ位置に入り、
 * 1 つの項目に収まる。view.composing は使わない。WebKit は compositionend を
 * 先に投げてから DOM を消すことがあり、その時点で composing は false になっているため。
 *
 * 変換中の文字列の位置は、composition メタの付いたトランザクションが変更した範囲を
 * 追って求める。念のため、その範囲の文字列が直近の compositionupdate の内容と
 * 一致するときだけ消す（一致しなければ ProseMirror の既定の動作に任せる）。
 * 消すトランザクションには同じ composition メタを付けて、history で変換中の入力と
 * 同じ履歴にまとめる。
 */
import { Plugin, PluginKey } from '@milkdown/prose/state';
import type { Transaction } from '@milkdown/prose/state';
import { $prose } from '@milkdown/utils';
import { changedRanges } from '../lib/changedRanges';

interface ComposedRange {
  /** ProseMirror が振る composition の ID（composition メタの値） */
  id: number;
  from: number;
  to: number;
}

const key = new PluginKey<ComposedRange | null>('ime-commit-guard');

/** tr が変更した範囲全体を、tr 適用後の位置で返す */
function changedRange(tr: Transaction): { from: number; to: number } | null {
  const ranges = changedRanges([tr]);
  if (ranges.length === 0) return null;
  return {
    from: Math.min(...ranges.map((r) => r.from)),
    to: Math.max(...ranges.map((r) => r.to)),
  };
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
          composing = event.data ?? '';
          return false;
        },
      },
      handleKeyDown(view, event) {
        // 本物のキー入力が届いた時点で、確定直後の推定 Enter が来る余地はない
        if (typeof KeyboardEvent !== 'undefined' && event instanceof KeyboardEvent) {
          composing = '';
          return false;
        }
        if (event.key !== 'Enter') return false;
        const range = key.getState(view.state);
        if (!range || range.from >= range.to || !composing) return false;
        if (view.state.doc.textBetween(range.from, range.to) !== composing) return false;
        view.dispatch(view.state.tr.delete(range.from, range.to).setMeta('composition', range.id));
        return true;
      },
    },
  });
}

export const imeCommitGuardPlugin = $prose(() => createImeCommitGuardPlugin());
