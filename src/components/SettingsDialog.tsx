import { useState, useEffect, useCallback } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { disable as disableAutostart, enable as enableAutostart, isEnabled as isAutostartEnabled } from '@tauri-apps/plugin-autostart';
import { invoke } from '@tauri-apps/api/core';
import type { Settings } from '../hooks/useSettings';
import { DEFAULT_HOTKEY } from '../lib/shortcut';
import { hashPin, isValidPin, PIN_LENGTH, PIN_SET_MARK, sanitizePinInput } from '../lib/pin';
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
  // Private な文章の PIN。PIN は「確定」（または「保存」）で決まる。ロックアウトを防ぐため、今の PIN を知らなくても変えられる
  const savedPrivateLock = settings.privateLock ?? false;
  const savedPrivateBiometrics = settings.privateBiometrics ?? true;
  const [privateLock, setPrivateLock] = useState(savedPrivateLock);
  const [privateBiometrics, setPrivateBiometrics] = useState(savedPrivateBiometrics);
  const [pinInput, setPinInput] = useState('');
  const [pinMessage, setPinMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [biometricAvailable, setBiometricAvailable] = useState(true);
  const hasPin = !!settings.privatePin;

  useEffect(() => {
    if (!visible) return;
    isAutostartEnabled()
      .then((enabled) => {
        setSavedLaunchAtLogin(enabled);
        setLaunchAtLogin(enabled);
      })
      .catch((err) => console.error('Failed to read launch-at-login:', err));
    invoke<boolean>('biometric_available')
      .then(setBiometricAvailable)
      .catch(() => setBiometricAvailable(false));
  }, [visible]);

  useEffect(() => {
    if (visible) {
      setBaseDir(settings.baseDir);
      setPublishCommand(settings.publishCommand ?? '');
      setHotkeyEnabled(savedEnabled);
      setHotkey(savedHotkey);
      setEscToClose(savedEscToClose);
      setPrivateLock(savedPrivateLock);
      setPrivateBiometrics(savedPrivateBiometrics);
      setPinInput('');
      setPinMessage(null);
    }
  }, [visible, settings.baseDir, settings.publishCommand, savedEnabled, savedHotkey, savedEscToClose, savedPrivateLock, savedPrivateBiometrics]);

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

  /** 入力欄の PIN をハッシュにする。正しくなければ知らせて null */
  const takePinInput = async () => {
    if (!isValidPin(pinInput)) {
      setPinMessage({ text: `PIN は ${PIN_LENGTH} 桁の数字にしてください`, error: true });
      return null;
    }
    return hashPin(pinInput);
  };

  // 「確定」はその場で PIN だけを保存する（ほかの欄は「保存」まで決めない）。
  // 欄が空に戻って丸が並ぶ（placeholder）ので、設定できたことは言葉で言わない
  const handleConfirmPin = async () => {
    const privatePin = await takePinInput();
    if (!privatePin) return;
    onSave({ ...settings, privatePin });
    setPinInput('');
    setPinMessage(null);
  };

  const handleSave = async () => {
    const trimmed = baseDir.trim();
    if (!trimmed) return;
    // 「確定」を押さずに「保存」したときも、入力欄の PIN を使う
    let privatePin = settings.privatePin;
    if (privateLock && pinInput) {
      privatePin = await takePinInput() ?? undefined;
      if (!privatePin) return;
    }
    if (privateLock && !privatePin) {
      setPinMessage({ text: 'PIN を決めてください', error: true });
      return;
    }
    const trimmedPublish = publishCommand.trim();
    onSave({
      ...settings,
      baseDir: trimmed,
      publishCommand: trimmedPublish || undefined,
      hotkeyEnabled,
      hotkey,
      escToClose,
      privateLock,
      privatePin,
      privateBiometrics,
    });
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
          <label className="settings-label">Private</label>
          <div className="settings-hint settings-hint-lead">
            文章の右上から Private をオンにすると、文章一覧で書き出しが現れず、検索にもヒットしなくなります。
          </div>
          <label className="settings-check">
            <input
              type="checkbox"
              checked={privateLock}
              onChange={(e) => setPrivateLock(e.target.checked)}
            />
            Private な文章を開くときに PIN コードを要求する
          </label>
          <div className="settings-pin-row">
            <input
              type="password"
              className="settings-input settings-pin"
              value={pinInput}
              maxLength={PIN_LENGTH}
              inputMode="numeric"
              onChange={(e) => {
                setPinInput(sanitizePinInput(e.target.value));
                setPinMessage(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  handleConfirmPin();
                }
              }}
              // PIN が決まっていれば丸を並べる。決まっていなければ空
              placeholder={hasPin ? PIN_SET_MARK : ''}
              disabled={!privateLock}
              autoComplete="off"
              spellCheck={false}
            />
            <button
              className="settings-btn settings-btn-browse"
              onClick={handleConfirmPin}
              disabled={!privateLock || !isValidPin(pinInput)}
            >
              確定
            </button>
          </div>
          {pinMessage && (
            <div className={`settings-hint${pinMessage.error ? ' settings-error' : ''}`}>{pinMessage.text}</div>
          )}
          <label className={`settings-check settings-check-after-field${privateLock ? '' : ' disabled'}`}>
            <input
              type="checkbox"
              checked={privateBiometrics}
              disabled={!privateLock}
              onChange={(e) => setPrivateBiometrics(e.target.checked)}
            />
            生体認証が可能な場合は使用する
          </label>
          {privateLock && privateBiometrics && !biometricAvailable && (
            <div className="settings-hint">いまは生体認証を使えないので、PIN で開きます</div>
          )}
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
