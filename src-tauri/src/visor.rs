//! バイザーモード: グローバルホットキーで、画面全体にエディタを重ねて出す（iTerm2 のホットキーウィンドウ風）。
//!
//! 他アプリのフルスクリーン Space の上にも出せるよう、ウィンドウを NSPanel に変換して
//! nonactivating + fullScreenAuxiliary + canJoinAllSpaces にする（tauri-nspanel）。
//! パネルの AppKit API はメインスレッド専用なので、ホットキーやコマンドからは
//! `run_on_main_thread` 経由で触る。
//!
//! メイン画面とバイザーは同じファイルを開く。両方がオートセーブすると、古い内容で
//! もう一方の編集を上書きしてしまう。そこで保存してよいのは「バトン」を持っている画面だけにし、
//! バイザーを出すときはメイン画面から、隠すときはバイザーからバトンを受け取る:
//!
//! 1. 手放す側に `baton-release` を送る
//! 2. 手放す側は保留中の保存を確定させ、保存を止めてから `release_baton` を呼ぶ
//!    （開いているファイル名とキャレット位置を渡す。中身は src/lib/baton.ts）
//! 3. パネルを出す（隠す）。受け取る側に `baton-acquire` を送り、受け取った側はファイルを読み直す
//!
//! 出入りの演出（背後をぼかしてから塗りつぶす）は画面の JS が動かす（src/lib/visorTransition.ts）。
//! ここではパネルを出すのと、演出が終わってから画面から外すのを受け持つ。ぼかしは macOS の非公開 API
//! （`CGSSetWindowBackgroundBlurRadius`。iTerm2 の背景ぼかしと同じ）で、透明なパネルの背後にかける。
//! 非公開 API は起動後に探し、見つからなければぼかさずに出し入れする（`blur_api`）。

use std::ffi::{c_char, c_void};
use std::ptr::NonNull;
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use block2::RcBlock;
use objc2_app_kit::{NSWorkspace, NSWorkspaceDidActivateApplicationNotification};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_nspanel::{tauri_panel, CollectionBehavior, ManagerExt, PanelLevel, StyleMask, WebviewWindowExt};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

pub const LABEL: &str = "visor";
const MAIN: &str = "main";

/// 消える演出が終わったという知らせが来なくても、この時間が過ぎたら画面から外す（演出は 1 秒）
const EXIT_TIMEOUT: Duration = Duration::from_millis(1500);
/// 画面が描けたという知らせ（visor_ready）が来なくても、この時間が過ぎたら見せる
const READY_TIMEOUT: Duration = Duration::from_millis(300);
/// メイン画面がバトンを手放さないとき、バイザーを出すのをあきらめるまでの時間
const SHOW_TIMEOUT: Duration = Duration::from_secs(1);
/// バイザーがバトンを手放さないとき、待たずに隠すまでの時間（隠せないと画面がふさがったままになる）
const HIDE_TIMEOUT: Duration = Duration::from_secs(2);

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
            eprintln!("visor: 背後をぼかす API が見つからないので、ぼかさずに出し入れする");
            return None;
        }
        Some((
            std::mem::transmute::<*mut c_void, MainConnectionId>(connection),
            std::mem::transmute::<*mut c_void, SetWindowBackgroundBlurRadius>(set_blur),
        ))
    })
}

tauri_panel! {
    panel!(VisorPanel {
        config: {
            can_become_key_window: true,
            is_floating_panel: true
        }
    })
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    /// バイザーは隠れている
    Hidden,
    /// メイン画面がバトンを手放すのを待っている
    Showing,
    /// バイザーが出ている
    Shown,
    /// バイザーがバトンを手放すのを待っている
    Hiding,
}

impl Phase {
    /// バトンを持っている画面。手放すのを待っている間は、まだ手放す側が持っている
    fn holder(self) -> &'static str {
        match self {
            Phase::Hidden | Phase::Showing => MAIN,
            Phase::Shown | Phase::Hiding => LABEL,
        }
    }
}

struct VisorState {
    phase: Phase,
    /// 最後に受け渡したバトン（`{ file, anchor, head }`）
    last: Value,
    /// 受け渡しの通し番号。タイムアウトが後の受け渡しに効かないようにする
    seq: u64,
}

