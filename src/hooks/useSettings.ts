import { useState, useEffect, useCallback } from 'react';
import {
  writeTextFile,
  readTextFile,
  mkdir,
  exists,
  BaseDirectory,
} from '@tauri-apps/plugin-fs';
import { homeDir, join } from '@tauri-apps/api/path';
import { emitTo } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';

// Settings are stored in ~/Library/Application Support/club.image.sate/ (macOS)
// Tauri's AppConfig BaseDirectory maps to the OS-standard config location.
const CONFIG_FILE = 'settings.json';

export interface Settings {
  baseDir: string; // Absolute path, e.g. "/Users/foo/Documents/Sate"
  publishCommand?: string; // 公開時に実行するシェルコマンド。未設定なら公開機能は無効。
  visorEnabled?: boolean; // バイザーを使うか。未設定ならオフ（ホットキーを登録しない）。
  visorShortcut?: string; // バイザーのホットキー（"Alt+Space" 形式）。未設定なら DEFAULT_VISOR_SHORTCUT。
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loaded, setLoaded] = useState(false);

  // Load settings from file on mount
  useEffect(() => {
    (async () => {
      try {
        const fileExists = await exists(CONFIG_FILE, {
          baseDir: BaseDirectory.AppConfig,
        });
        if (fileExists) {
          const text = await readTextFile(CONFIG_FILE, {
            baseDir: BaseDirectory.AppConfig,
          });
          const parsed = JSON.parse(text) as Partial<Settings>;
          if (parsed.baseDir) {
            setSettings({
              baseDir: parsed.baseDir,
              publishCommand: parsed.publishCommand,
              visorEnabled: parsed.visorEnabled,
              visorShortcut: parsed.visorShortcut,
            });
          }
        }

        // If no settings loaded, use default
        if (!settings) {
          const home = await homeDir();
          const defaultDir = await join(home, 'Documents', 'Sate');
          setSettings((prev) => prev ?? { baseDir: defaultDir });
        }
      } catch (err) {
        console.error('Failed to load settings:', err);
        try {
          const home = await homeDir();
          const defaultDir = await join(home, 'Documents', 'Sate');
          setSettings({ baseDir: defaultDir });
        } catch {
          setSettings({ baseDir: '~/Documents/Sate' });
        }
      } finally {
        setLoaded(true);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 設定はメイン画面で変え、バイザーには保存したときに知らせる（updateSettings）。
  // 保存先ディレクトリが食い違ったまま書き込むと、別の場所にファイルができてしまう
  useEffect(() => {
    const unlisten = getCurrentWebviewWindow().listen<Settings>('settings-changed', ({ payload }) => {
      setSettings(payload);
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  const updateSettings = useCallback(async (newSettings: Settings) => {
    setSettings(newSettings);
    try {
      // Ensure the AppConfig directory exists
      const dirExists = await exists('', {
        baseDir: BaseDirectory.AppConfig,
      });
      if (!dirExists) {
        await mkdir('', {
          baseDir: BaseDirectory.AppConfig,
          recursive: true,
        });
      }
      await writeTextFile(CONFIG_FILE, JSON.stringify(newSettings, null, 2), {
        baseDir: BaseDirectory.AppConfig,
      });
      await emitTo('visor', 'settings-changed', newSettings);
    } catch (err) {
      console.error('Failed to save settings:', err);
    }
  }, []);

  return {
    settings,
    loaded,
    updateSettings,
  };
}
