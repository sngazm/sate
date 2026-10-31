# Sate 仕様書

## 目次

- [editor.md](editor.md) — エディタ画面 — レイアウト、組版、タイプライタースクロール、制御文字
- [files.md](files.md) — ファイル管理 — 命名規則、保存先
- [frontmatter.md](frontmatter.md) — フロントマター — メタデータの形式、ファイル同一性の解決
- [snapshots.md](snapshots.md) — スナップショット — SQLite DB、全文検索索引、Reconcile、タイムマシン（Rewind）UI
- [file-overlay.md](file-overlay.md) — ファイルオーバーレイ — Cmd+O の一覧・検索
- [notifications.md](notifications.md) — 通知制御
- [sound.md](sound.md) — 音（将来対応）
- [side-memo.md](side-memo.md) — サイドメモ — 操作、保存データ、位置追跡
- [modes.md](modes.md) — 書くモード / 推敲モード（検討中）
- [timer.md](timer.md) — タイマー
- [private.md](private.md) — プライベートファイル
- [find.md](find.md) — 文書内検索（Cmd+F）
- [publish.md](publish.md) — 公開コマンド
- [shortcuts.md](shortcuts.md) — キーボードショートカット一覧
- [settings.md](settings.md) — 設定ファイル
- [startup.md](startup.md) — 起動時の挙動
- [visor.md](visor.md) — バイザーモード（試作）— ホットキーで画面に重なるエディタ
- [style-guide.md](style-guide.md) — スタイルガイド — カラーパレット、アニメーション
- [roadmap.md](roadmap.md) — 実装フェーズと追加機能の一覧

## 技術スタック

| レイヤー | 選定 | 理由 |
|---|---|---|
| フレームワーク | **Tauri v2** | 軽量、Rustバックエンド、React資産が使える |
| フロントエンド | **React + TypeScript** | — |
| エディタ | **Milkdown** | Markdownネイティブ、WYSIWYGでの一致 |
| ファイルI/O | `@tauri-apps/plugin-fs` | Rustコマンド不要でファイルシステムアクセス |
| DB | **SQLite** (`tauri-plugin-sql`) | スナップショット・全文検索の管理 |
| 全文検索 | SQLite FTS（全文検索） | スナップショットDBと統合 |
| 対象OS | **macOS** | 初期はmacOSのみ |

## ディレクトリ構成（現状）

```
sate/
├── src-tauri/          # Rustバックエンド
│   ├── src/
│   │   └── main.rs
│   └── tauri.conf.json
├── src/                # Reactフロントエンド
│   ├── components/
│   │   ├── Editor.tsx               # Milkdownエディタ本体
│   │   ├── FileHeader.tsx           # タイトル入力・Privateチェック
│   │   ├── controlCharFilterPlugin.ts # 制御文字の混入防止（ProseMirrorプラグイン）
│   │   ├── FileOpenDialog.tsx       # ファイル一覧・検索オーバーレイ
│   │   ├── FindBar.tsx              # 文書内検索バー（Cmd+F）
│   │   ├── RewindOverlay.tsx        # タイムマシン（Rewind）UI
│   │   ├── SettingsDialog.tsx       # 環境設定
│   │   ├── ShortcutHelp.tsx         # ショートカット一覧
│   │   ├── SideMemoLayer.tsx        # サイドメモのレイヤー
│   │   ├── memoDecorationPlugin.ts  # サイドメモ位置追跡（ProseMirrorプラグイン）
│   │   ├── searchPlugin.ts          # 文書内検索のヒット管理・ハイライト（ProseMirrorプラグイン）
│   │   ├── Timer.tsx                # タイマーUI
│   │   ├── TitleInput.tsx           # タイトル入力欄
│   │   └── WordCount.tsx            # 文字数カウンター
│   ├── hooks/
│   │   ├── useFile.ts               # ファイル保存・読み込み・スナップショット
│   │   ├── useSettings.ts           # 設定の読み書き
│   │   └── useTimer.ts              # タイマー・効果音
│   ├── lib/
│   │   ├── db.ts                    # SQLiteアクセス層・全文検索・スナップショット
│   │   ├── diff.ts                  # Rewind用の行差分
│   │   ├── frontmatter.ts           # フロントマターのパース/ビルド
│   │   └── reconcile.ts             # ファイルシステム ↔ DB 同期
│   ├── App.tsx
│   └── main.tsx
├── public/
│   └── se/                          # 効果音（タイマー）
# ユーザーの保存先フォルダ（アプリ外）
# {vault}/
# └── 2025-03-30-001.md       ← .mdファイル本体（vault には .md だけを置く）
#
# アプリ専用ディレクトリ（OS の AppConfig）
# macOS: ~/Library/Application Support/club.image.sate/
# ├── settings.json           ← アプリ設定
# └── sate.db                 ← スナップショット・検索インデックス
├── spec/                     # 仕様書（README.md が目次）
└── package.json
```

## 参考

- **Ommwriter** — 没入体験、タイピング音、BGMの先駆け
- **Stone (NDC)** — 游ゴシック/游明朝の2択、文章が中央から始まる
- **iA Writer** — フォーカスモード、シンプルな思想
- **Processing IDE** — 日付+連番のファイル自動命名
