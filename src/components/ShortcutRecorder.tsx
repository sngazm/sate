import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { formatShortcut, isFunctionKey, shortcutFromKeyEvent } from '../lib/shortcut';

interface ShortcutRecorderProps {
  /** 設定画面で選んでいるホットキー（保存前） */
  value: string;
  /** いま登録されているホットキー（保存済み）。バイザーがオフなら null */
  active: string | null;
  /** 「デフォルトに戻す」で戻すホットキー */
  defaultValue: string;
  /** バイザーがオフのあいだは記録できない */
  disabled?: boolean;
  onChange: (shortcut: string) => void;
}

/** クリックしてからキーを押すと、そのキーの組み合わせをホットキーとして記録する */
export default function ShortcutRecorder({ value, active, defaultValue, disabled = false, onChange }: ShortcutRecorderProps) {
  const [recording, setRecording] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // 記録中は登録済みのホットキーを外しておく。登録したままだと、同じキーを押したときに
  // OS 側でバイザーが開閉してしまい、ここにキーが届かない。終わったら保存済みのものに戻す
  // （新しいキーが効くのは「保存」してから）。
  useEffect(() => {
    if (!recording) return;
    invoke('set_visor_shortcut', { shortcut: null }).catch(console.error);
    return () => {
      invoke('set_visor_shortcut', { shortcut: active }).catch(console.error);
    };
  }, [recording, active]);

  const handleKeyDown = async (e: React.KeyboardEvent) => {
    if (!recording) {
      if (!disabled && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        setRecording(true);
        setMessage(null);
      }
      return;
    }
    // 記録中のキーは、設定画面やメイン画面のショートカット（Esc で閉じる等）に渡さない
    e.preventDefault();
    e.stopPropagation();
    const plain = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
    if (plain && e.key === 'Escape') {
      setRecording(false);
      return;
    }
    const shortcut = shortcutFromKeyEvent(e.nativeEvent);
    if (!shortcut) return;
    if (plain && !isFunctionKey(e.code)) {
      setMessage('⌘ ⌥ ⌃ ⇧ のどれかと組み合わせてください');
      return;
    }
    // 試しに登録して、Rust 側で読めないキー（JIS の ¥ や かな など）や登録できないキーを弾く
    try {
      await invoke('set_visor_shortcut', { shortcut });
    } catch {
      setMessage(`${formatShortcut(shortcut)} はホットキーにできません`);
      return;
    }
    setMessage(null);
    onChange(shortcut);
    setRecording(false);
  };

  return (
    <>
      <div className="settings-dir-row">
        <div
          className={`settings-shortcut${recording ? ' recording' : ''}${disabled ? ' disabled' : ''}`}
          role="button"
          tabIndex={disabled ? -1 : 0}
          aria-disabled={disabled}
          onClick={() => {
            if (disabled) return;
            setRecording(true);
            setMessage(null);
          }}
          onKeyDown={handleKeyDown}
          onBlur={() => setRecording(false)}
        >
          {recording ? 'キーを押してください（Esc で取り消し）' : formatShortcut(value)}
        </div>
        <button
          className="settings-btn settings-btn-browse"
          disabled={disabled || value === defaultValue}
          onClick={() => {
            setMessage(null);
            onChange(defaultValue);
          }}
        >
          デフォルトに戻す
        </button>
      </div>
      {message && <div className="settings-hint settings-error">{message}</div>}
    </>
  );
}
