// バイザーのホットキーは、Rust 側（global-hotkey）がそのまま読める "Alt+Space" 形式の文字列で持つ。
// 修飾キーは Ctrl / Alt / Shift / Cmd、キーは KeyboardEvent.code の名前（KeyA, Digit1, F12, Space など）。

// バイザーは環境設定でオンにしたときだけホットキーを登録する（初期値はオフ）。macOS のホットキーは
// 他のアプリと取り合いになっても登録が失敗しないので、勝手に登録すると他のアプリのショートカットや
// ⌥Space の入力を黙って奪ってしまう。
export const DEFAULT_VISOR_SHORTCUT = 'Alt+Space';

const MODIFIER_CODES = new Set([
  'MetaLeft', 'MetaRight', 'ShiftLeft', 'ShiftRight',
  'AltLeft', 'AltRight', 'ControlLeft', 'ControlRight', 'CapsLock', 'Fn',
]);

const MODIFIER_SYMBOLS: [string, string][] = [
  ['Ctrl', '⌃'], ['Alt', '⌥'], ['Shift', '⇧'], ['Cmd', '⌘'],
];

const KEY_LABELS: Record<string, string> = {
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
  Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  Enter: '↩', Tab: '⇥', Backspace: '⌫', Delete: '⌦', Escape: 'Esc',
};

/** "Cmd+Shift+KeyA" → "⇧⌘A"（macOS のメニューと同じ並び順） */
export function formatShortcut(shortcut: string): string {
  const parts = shortcut.split('+');
  const key = parts.pop() ?? '';
  const mods = MODIFIER_SYMBOLS.filter(([name]) => parts.includes(name)).map(([, symbol]) => symbol).join('');
  const label = KEY_LABELS[key] ?? key.replace(/^(Key|Digit)/, '').replace(/^Numpad/, 'Num ');
  return mods + label;
}

/** 押されたキーからホットキー文字列を作る。修飾キーだけが押されたときは null */
export function shortcutFromKeyEvent(e: KeyboardEvent): string | null {
  if (MODIFIER_CODES.has(e.code)) return null;
  const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Cmd'].filter(Boolean);
  return [...mods, e.code].join('+');
}

/** 修飾キーなしでもホットキーにしてよいキー（ファンクションキー） */
export function isFunctionKey(code: string): boolean {
  return /^F\d+$/.test(code);
}
