//! Private な文章を開くときの生体認証（Touch ID）。spec/private.md
//!
//! LocalAuthentication の LAContext で指紋を確かめる。確かめているあいだは macOS のダイアログが出る。
//! PIN で開けたときや Sate を隠したときは、画面の JS が `biometric_cancel` で出ているダイアログを取り消す。
//! 頼みごとには画面の JS が番号を付ける（増える一方）。取り消しが確かめ始めるより先に届いても、
//! その番号までは確かめずに "cancel" を返す。

use std::sync::mpsc;
use std::sync::Mutex;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::Bool;
use objc2_foundation::{NSError, NSString};
use objc2_local_authentication::{LAContext, LAError, LAPolicy};
use tauri::{AppHandle, Manager, State};

/// 指紋だけで確かめる（Mac のログインパスワードには回さない。代わりは Sate の PIN）
const POLICY: LAPolicy = LAPolicy::DeviceOwnerAuthenticationWithBiometrics;

#[derive(Default)]
pub struct BiometricState(Mutex<Inner>);

#[derive(Default)]
struct Inner {
    /// 確かめている途中の LAContext と、その頼みごとの番号
    current: Option<(u64, Context)>,
    /// この番号までの頼みごとは取り消されている
    cancelled: u64,
}

/// LAContext は objc2 では Send になっていないが、取り消し（invalidate）はどのスレッドから呼んでもよい
struct Context(Retained<LAContext>);
unsafe impl Send for Context {}

/// 生体認証が使えるか（Touch ID が無い、指紋の登録が無い、失敗が続いてロックされているときは使えない）
#[tauri::command]
pub fn biometric_available() -> bool {
    let context = unsafe { LAContext::new() };
    unsafe { context.canEvaluatePolicy_error(POLICY) }.is_ok()
}

/// 指紋で確かめる。返すのは
/// - "ok": 確かめられた
/// - "cancel": 取り消された（ダイアログのキャンセル、`biometric_cancel`、ほかの操作に割り込まれた）
/// - "fallback": ダイアログの「PIN を入力」を押した
/// - "unavailable": 生体認証が使えない（Touch ID が無い、登録が無い、失敗が続いてロックされた）
/// - "failed": それ以外で確かめられなかった
#[tauri::command]
pub async fn biometric_unlock(app: AppHandle, id: u64, reason: String) -> Result<&'static str, String> {
    let (tx, rx) = mpsc::channel::<&'static str>();
    let handle = app.clone();
    // ダイアログを出すので、メインスレッドで始める
    app.run_on_main_thread(move || {
        let state = handle.state::<BiometricState>();
        let mut inner = state.0.lock().unwrap();
        if id <= inner.cancelled {
            let _ = tx.send("cancel");
            return;
        }
        let context = unsafe { LAContext::new() };
        if unsafe { context.canEvaluatePolicy_error(POLICY) }.is_err() {
            let _ = tx.send("unavailable");
            return;
        }
        // 前の頼みごとのダイアログが残っていれば閉じる
        if let Some((_, previous)) = inner.current.take() {
            unsafe { previous.0.invalidate() };
        }
        inner.current = Some((id, Context(context.clone())));
        drop(inner);
        unsafe {
            // 指紋が合わなかったあとに出るボタン。押すと "fallback" になり、画面の PIN 欄に戻る
            context.setLocalizedFallbackTitle(Some(&NSString::from_str("PIN を入力")));
        }
        let reply = RcBlock::new(move |success: Bool, error: *mut NSError| {
            let _ = tx.send(if success.as_bool() { "ok" } else { classify(error) });
        });
        unsafe { context.evaluatePolicy_localizedReason_reply(POLICY, &NSString::from_str(&reason), &reply) };
    })
    .map_err(|e| e.to_string())?;
    let result = tauri::async_runtime::spawn_blocking(move || rx.recv().unwrap_or("failed"))
        .await
        .map_err(|e| e.to_string())?;
    let state = app.state::<BiometricState>();
    let mut inner = state.0.lock().unwrap();
    if inner.current.as_ref().is_some_and(|(current, _)| *current == id) {
        inner.current = None;
    }
    Ok(result)
}

/// `biometric_unlock` の頼みごとを取り消す。ダイアログが出ていれば閉じる
#[tauri::command]
pub fn biometric_cancel(state: State<'_, BiometricState>, id: u64) {
    let mut inner = state.0.lock().unwrap();
    inner.cancelled = inner.cancelled.max(id);
    if inner.current.as_ref().is_some_and(|(current, _)| *current <= id) {
        if let Some((_, context)) = inner.current.take() {
            unsafe { context.0.invalidate() };
        }
    }
}

fn classify(error: *mut NSError) -> &'static str {
    let Some(error) = (unsafe { error.as_ref() }) else {
        return "failed";
    };
    match LAError(error.code()) {
        LAError::UserCancel | LAError::SystemCancel | LAError::AppCancel => "cancel",
        LAError::UserFallback => "fallback",
        LAError::BiometryNotAvailable
        | LAError::BiometryNotEnrolled
        | LAError::BiometryLockout
        | LAError::PasscodeNotSet => "unavailable",
        _ => "failed",
    }
}
