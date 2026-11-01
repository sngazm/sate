# 設定

実装は `src/hooks/useSettings.ts`。設定は `~/Library/Application Support/club.image.sate/settings.json`
に保存される。

```jsonc
{
  "baseDir": "/Users/foo/Documents/Sate",       // ユーザーファイル（.md）の保存先
  "publishCommand": "~/my-site/publish.sh",     // 公開コマンド（省略時は公開機能無効）
  "hotkeyEnabled": true,                        // どのアプリからでもホットキーで Sate を開閉するか（省略時はオフ = 登録しない）
  "hotkey": "Alt+Space",                        // そのホットキー（省略時は Alt+Space）
  "escToClose": true                            // Esc キーでも Sate を閉じるか（省略時はオフ）
}
```

環境設定の「起動と開閉」の欄には、上から「ログイン時に起動する」「ホットキーで Sate を開閉する」（とキーの欄）
「Esc キーでも閉じる」を並べる。どれも初期値はオフ。

## ログイン時に起動する

環境設定の「起動と開閉」の欄にある。settings.json には持たず、macOS 側の登録（`~/Library/LaunchAgents/Sate.plist`）を正とする。
環境設定を開くたびに登録があるかを読み、保存したときに変わっていれば登録し直す（tauri-plugin-autostart）。
ログイン時に起動したときは引数 `--launched-at-login` が付き、画面は出さずに待つ（[dive.md](dive.md)）。

> フォント（游ゴシック/游明朝）やテーマ（dark/light）の切り替えは未実装のため、設定項目には無い。
