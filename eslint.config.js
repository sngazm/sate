import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // vault への書き込みは src/lib/vaultWrite.ts を通す（メイン画面とバイザーの上書き防止。spec/visor.md）
      'no-restricted-imports': ['error', {
        paths: [{
          name: '@tauri-apps/plugin-fs',
          importNames: ['writeTextFile', 'writeFile', 'remove', 'rename', 'copyFile', 'truncate', 'create'],
          message: 'vault のファイルは src/lib/vaultWrite.ts の writeVaultFile / removeVaultFile で書き換える（バトンを持たない画面が書くと上書き事故になる）。',
        }],
      }],
    },
  },
  {
    // fs の書き込みを直接使ってよいファイル
    // - vaultWrite.ts: 書き込みの入口そのもの
    // - reconcile.ts: 照合でフロントマターを補う。メイン画面だけが起動時に行う（App.tsx）
    // - db.ts, useSettings.ts: vault ではなく AppConfig（DB の移行、settings.json）に書く
    files: ['src/lib/vaultWrite.ts', 'src/lib/reconcile.ts', 'src/lib/db.ts', 'src/hooks/useSettings.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
])
