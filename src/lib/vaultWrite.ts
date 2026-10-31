import { writeTextFile, remove } from '@tauri-apps/plugin-fs';

/**
 * vault（ユーザーの .md）を書き換える処理は、すべてこのモジュールを通す。
 *
 * メイン画面とバイザーは同じファイルを開くので、書いてよいのはバトンを持っている画面だけ
 * （spec/visor.md）。持っていない画面が書くと、古い内容でもう一方の編集を上書きしてしまう。
 * @tauri-apps/plugin-fs の書き込み系は、eslint（no-restricted-imports）でここ以外から使えない。
 *
 * 画面（ウィンドウ）ごとに JS は別々に動くので、このフラグも画面ごとに持つ。
 * 最初は書けない。バトンを受け取ったら（useFile の acquireFile）書けるようになる。
 */
let writable = false;

export function setWritable(value: boolean) {
  writable = value;
}

export function isWritable() {
  return writable;
}

/** 書けたら true。バトンを持っていなければ書かずに false */
export async function writeVaultFile(path: string, content: string): Promise<boolean> {
  if (!writable) return false;
  await writeTextFile(path, content);
  return true;
}

/** 消せたら true。バトンを持っていなければ消さずに false */
export async function removeVaultFile(path: string): Promise<boolean> {
  if (!writable) return false;
  await remove(path);
  return true;
}