/// バイザー用パネルを作る。メインスレッドで呼ぶこと。ホットキーは `set_visor_shortcut` で登録する。
pub fn setup(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    // 比較検証用: Dock に出さない Accessory モードで起動する
    if std::env::var_os("SATE_VISOR_ACCESSORY").is_some() {
        app.set_activation_policy(tauri::ActivationPolicy::Accessory)?;
    }

    app.manage(Mutex::new(VisorState {
        phase: Phase::Hidden,
        last: json!({ "file": null }),
        seq: 0,
    }));

    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::default())
        .title("Sate Visor")
        .decorations(false)
        .resizable(false)
        .visible(false)
        // 背後の画面を透かしてぼかす。塗りつぶしは画面の CSS が受け持つ
        .transparent(true)
        .build()?;

    let panel = window.to_panel::<VisorPanel>()?;
    // メニューバー（MainMenu）と Dock より上に出して、画面全体を覆う
    panel.set_level(PanelLevel::Status.value());
    // アプリをアクティブにせずにキー入力を受ける。これが無いと他アプリのフルスクリーン上に出せない
    panel.add_style_mask(StyleMask::empty().nonactivating_panel().into())?;
    panel.set_collection_behavior(
        CollectionBehavior::new()
            .full_screen_auxiliary()
            .can_join_all_spaces()
            .into(),
    );
    panel.set_hides_on_deactivate(false);
    hide_on_app_switch(app);
    Ok(())
}

/// ほかのアプリが前面に来たら（`Cmd+Tab`、Dock、別の画面のクリックなど）バイザーを隠す。
/// バイザーは Sate を前面にしないので、そのままだと切り替えた先のアプリの上に残ってしまう
fn hide_on_app_switch(app: &AppHandle) {
    let handle = app.clone();
    let block = RcBlock::new(move |_: NonNull<objc2_foundation::NSNotification>| {
        // AppKit の通知の処理中に触らず、イベントループに戻ってから隠す
        crate::main_window::on_main_thread_later(&handle, |app| hide_visor(app.clone()));
    });
    // 通知名は AppKit の定数（読むだけ）。通知センターは登録を保持し、アプリが終わるまで外さないので戻り値は捨てる
    let _observer = unsafe {
        NSWorkspace::sharedWorkspace().notificationCenter().addObserverForName_object_queue_usingBlock(
            Some(NSWorkspaceDidActivateApplicationNotification),
            None,
            None,
            &block,
        )
    };
}

/// バイザーのホットキーを登録し直す。`None` なら外す（設定画面でキーを記録している間）。
///
/// ホットキーは設定（settings.json）にあるので、メイン画面が設定を読んだ時点でここを呼ぶ。
/// 書式は global-hotkey の文字列（"Cmd+F12"、"Ctrl+Shift+KeyA" など）。
/// 同期コマンドはメインスレッドで動くので、そのまま登録してよい。
#[tauri::command]
pub fn set_visor_shortcut(app: AppHandle, shortcut: Option<String>) -> Result<(), String> {
    let manager = app.global_shortcut();
    manager.unregister_all().map_err(|e| e.to_string())?;
    let Some(shortcut) = shortcut else {
        return Ok(());
    };
    let shortcut: Shortcut = shortcut.parse().map_err(|e| format!("{e}"))?;
    manager
        .on_shortcut(shortcut, |app, _, event| {
            if event.state == ShortcutState::Pressed {
                toggle(app);
            }
        })
        .map_err(|e| e.to_string())
}

fn toggle(app: &AppHandle) {
    let mutex = app.state::<Mutex<VisorState>>();
    let mut state = mutex.lock().unwrap();
    match state.phase {
        Phase::Hidden => begin(app, &mut state, Phase::Showing),
        Phase::Shown => begin(app, &mut state, Phase::Hiding),
        // 受け渡しの途中。終わるまで次の操作は受けない
        Phase::Showing | Phase::Hiding => {}
    }
}

