# 設定

実装は `src/hooks/useSettings.ts`。設定は `~/Library/Application Support/club.image.sate/settings.json`
に保存される。

```jsonc
{
  "baseDir": "/Users/foo/Documents/Sate",       // ユーザーファイル（.md）の保存先
  "publishCommand": "~/my-site/publish.sh",     // 公開コマンド（省略時は公開機能無効）
  "hotkeyEnabled": true,                        // どのアプリからでもホットキーで Sate を開閉するか（省略時はオフ = 登録しない）
  "hotkey": "Alt+Space"                         // そのホットキー（省略時は Alt+Space）
}
```

> フォント（游ゴシック/游明朝）やテーマ（dark/light）の切り替えは未実装のため、設定項目には無い。
