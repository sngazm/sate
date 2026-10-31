//! メインウィンドウの「閉じる」（Cmd+W）。ウィンドウは壊さずに、画面から外して Sate ごと隠す。
//!
//! - ウィンドウを壊すと、作り直すたびに閉じたウィンドウが macOS 側に残る（tao が解放しない）うえ、
//!   取り消し履歴も消える
//! - 全画面のままウィンドウだけを隠すと、空の全画面スペース（真っ黒な画面）が残る。
//!   アプリごと隠しても、Mission Control に空の全画面スペースが残る
//! - アプリを隠すだけだと、バイザーを出したときに macOS がアプリの隠れた状態を解き、
//!   メインウィンドウもデスクトップに戻ってしまう
//!
//! そこで全画面を解除し終わってから（`NSWindowDidExitFullScreenNotification`）、メインウィンドウを
//! 画面から外してアプリを隠す。次に Sate が前面に来たとき（Dock・Cmd+Tab。
//! `NSApplicationDidBecomeActiveNotification`）にメインウィンドウを出し、全画面へ戻す。
//! バイザーはアプリを前面に出さない（nonactivating）ので、バイザーの出し入れでは戻らない。
//! tao は解除を頼んだ時点で全画面ではない扱いにするので、解除の終わりは AppKit の通知で知る。
//! 解除のあいだはウィンドウを透明にして、枠付きのウィンドウを見せない。戻すときは見えるように
//! してから全画面にする（macOS 標準の、ウィンドウが広がるアニメーションになる）。

use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use block2::RcBlock;
use objc2_app_kit::{NSApplicationDidBecomeActiveNotification, NSWindow, NSWindowDidExitFullScreenNotification};
use objc2_foundation::{NSNotification, NSNotificationCenter, NSNotificationName};
use tauri::{AppHandle, Manager, Window};

const MAIN: &str = "main";
/// 全画面の解除が終わったという知らせが来なくても、この時間が過ぎたら隠す
const EXIT_TIMEOUT: Duration = Duration::from_secs(2);

/// 全画面の解除が終わったら、メインウィンドウを外してアプリを隠す
static HIDE_AFTER_EXIT: AtomicBool = AtomicBool::new(false);
/// メインウィンドウを Cmd+W で外している。次に Sate が前面に来たら出す
static CLOSED: AtomicBool = AtomicBool::new(false);
/// 次にメインウィンドウが前に出たら、全画面に戻す
static RESTORE_FULLSCREEN: AtomicBool = AtomicBool::new(false);

pub fn setup(app: &AppHandle) {
    // 通知名は AppKit の定数（読むだけ）
    let (did_exit, did_become_active) =
        unsafe { (NSWindowDidExitFullScreenNotification, NSApplicationDidBecomeActiveNotification) };
    // バイザーのパネルは全画面にならないので、どのウィンドウの知らせでもメインウィンドウのもの
    observe(did_exit, app, |app| {
        if HIDE_AFTER_EXIT.swap(false, Ordering::SeqCst) {
            on_main_thread_later(app, hide_now);
        }
    });
    observe(did_become_active, app, |app| {
        if CLOSED.swap(false, Ordering::SeqCst) {
            on_main_thread_later(app, |app| {
                if let Some(window) = app.get_webview_window(MAIN) {
                    // フォーカスを得ると on_focused で全画面に戻る
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            });
        }
    });
}

fn observe(name: &'static NSNotificationName, app: &AppHandle, handler: fn(&AppHandle)) {
    let handle = app.clone();
    let block = RcBlock::new(move |_: NonNull<NSNotification>| handler(&handle));
    // 通知センターは登録を保持する。アプリが終わるまで外さないので、戻り値は捨てる
    let _observer = unsafe {
        NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
            Some(name),
            None,
            None,
            &block,
        )
    };
}

/// AppKit の通知の処理中に触らず、イベントループに戻ってから実行する
fn on_main_thread_later(app: &AppHandle, f: fn(&AppHandle)) {
    let handle = app.clone();
    std::thread::spawn(move || {
        let app = handle.clone();
        let _ = handle.run_on_main_thread(move || f(&app));
    });
}

/// メインウィンドウを画面から外して、アプリを隠す
fn hide_now(app: &AppHandle) {
    CLOSED.store(true, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.hide();
    }
    let _ = app.hide();
}

/// メインウィンドウの不透明度を変える。メインスレッドで呼ぶこと
fn set_alpha(window: &Window, alpha: f64) {
    let Ok(ptr) = window.ns_window() else {
        return;
    };
    let ns_window = unsafe { &*(ptr as *const NSWindow) };
    ns_window.setAlphaValue(alpha);
}

/// メインウィンドウを閉じる代わりに、全画面を解除してから画面から外し、Sate ごと隠す（App.tsx の Cmd+W）
#[tauri::command]
pub fn hide_main_window(app: AppHandle, window: Window) {
    if !window.is_fullscreen().unwrap_or(false) {
        hide_now(&app);
        return;
    }
    RESTORE_FULLSCREEN.store(true, Ordering::SeqCst);
    HIDE_AFTER_EXIT.store(true, Ordering::SeqCst);
    // 透明なまま隠し、次に前に出たとき（on_focused）に見えるようにする
    set_alpha(&window, 0.0);
    let _ = window.set_fullscreen(false);
    // 解除が終わったという知らせが来なかったときの保険
    std::thread::spawn(move || {
        std::thread::sleep(EXIT_TIMEOUT);
        if HIDE_AFTER_EXIT.swap(false, Ordering::SeqCst) {
            eprintln!("main_window: 全画面の解除が終わらないまま隠す");
            on_main_thread_later(&app, hide_now);
        }
    });
}

/// メインウィンドウが前に出た（フォーカスを得た）とき。隠す前に全画面だったなら、見えるようにしてから全画面に戻す
pub fn on_focused(window: &Window) {
    if window.label() != MAIN || !RESTORE_FULLSCREEN.swap(false, Ordering::SeqCst) {
        return;
    }
    set_alpha(window, 1.0);
    let _ = window.set_fullscreen(true);
}

/// Dock アイコンのクリック。外していたメインウィンドウは前面に来たとき（setup の通知）に出すので、
/// ここでは何かの理由で無くなっていたときだけ作り直す
pub fn reopen(app: &AppHandle) {
    if app.get_webview_window(MAIN).is_some() {
        return;
    }
    if let Some(config) = app.config().app.windows.first() {
        let _ = tauri::WebviewWindowBuilder::from_config(app, config).and_then(|builder| builder.build());
    }
}
