import { useState, useEffect, useCallback } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
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

  useEffect(() => {
    if (visible) {
      setBaseDir(settings.baseDir);
      setPublishCommand(settings.publishCommand ?? '');
      setHotkeyEnabled(savedEnabled);
      setHotkey(savedHotkey);
    }
  }, [visible, settings.baseDir, settings.publishCommand, savedEnabled, savedHotkey]);

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
    onSave({ ...settings, baseDir: trimmed, publishCommand: trimmedPublish || undefined, hotkeyEnabled, hotkey });
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
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
          <label className="settings-label">ホットキー</label>
          <label className="settings-check">
            <input
              type="checkbox"
              checked={hotkeyEnabled}
              onChange={(e) => setHotkeyEnabled(e.target.checked)}
            />
            どのアプリを使っていても、ホットキーで Sate を開閉する
          </label>
          <ShortcutRecorder
            value={hotkey}
            active={savedEnabled ? savedHotkey : null}
            defaultValue={DEFAULT_HOTKEY}
            disabled={!hotkeyEnabled}
            onChange={setHotkey}
          />
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
