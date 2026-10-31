//! Dive: Sate の画面。ふだんは隠れていて、ホットキー・起動・Dock・`Cmd+Tab` で画面全体に重ねて出す（spec/dive.md）。
//!
//! どのアプリを使っていても（そのアプリが全画面でも）その上に出せるよう、ウィンドウを NSPanel に変換して
//! fullScreenAuxiliary + canJoinAllSpaces にし、メニューバーと Dock より上（Status レベル）に置く（tauri-nspanel）。
//! 出すときは Sate を前面にし、隠すときは前に使っていたアプリを前面に戻す。
//! パネルの AppKit API はメインスレッド専用なので、ホットキーや通知からは `run_on_main_thread` 経由で触る。
//!
//! 出入りの演出（背後をぼかしてから塗りつぶす）は画面の JS が動かす（src/lib/diveTransition.ts）。
//! ここではパネルを出すのと、演出が終わってから画面から外すのを受け持つ。ぼかしは macOS の非公開 API
//! （`CGSSetWindowBackgroundBlurRadius`。iTerm2 の背景ぼかしと同じ）で、透明なパネルの背後にかける。
//! 非公開 API は起動後に探し、見つからなければぼかさずに出し入れする（`blur_api`）。

use std::ffi::{c_char, c_void};
use std::ptr::NonNull;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use block2::RcBlock;
use objc2_app_kit::{
    NSApplication, NSApplicationActivationOptions, NSApplicationDidBecomeActiveNotification, NSRunningApplication,
    NSWorkspace, NSWorkspaceDidActivateApplicationNotification,
};
use objc2_foundation::{NSNotificationCenter, NSNotificationName};
use tauri::{AppHandle, Emitter, Manager};
use tauri_nspanel::{tauri_panel, CollectionBehavior, ManagerExt, PanelLevel, StyleMask, WebviewWindowExt};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// Sate の画面（tauri.conf.json のウィンドウ）
const LABEL: &str = "main";

/// 消える演出が終わったという知らせが来なくても、この時間が過ぎたら画面から外す（演出は 1 秒）
const EXIT_TIMEOUT: Duration = Duration::from_millis(1500);
/// 画面が描けたという知らせ（dive_ready）が来なくても、この時間が過ぎたら見せる
const READY_TIMEOUT: Duration = Duration::from_millis(300);

extern "C" {
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
}
/// `dlsym` で、読み込み済みのすべてのライブラリから探す（macOS の `RTLD_DEFAULT`）
const RTLD_DEFAULT: *mut c_void = -2isize as *mut c_void;

type MainConnectionId = unsafe extern "C" fn() -> i32;
type SetWindowBackgroundBlurRadius = unsafe extern "C" fn(connection: i32, window: u32, radius: i32) -> i32;

/// 背後をぼかす非公開 API（SkyLight を CoreGraphics が再公開している）。見つからなければ `None`。
/// リンク時に結び付けると、将来の macOS で消えたときに Sate が起動しなくなるので、起動後に探す
fn blur_api() -> Option<(MainConnectionId, SetWindowBackgroundBlurRadius)> {
    static API: OnceLock<Option<(MainConnectionId, SetWindowBackgroundBlurRadius)>> = OnceLock::new();
    *API.get_or_init(|| unsafe {
        let connection = dlsym(RTLD_DEFAULT, c"CGSMainConnectionID".as_ptr());
        let set_blur = dlsym(RTLD_DEFAULT, c"CGSSetWindowBackgroundBlurRadius".as_ptr());
        if connection.is_null() || set_blur.is_null() {
            eprintln!("dive: 背後をぼかす API が見つからないので、ぼかさずに出し入れする");
            return None;
        }
        Some((
            std::mem::transmute::<*mut c_void, MainConnectionId>(connection),
            std::mem::transmute::<*mut c_void, SetWindowBackgroundBlurRadius>(set_blur),
        ))
    })
}