/// バトンの受け渡しを始める。`next` は `Showing` か `Hiding`
fn begin(app: &AppHandle, state: &mut VisorState, next: Phase) {
    let from = state.phase.holder();
    state.phase = next;
    state.seq += 1;
    if app.get_webview_window(from).is_none() {
        // メイン画面が無い（Cmd+W でも壊さないので普通は起きない）。最後に受け渡したバトンを渡す
        let baton = state.last.clone();
        finish(app, state, baton);
        return;
    }
    let _ = app.emit_to(from, "baton-release", ());

    let (app, seq) = (app.clone(), state.seq);
    std::thread::spawn(move || {
        std::thread::sleep(if next == Phase::Showing { SHOW_TIMEOUT } else { HIDE_TIMEOUT });
        let mutex = app.state::<Mutex<VisorState>>();
        let mut state = mutex.lock().unwrap();
        if state.seq != seq || state.phase != next {
            return;
        }
        if next == Phase::Showing {
            // 保存を確定できたかわからないので、バイザーは出さない。
            // メイン画面が遅れて手放していても、このあとで受け取り直すよう送っておく
            eprintln!("visor: メイン画面がバトンを手放さないので、バイザーを出すのをやめる");
            state.phase = Phase::Hidden;
            let _ = app.emit_to(MAIN, "baton-acquire", json!({ "file": null }));
        } else {
            eprintln!("visor: バイザーがバトンを手放さないまま隠す");
            let baton = state.last.clone();
            finish(&app, &mut state, baton);
        }
    });
}

/// パネルを出して（隠して）、受け取る側にバトンを渡す
fn finish(app: &AppHandle, state: &mut VisorState, baton: Value) {
    let showing = state.phase == Phase::Showing;
    state.phase = if showing { Phase::Shown } else { Phase::Hidden };
    let seq = state.seq;
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Ok(panel) = handle.get_webview_panel(LABEL) else {
            return;
        };
        let window: &objc2_app_kit::NSWindow = panel.as_panel();
        if showing {
            let _ = handle.emit_to(LABEL, "baton-acquire", baton);
            cover_cursor_screen(&handle);
            window.setIgnoresMouseEvents(false);
            // 隠れているあいだ（ほかのアプリを使っているときなど）WebKit は描くのを止めていて、出した最初の 1 コマが
            // 灰色になる。画面の JS が 1 コマ描いたと知らせてくる（visor_ready）まで透明にしておく
            window.setAlphaValue(0.0);
            // 消える演出の途中（パネルが出たまま）だと、キーにしてもキー入力を受け取れない
            // （Sate を前面にしないパネルは、画面に出るときにだけキー入力を受け取る）。いったん外してから出し直す。
            // 出し直すまでの一瞬は背後の画面がそのまま見えるが、入力できないよりよい
            let reorder = window.isVisible();
            if reorder {
                window.orderOut(None);
            }
            panel.show_and_make_key();
            if reorder {
                // 画面から外すと macOS 側のぼかしが消えるので、画面の JS を待たずにすぐ戻す
                apply_blur(window, BLUR_RADIUS.load(Ordering::SeqCst));
            }
            let _ = handle.emit_to(LABEL, "visor-enter", seq);
            // 描けたという知らせが来なかったときの保険
            let app = handle.clone();
            std::thread::spawn(move || {
                std::thread::sleep(READY_TIMEOUT);
                reveal(&app, seq);
            });
        } else {
            // 消える演出のあいだも、クリックとキー入力はすぐ元のアプリへ返す
            window.setIgnoresMouseEvents(true);
            return_keyboard(&handle);
            let _ = handle.emit_to(LABEL, "visor-exit", seq);
            let _ = handle.emit_to(MAIN, "baton-acquire", baton);
            // 演出が終わったという知らせ（visor_exit_done）が来なかったときの保険
            let app = handle.clone();
            std::thread::spawn(move || {
                std::thread::sleep(EXIT_TIMEOUT);
                remove_after_exit(&app, seq);
            });
        }
    });
}

/// キー入力を、バイザーの下で使っていたアプリへ返す（パネルは演出のため出したまま）。メインスレッドで呼ぶこと。
/// バイザーは Sate を前面にしないので、前面のアプリは下で使っていたアプリのまま。Sate がキー入力を手放すと
/// そちらへ戻る。下にあったのが Sate のメイン画面なら、メイン画面をキーにする。
/// （パネルをいったん画面から外しても戻るが、出し直すまで WebKit が画面の中身を描かず、演出が途切れる）
fn return_keyboard(app: &AppHandle) {
    let other_app_front = objc2_app_kit::NSWorkspace::sharedWorkspace()
        .frontmostApplication()
        .is_some_and(|a| a.processIdentifier() != std::process::id() as i32);
    if other_app_front {
        if let Some(mtm) = objc2::MainThreadMarker::new() {
            objc2_app_kit::NSApplication::sharedApplication(mtm).deactivate();
        }
        return;
    }
    if let Some(main) = app.get_webview_window(MAIN) {
        if main.is_visible().unwrap_or(false) {
            let _ = main.set_focus();
        }
    }
}

