import { writeTextFile, remove } from '@tauri-apps/plugin-fs';

/**
 * vault（ユーザーの .md）を書き換える処理は、すべてこのモジュールを通す。
 * 書き換える場所を一か所に集めて、どこから vault が変わりうるかを追えるようにする（2026-06 のデータ消失の教訓）。
 * @tauri-apps/plugin-fs の書き込み系は、eslint（no-restricted-imports）でここ以外から使えない。
 */

export async function writeVaultFile(path: string, content: string): Promise<void> {
  await writeTextFile(path, content);
}

export async function removeVaultFile(path: string): Promise<void> {
  await remove(path);
}
