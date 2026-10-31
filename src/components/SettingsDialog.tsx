import { useState, useEffect, useCallback } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import type { Settings } from '../hooks/useSettings';
import { DEFAULT_VISOR_SHORTCUT } from '../lib/shortcut';
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
  const activeShortcut = settings.visorShortcut ?? DEFAULT_VISOR_SHORTCUT;
  const [visorShortcut, setVisorShortcut] = useState(activeShortcut);

  useEffect(() => {
    if (visible) {
      setBaseDir(settings.baseDir);
      setPublishCommand(settings.publishCommand ?? '');
      setVisorShortcut(activeShortcut);
    }
  }, [visible, settings.baseDir, settings.publishCommand, activeShortcut]);

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
    onSave({ ...settings, baseDir: trimmed, publishCommand: trimmedPublish || undefined, visorShortcut });
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

        <div className="settings-field">
          <label className="settings-label">バイザーのホットキー</label>
          <ShortcutRecorder value={visorShortcut} active={activeShortcut} onChange={setVisorShortcut} />
          <div className="settings-hint">
            クリックしてから、設定したいキーの組み合わせを押す。どのアプリを使っていても、このキーでバイザーを開閉する。
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
