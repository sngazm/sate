import { useState, useEffect, useCallback } from 'react';
import {
  writeTextFile,
  readTextFile,
  mkdir,
  exists,
  BaseDirectory,
} from '@tauri-apps/plugin-fs';
import { homeDir, join } from '@tauri-apps/api/path';

// Settings are stored in ~/Library/Application Support/club.image.sate/ (macOS)
// Tauri's AppConfig BaseDirectory maps to the OS-standard config location.
const CONFIG_FILE = 'settings.json';

export interface Settings {
  baseDir: string; // Absolute path, e.g. "/Users/foo/Documents/Sate"
  publishCommand?: string; // 公開時に実行するシェルコマンド。未設定なら公開機能は無効。
  hotkeyEnabled?: boolean; // どのアプリからでもホットキーで Sate を開閉するか。未設定ならオフ（登録しない）。
  hotkey?: string; // そのホットキー（"Alt+Space" 形式）。未設定なら DEFAULT_HOTKEY。
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
              hotkeyEnabled: parsed.hotkeyEnabled,
              hotkey: parsed.hotkey,
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
