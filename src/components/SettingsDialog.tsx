import { useState, useEffect, useCallback } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { disable as disableAutostart, enable as enableAutostart, isEnabled as isAutostartEnabled } from '@tauri-apps/plugin-autostart';
import type { Settings } from '../hooks/useSettings';
import { DEFAULT_HOTKEY } from '../lib/shortcut';
import ShortcutRecorder from './ShortcutRecorder';
import './SettingsDialog.css';

interface SettingsDialogProps {
  visible: boolean;
  settings: Settings;
  onSave: (settings: Settings) => void;
  onClose: () => void;
}

export default function SettingsDialog({
  visible,
  settings,
  onSave,
  onClose,
}: SettingsDialogProps) {
  const [baseDir, setBaseDir] = useState(settings.baseDir);
  const [publishCommand, setPublishCommand] = useState(settings.publishCommand ?? '');
  const savedEnabled = settings.hotkeyEnabled ?? false;
  const savedHotkey = settings.hotkey ?? DEFAULT_HOTKEY;
  const [hotkeyEnabled, setHotkeyEnabled] = useState(savedEnabled);
  const [hotkey, setHotkey] = useState(savedHotkey);
  const savedEscToClose = settings.escToClose ?? false;
  const [escToClose, setEscToClose] = useState(savedEscToClose);
  // ログイン時に起動するかは settings.json ではなく macOS 側の登録（~/Library/LaunchAgents）を正とする。
  // 開くたびにそこから読み、保存したときに変わっていれば登録し直す
  const [savedLaunchAtLogin, setSavedLaunchAtLogin] = useState(false);
  const [launchAtLogin, setLaunchAtLogin] = useState(false);

  useEffect(() => {
    if (!visible) return;
    isAutostartEnabled()
      .then((enabled) => {
        setSavedLaunchAtLogin(enabled);
        setLaunchAtLogin(enabled);
      })
      .catch((err) => console.error('Failed to read launch-at-login:', err));
  }, [visible]);

  useEffect(() => {
    if (visible) {
      setBaseDir(settings.baseDir);
      setPublishCommand(settings.publishCommand ?? '');
      setHotkeyEnabled(savedEnabled);
      setHotkey(savedHotkey);
      setEscToClose(savedEscToClose);
    }
  }, [visible, settings.baseDir, settings.publishCommand, savedEnabled, savedHotkey, savedEscToClose]);

  const handleBrowse = useCallback(async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: '保存先フォルダを選択',
    });
    if (selected) {
      setBaseDir(selected);
    }
  }, []);

  if (!visible) return null;

  const handleSave = () => {
    const trimmed = baseDir.trim();
    if (!trimmed) return;
    const trimmedPublish = publishCommand.trim();
    onSave({ ...settings, baseDir: trimmed, publishCommand: trimmedPublish || undefined, hotkeyEnabled, hotkey, escToClose });
    if (launchAtLogin !== savedLaunchAtLogin) {
      (launchAtLogin ? enableAutostart() : disableAutostart()).catch((err) =>
        console.error('Failed to change launch-at-login:', err),
      );
    }
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      // App の Esc（環境設定でオンなら Sate ごと隠す）に渡さない。閉じた直後に App のキー処理が「何も開いていない」と見て隠してしまう
      e.stopPropagation();
      onClose();
    }
  };

  return (
    <div className="settings-overlay">
      <div
        className="settings-panel"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="settings-title">環境設定</div>

        <div className="settings-field">
          <label className="settings-label">保存先ディレクトリ</label>
          <div className="settings-dir-row">
            <div className="settings-dir-display">{baseDir}</div>
            <button
              className="settings-btn settings-btn-browse"
              onClick={handleBrowse}
            >
              変更…
            </button>
          </div>
          <div className="settings-hint">
            ファイルの保存・読み込みのベースディレクトリ
          </div>
        </div>

        <div className="settings-field">
          <label className="settings-label">起動と開閉</label>
          <label className="settings-check">
            <input
              type="checkbox"
              checked={launchAtLogin}
              onChange={(e) => setLaunchAtLogin(e.target.checked)}
            />
            ログイン時に起動する
          </label>
          <label className="settings-check">
            <input
              type="checkbox"
              checked={hotkeyEnabled}
              onChange={(e) => setHotkeyEnabled(e.target.checked)}
            />
            ホットキーで Sate を開閉する
          </label>
          <ShortcutRecorder
            value={hotkey}
            active={savedEnabled ? savedHotkey : null}
            defaultValue={DEFAULT_HOTKEY}
            disabled={!hotkeyEnabled}
            onChange={setHotkey}
          />
          <label className="settings-check settings-check-after-field">
            <input
              type="checkbox"
              checked={escToClose}
              onChange={(e) => setEscToClose(e.target.checked)}
            />
            Esc キーでも閉じる
          </label>
        </div>

        <div className="settings-field">
          <label className="settings-label">公開コマンド</label>
          <input
            type="text"
            className="settings-input"
            value={publishCommand}
            onChange={(e) => setPublishCommand(e.target.value)}
            placeholder="例: ~/text-site/publish.sh"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
          />
          <div className="settings-hint">
            「公開」で実行するシェルコマンド。公開用 md のパスを $SATE_FILE、ファイル名を $SATE_SLUG、
            タイトルを $SATE_TITLE で受け取る。空欄なら公開機能は無効。
          </div>
        </div>

        <div className="settings-actions">
          <button className="settings-btn settings-btn-cancel" onClick={onClose}>
            キャンセル
          </button>
          <button className="settings-btn settings-btn-save" onClick={handleSave}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
