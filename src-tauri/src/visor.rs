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

use std::sync::Mutex;
use std::time::Duration;

use objc2_app_kit::{NSAnimatablePropertyContainer, NSAnimationContext};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_nspanel::{tauri_panel, CollectionBehavior, ManagerExt, PanelHandle, PanelLevel, StyleMask, WebviewWindowExt};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

pub const LABEL: &str = "visor";
const MAIN: &str = "main";

/// 表示するときのフェードインの長さ（秒）
const FADE_IN_SECONDS: f64 = 0.2;
/// メイン画面がバトンを手放さないとき、バイザーを出すのをあきらめるまでの時間
const SHOW_TIMEOUT: Duration = Duration::from_secs(1);
/// バイザーがバトンを手放さないとき、待たずに隠すまでの時間（隠せないと画面がふさがったままになる）
const HIDE_TIMEOUT: Duration = Duration::from_secs(2);

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
    Ok(())
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
        // メイン画面が閉じられている。保存は閉じるときに済んでいる
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
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Ok(panel) = handle.get_webview_panel(LABEL) else {
            return;
        };
        if showing {
            let _ = handle.emit_to(LABEL, "baton-acquire", baton);
            cover_cursor_screen(&handle);
            fade_in(&panel);
        } else {
            panel.hide();
            let _ = handle.emit_to(MAIN, "baton-acquire", baton);
        }
    });
}

/// 手放す側が保存を確定させて保存を止めたら呼ぶ（`baton-release` への返事）。
/// メイン画面を閉じるときにも呼び、次に開いたメイン画面がそのファイルを開けるようにする。
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

/// 画面の JS が受け渡しのイベントを聞けるようになったら呼ぶ。
/// この画面がバトンを持っていれば最後に受け渡したバトンを返し、持っていなければ `None`。
/// バイザーが出ているときにメイン画面が作られた（Dock から開き直した）なら、バイザーを隠して渡す。
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

/// 透明な状態で前面に出してから、不透明度をアニメーションで 1 に戻す
fn fade_in(panel: &PanelHandle<tauri::Wry>) {
    let window: &objc2_app_kit::NSWindow = panel.as_panel();
    window.setAlphaValue(0.0);
    panel.show_and_make_key();
    NSAnimationContext::beginGrouping();
    NSAnimationContext::currentContext().setDuration(FADE_IN_SECONDS);
    window.animator().setAlphaValue(1.0);
    NSAnimationContext::endGrouping();
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