tauri_panel! {
    panel!(DivePanel {
        config: {
            can_become_key_window: true,
            is_floating_panel: true
        }
    })
}

struct DiveState {
    /// 出ているか（消える演出の途中は、もう隠れている扱い）
    shown: bool,
    /// 出し入れの通し番号。演出の知らせやタイムアウトが、後の出し入れに効かないようにする
    seq: u64,
    /// いちばん最近まで前面だった、Sate 以外のアプリ（隠すときに前面へ戻す）
    previous_app: Option<i32>,
    /// 画面の JS が出し入れのイベントを聞けるようになったか（起動直後はまだ聞いていない）
    attached: bool,
    /// 聞けるようになったら出す（起動時）
    show_when_attached: bool,
    /// 前に使っていたアプリが分からないまま隠した。消える演出が終わったら Sate ごと隠し、macOS に前のアプリを前面にしてもらう
    hide_app_after_exit: bool,
}

/// パネルを作る。メインスレッドで呼ぶこと。ホットキーは `set_hotkey` で登録する。
pub fn setup(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    app.manage(Mutex::new(DiveState {
        shown: false,
        seq: 0,
        previous_app: other_front_app(),
        attached: false,
        // 起動したら出す
        show_when_attached: true,
        hide_app_after_exit: false,
    }));

    let window = app.get_webview_window(LABEL).ok_or("Sate の画面が見つからない")?;
    let panel = window.to_panel::<DivePanel>()?;
    // メニューバー（MainMenu）と Dock より上に出して、画面全体を覆う
    panel.set_level(PanelLevel::Status.value());
    // 前面にする前からキー入力を受けられるようにしておく。他アプリの全画面スペースの上に出すのにも要る
    panel.add_style_mask(StyleMask::empty().nonactivating_panel().into())?;
    panel.set_collection_behavior(
        CollectionBehavior::new()
            .full_screen_auxiliary()
            .can_join_all_spaces()
            .into(),
    );
    panel.set_hides_on_deactivate(false);

    let center = NSWorkspace::sharedWorkspace().notificationCenter();
    // ほかのアプリが前面に来たら（Cmd+Tab で選んだとき、Dock、別の画面のクリックなど）隠す。
    // 隠したときに前面へ戻せるよう、いちばん最近のアプリを覚えておく
    observe(&center, unsafe { NSWorkspaceDidActivateApplicationNotification }, app, |app| {
        let Some(pid) = other_front_app() else {
            return;
        };
        app.state::<Mutex<DiveState>>().lock().unwrap().previous_app = Some(pid);
        on_main_thread_later(app, hide);
    });
    // Sate が前面に来たら（Cmd+Tab、Dock のクリックなど）出す。出すときに自分で前面にしたぶんは、もう出ているので何もしない
    observe(
        &NSNotificationCenter::defaultCenter(),
        unsafe { NSApplicationDidBecomeActiveNotification },
        app,
        |app| on_main_thread_later(app, show),
    );
    Ok(())
}

fn observe(center: &NSNotificationCenter, name: &'static NSNotificationName, app: &AppHandle, handler: fn(&AppHandle)) {
    let handle = app.clone();
    let block = RcBlock::new(move |_: NonNull<objc2_foundation::NSNotification>| handler(&handle));
    // 通知センターは登録を保持する。アプリが終わるまで外さないので、戻り値は捨てる
    let _observer = unsafe { center.addObserverForName_object_queue_usingBlock(Some(name), None, None, &block) };
}

/// AppKit の通知の処理中に触らず、イベントループに戻ってから実行する
fn on_main_thread_later(app: &AppHandle, f: fn(&AppHandle)) {
    let handle = app.clone();
    std::thread::spawn(move || {
        let app = handle.clone();
        let _ = handle.run_on_main_thread(move || f(&app));
    });
}

