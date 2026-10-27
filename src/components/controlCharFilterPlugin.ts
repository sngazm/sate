/**
 * 制御文字の混入を防ぐプラグイン
 *
 * WebKit（Tauri の WebView）では、どのショートカットにも割り当てられていない
 * Ctrl+Cmd+文字キー を押すと、その制御文字（例: Ctrl+Cmd+P → U+0010）が
 * そのまま本文に入力されてしまう。キー入力・貼り付け・DOM 経由など入口は問わず、
 * 変更された範囲に入った制御文字を appendTransaction で取り除く。
 *
 * - 変更された範囲だけを見るので、既存ファイルに元から含まれる制御文字は触らない
 * - 追加のトランザクションは history で元の入力と同じ履歴にまとまるため、Undo で復活しない
 */
import { Plugin, PluginKey } from '@milkdown/prose/state';
import { $prose } from '@milkdown/utils';
import { changedRanges } from '../lib/changedRanges';

// タブ（\x09）・改行（\x0A）・CR（\x0D）以外の C0 制御文字と DEL
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

export function createControlCharFilterPlugin() {
  return new Plugin({
    key: new PluginKey('control-char-filter'),
    appendTransaction(trs, _oldState, newState) {
      const ranges = changedRanges(trs);
      if (ranges.length === 0) return null;

      const positions = new Set<number>();
      for (const { from, to } of ranges) {
        newState.doc.nodesBetween(from, to, (node, pos) => {
          if (!node.isText) return true;
          for (const m of node.text!.matchAll(CONTROL_CHARS)) {
            const at = pos + m.index;
            if (at >= from && at < to) positions.add(at);
          }
          return false;
        });
      }
      if (positions.size === 0) return null;

      // 後ろから消せば、手前の位置がずれない
      const tr = newState.tr;
      for (const at of [...positions].sort((a, b) => b - a)) {
        tr.delete(at, at + 1);
      }
      return tr;
    },
  });
}

export const controlCharFilterPlugin = $prose(() => createControlCharFilterPlugin());