/// 出したパネルを画面の JS が 1 コマ描いたら呼ぶ（`visor-enter` への返事）。透明にしていたパネルを見せる
#[tauri::command]
pub fn visor_ready(app: AppHandle, seq: u64) {
    reveal(&app, seq);
}

fn reveal(app: &AppHandle, seq: u64) {
    {
        let mutex = app.state::<Mutex<VisorState>>();
        let state = mutex.lock().unwrap();
        // そのあと受け渡しが進んだ（隠した、出し直した）なら、そちらに任せる
        if state.seq != seq || state.phase != Phase::Shown {
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

/// 消える演出が終わったら呼ぶ（`visor-exit` への返事）。そのあと出し直していなければ、パネルを画面から外す
#[tauri::command]
pub fn visor_exit_done(app: AppHandle, seq: u64) {
    remove_after_exit(&app, seq);
}

fn remove_after_exit(app: &AppHandle, seq: u64) {
    {
        let mutex = app.state::<Mutex<VisorState>>();
        let state = mutex.lock().unwrap();
        // 演出の途中で出し直した（受け渡しが進んだ）なら外さない
        if state.seq != seq || state.phase != Phase::Hidden {
            return;
        }
    }
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Ok(panel) = handle.get_webview_panel(LABEL) {
            panel.hide();
        }
    });
}

/// いまのぼかしの半径（パネルを出し直したときにかけ直す）
static BLUR_RADIUS: AtomicI32 = AtomicI32::new(0);

/// 背後の画面のぼかしの強さを変える（出入りの演出で毎コマ呼ばれる）。0 でぼかさない
#[tauri::command]
pub fn set_visor_blur(app: AppHandle, radius: i32) {
    BLUR_RADIUS.store(radius, Ordering::SeqCst);
    if let Ok(panel) = app.get_webview_panel(LABEL) {
        apply_blur(panel.as_panel(), radius);
    }
}

fn apply_blur(window: &objc2_app_kit::NSWindow, radius: i32) {
    let Some((connection, set_blur)) = blur_api() else {
        return;
    };
    unsafe {
        set_blur(connection(), window.windowNumber() as u32, radius);
    }
}

/// 手放す側が保存を確定させて保存を止めたら呼ぶ（`baton-release` への返事）。
#[tauri::command]
pub fn release_baton(app: AppHandle, window: WebviewWindow, baton: Value) {
    let mutex = app.state::<Mutex<VisorState>>();
    let mut state = mutex.lock().unwrap();
    // バトンを持っていない画面からの返事（受け渡しを打ち切ったあとに届いたものなど）は無視する
    if state.phase.holder() != window.label() {
        return;
    }
    state.last = baton.clone();
    if matches!(state.phase, Phase::Showing | Phase::Hiding) {
        finish(&app, &mut state, baton);
    }
}

/// 画面の JS が受け渡しのイベントを聞けるようになったら呼ぶ（起動時。聞き始める前に送られたイベントは届かない）。
/// この画面がバトンを持っていれば最後に受け渡したバトンを返し、持っていなければ `None`。
/// バイザーが出ているときにメイン画面が作られた（無くなったメイン画面を作り直した）なら、バイザーを隠して渡す。
#[tauri::command]
pub fn baton_ready(app: AppHandle, window: WebviewWindow) -> Option<Value> {
    let mutex = app.state::<Mutex<VisorState>>();
    let mut state = mutex.lock().unwrap();
    if window.label() == MAIN && state.phase == Phase::Shown {
        begin(&app, &mut state, Phase::Hiding);
        return None;
    }
    (state.phase.holder() == window.label()).then(|| state.last.clone())
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

/// バイザーを隠す（バイザーでの `Esc`、メイン画面がフォーカスを得たとき）
#[tauri::command]
pub fn hide_visor(app: AppHandle) {
    let mutex = app.state::<Mutex<VisorState>>();
    let mut state = mutex.lock().unwrap();
    if state.phase == Phase::Shown {
        begin(&app, &mut state, Phase::Hiding);
    }
}