/// 前面のアプリの pid。Sate なら `None`
fn other_front_app() -> Option<i32> {
    let pid = NSWorkspace::sharedWorkspace().frontmostApplication()?.processIdentifier();
    (pid != std::process::id() as i32).then_some(pid)
}

/// ホットキーを登録し直す。`None` なら外す（ホットキーを使わないとき、設定画面でキーを記録している間）。
///
/// ホットキーは設定（settings.json）にあるので、画面の JS が設定を読んだ時点でここを呼ぶ。
/// 書式は global-hotkey の文字列（"Alt+Space"、"Ctrl+Shift+KeyA" など）。
/// 同期コマンドはメインスレッドで動くので、そのまま登録してよい。
#[tauri::command]
pub fn set_hotkey(app: AppHandle, hotkey: Option<String>) -> Result<(), String> {
    let manager = app.global_shortcut();
    manager.unregister_all().map_err(|e| e.to_string())?;
    let Some(hotkey) = hotkey else {
        return Ok(());
    };
    let hotkey: Shortcut = hotkey.parse().map_err(|e| format!("{e}"))?;
    manager
        .on_shortcut(hotkey, |app, _, event| {
            if event.state == ShortcutState::Pressed {
                toggle(app);
            }
        })
        .map_err(|e| e.to_string())
}

fn toggle(app: &AppHandle) {
    let shown = app.state::<Mutex<DiveState>>().lock().unwrap().shown;
    if shown {
        hide(app);
    } else {
        show(app);
    }
}

/// 出す。消える演出の途中なら、その時点の見た目から出し直す
pub fn show(app: &AppHandle) {
    let mutex = app.state::<Mutex<DiveState>>();
    let mut state = mutex.lock().unwrap();
    if state.shown {
        return;
    }
    if !state.attached {
        // 画面の JS がまだ聞いていない（起動直後）。聞けるようになったら出す
        state.show_when_attached = true;
        return;
    }
    if let Some(pid) = other_front_app() {
        state.previous_app = Some(pid);
    }
    state.shown = true;
    state.seq += 1;
    let seq = state.seq;
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Ok(panel) = handle.get_webview_panel(LABEL) else {
            return;
        };
        let window: &objc2_app_kit::NSWindow = panel.as_panel();
        cover_cursor_screen(&handle);
        window.setIgnoresMouseEvents(false);
        // 隠れているあいだ（ほかのアプリを使っているときなど）WebKit は描くのを止めていて、出した最初の 1 コマが
        // 灰色になる。画面の JS が 1 コマ描いたと知らせてくる（dive_ready）まで透明にしておく
        window.setAlphaValue(0.0);
        // 消える演出の途中（パネルが出たまま）に出し直すと、キーにしても WebKit がキー入力を受け取れるようにならない。
        // いったん画面から外してから出す（透明にしてあるので、一瞬消えて見えるだけ）
        if window.isVisible() {
            window.orderOut(None);
        }
        panel.show_and_make_key();
        if let Some(mtm) = objc2::MainThreadMarker::new() {
            NSApplication::sharedApplication(mtm).activate();
        }
        let _ = handle.emit_to(LABEL, "dive-enter", seq);
        // 描けたという知らせが来なかったときの保険
        let app = handle.clone();
        std::thread::spawn(move || {
            std::thread::sleep(READY_TIMEOUT);
            reveal(&app, seq);
        });
    });
}

