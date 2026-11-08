import { useEffect, useRef, useState } from 'react';
import { FingerprintPattern, Lock } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { PIN_LENGTH, sanitizePinInput, verifyPin, type StoredPin } from '../lib/pin';
import './LockScreen.css';

interface LockScreenProps {
  pin: StoredPin;
  /** 環境設定の「生体認証が可能な場合は使用する」 */
  biometrics: boolean;
  /** Sate の画面が出ているか。出るたびに生体認証を求め、隠したら取り消す */
  active: boolean;
  /** PIN 欄。画面が出たときやダイアログを閉じたときに、App がここへフォーカスを戻す */
  inputRef: React.RefObject<HTMLInputElement | null>;
  onUnlock: () => void;
}

type BiometricResult = 'ok' | 'cancel' | 'fallback' | 'unavailable' | 'failed';

// 生体認証の頼みごとの番号（src-tauri/src/biometric.rs）。増える一方にするため、画面を読み直しても前より大きくなる時刻から始める
let nextBiometricId = Date.now();

/**
 * Private な文章を隠して、PIN か生体認証（Touch ID）で開けるまで待つ画面（spec/private.md）。
 * 本文は裏に残したまま見えなくしているだけで、開けたらそのまま続きを書ける。
 */
export default function LockScreen({ pin, biometrics, active, inputRef, onUnlock }: LockScreenProps) {
  const [value, setValue] = useState('');
  const [wrong, setWrong] = useState(false);
  const [biometricAvailable, setBiometricAvailable] = useState(true);
  // 「Touch ID」のボタンで頼み直した回数
  const [biometricRetry, setBiometricRetry] = useState(0);
  const checkSeqRef = useRef(0);
  // いま出している生体認証のダイアログの番号（出していなければ null）
  const biometricIdRef = useRef<number | null>(null);
  const onUnlockRef = useRef(onUnlock);
  useEffect(() => {
    onUnlockRef.current = onUnlock;
  }, [onUnlock]);

  // 画面が出ているあいだは生体認証を求める。開けた・隠した・ファイルを替えたときは、出ているダイアログを閉じる
  useEffect(() => {
    if (!biometrics || !active) return;
    const id = nextBiometricId++;
    let alive = true;
    biometricIdRef.current = id;
    invoke<BiometricResult>('biometric_unlock', { id, reason: 'Private な文章を表示' })
      .then((result) => {
        if (biometricIdRef.current === id) biometricIdRef.current = null;
        if (!alive) return;
        if (result === 'ok') onUnlockRef.current();
        else if (result === 'unavailable') setBiometricAvailable(false);
        else inputRef.current?.focus();
      })
      .catch(() => {
        // macOS 以外など、コマンドが無い
        if (alive) setBiometricAvailable(false);
      });
    return () => {
      alive = false;
      invoke('biometric_cancel', { id }).catch(() => {});
    };
  }, [biometrics, active, biometricRetry, inputRef]);

  // 4 桁そろったら確かめ、合えばそのまま開く（Enter は要らない）。違えば知らせて空にする
  const check = async (entered: string) => {
    const seq = ++checkSeqRef.current;
    if (entered.length < PIN_LENGTH) return;
    const ok = await verifyPin(entered, pin);
    if (seq !== checkSeqRef.current) return;
    if (ok) {
      onUnlockRef.current();
    } else {
      setWrong(true);
      setValue('');
    }
  };

  return (
    <div className="lock-screen">
      <div className="lock-screen-body">
        <Lock className="lock-screen-icon" size={20} strokeWidth={1.5} aria-label="Private" />
        <input
          ref={inputRef}
          type="password"
          className={`lock-screen-pin${wrong ? ' wrong' : ''}`}
          value={value}
          placeholder="PIN"
          maxLength={PIN_LENGTH}
          inputMode="numeric"
          autoFocus
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            const next = sanitizePinInput(e.target.value);
            setValue(next);
            setWrong(false);
            check(next);
          }}
          onKeyDown={(e) => {
            // 生体認証のダイアログが出ていても、キー入力はこの欄に来る（ダイアログはキーを取らない）。
            // Esc でダイアログを閉じる（環境設定で Esc で閉じるがオンなら、App が Sate ごと隠す）
            if (e.key === 'Escape' && biometricIdRef.current !== null) {
              invoke('biometric_cancel', { id: biometricIdRef.current }).catch(() => {});
            }
          }}
        />
        {biometrics && biometricAvailable && (
          <button
            type="button"
            className="lock-screen-biometric"
            onClick={() => setBiometricRetry((n) => n + 1)}
          >
            <FingerprintPattern size={14} strokeWidth={1.5} />
            Touch ID
          </button>
        )}
        <div className={`lock-screen-hint${wrong ? ' wrong' : ''}`}>
          {wrong ? 'PIN が違います' : 'PIN を忘れたら環境設定（⌘,）で変えられます'}
        </div>
      </div>
    </div>
  );
}