/// 隠す。消える演出のあいだも、クリックとキー入力はすぐ前のアプリへ返す
pub fn hide(app: &AppHandle) {
    let mutex = app.state::<Mutex<DiveState>>();
    let mut state = mutex.lock().unwrap();
    if !state.shown {
        return;
    }
    state.shown = false;
    state.seq += 1;
    let seq = state.seq;
    // 前のアプリが分からない（起動したときにはもう Sate が前面だった、終了したなど）なら、消える演出が終わってから Sate ごと隠す
    let previous = state.previous_app.and_then(NSRunningApplication::runningApplicationWithProcessIdentifier);
    state.hide_app_after_exit = previous.is_none();
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Ok(panel) = handle.get_webview_panel(LABEL) else {
            return;
        };
        let window: &objc2_app_kit::NSWindow = panel.as_panel();
        window.setIgnoresMouseEvents(true);
        let _ = handle.emit_to(LABEL, "dive-exit", seq);
        if let Some(previous) = previous {
            previous.activateWithOptions(NSApplicationActivationOptions::empty());
        }
        // 演出が終わったという知らせ（dive_exit_done）が来なかったときの保険
        let app = handle.clone();
        std::thread::spawn(move || {
            std::thread::sleep(EXIT_TIMEOUT);
            remove_after_exit(&app, seq);
        });
    });
}

/// 画面の JS が出し入れのイベントを聞けるようになったら呼ぶ（起動時。聞き始める前に送ったイベントは届かない）
#[tauri::command]
pub fn dive_attach(app: AppHandle) {
    let show_now = {
        let mutex = app.state::<Mutex<DiveState>>();
        let mut state = mutex.lock().unwrap();
        state.attached = true;
        std::mem::take(&mut state.show_when_attached)
    };
    if show_now {
        show(&app);
    }
}

/// 出したパネルを画面の JS が 1 コマ描いたら呼ぶ（`dive-enter` への返事）。透明にしていたパネルを見せる
#[tauri::command]
pub fn dive_ready(app: AppHandle, seq: u64) {
    reveal(&app, seq);
}

fn reveal(app: &AppHandle, seq: u64) {
    {
        let mutex = app.state::<Mutex<DiveState>>();
        let state = mutex.lock().unwrap();
        // そのあと出し入れした（隠した、出し直した）なら、そちらに任せる
        if state.seq != seq || !state.shown {
            return;
        }
    }
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Ok(panel) = handle.get_webview_panel(LABEL) {
            let window: &objc2_app_kit::NSWindow = panel.as_panel();
            window.setAlphaValue(1.0);
        }
    });
}

/// 消える演出が終わったら呼ぶ（`dive-exit` への返事）。そのあと出し直していなければ、パネルを画面から外す
#[tauri::command]
pub fn dive_exit_done(app: AppHandle, seq: u64) {
    remove_after_exit(&app, seq);
}

fn remove_after_exit(app: &AppHandle, seq: u64) {
    let hide_app = {
        let mutex = app.state::<Mutex<DiveState>>();
        let mut state = mutex.lock().unwrap();
        // 演出の途中で出し直したなら外さない
        if state.seq != seq || state.shown {
            return;
        }
        std::mem::take(&mut state.hide_app_after_exit)
    };
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Ok(panel) = handle.get_webview_panel(LABEL) {
            panel.hide();
        }
        if hide_app {
            if let Some(mtm) = objc2::MainThreadMarker::new() {
                NSApplication::sharedApplication(mtm).hide(None);
            }
        }
    });
}

/// 背後の画面のぼかしの強さを変える（出入りの演出で毎コマ呼ばれる）。0 でぼかさない
#[tauri::command]
pub fn set_dive_blur(app: AppHandle, radius: i32) {
    let (Some((connection, set_blur)), Ok(panel)) = (blur_api(), app.get_webview_panel(LABEL)) else {
        return;
    };
    let window: &objc2_app_kit::NSWindow = panel.as_panel();
    unsafe {
        set_blur(connection(), window.windowNumber() as u32, radius);
    }
}

/// マウスカーソルのある画面全体を覆うように配置する
fn cover_cursor_screen(app: &AppHandle) {
    let Some(window) = app.get_webview_window(LABEL) else {
        return;
    };
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return;
    };
    let _ = window.set_size(*monitor.size());
    let _ = window.set_position(*monitor.position());
}

/// 隠す（`Esc`、`Cmd+W`）
#[tauri::command]
pub fn hide_dive(app: AppHandle) {
    hide(&app);
}
