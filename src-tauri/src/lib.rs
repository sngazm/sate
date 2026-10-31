use std::process::Command;
use tauri::Manager;

#[cfg(target_os = "macos")]
mod main_window;
#[cfg(target_os = "macos")]
mod visor;

/// ユーザーが設定した公開コマンドを実行する。
///
/// Sate 側は「公開用 md を一時ファイルに書き出してコマンドに渡す」までを担い、
/// 書き出した md をどこへ届けるか（git push、rsync など）はコマンド側に任せる。
/// コマンドには環境変数で以下を渡す。
/// - `SATE_FILE`: 公開用 md の一時ファイルパス（実行後に削除される）
/// - `SATE_SLUG`: ファイル名から `.md` を除いたもの
/// - `SATE_TITLE`: タイトル（無ければ空文字）
///
/// GUI から起動したアプリは PATH が最小限なので、ログインシェル（`$SHELL -lc`）で実行して
/// git や Homebrew のコマンド、ssh-agent をユーザーのシェルと同じように使えるようにする。
/// 指定したファイルを Finder で表示する（`open -R`）。
#[tauri::command]
fn reveal_in_finder(path: String) -> Result<(), String> {
    let status = std::process::Command::new("open")
        .arg("-R")
        .arg(&path)
        .status()
        .map_err(|e| format!("Finder の起動に失敗: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("Finder で表示できませんでした: {path}"))
    }
}

#[tauri::command]
async fn run_publish_command(
    command: String,
    slug: String,
    title: String,
    content: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = std::env::temp_dir().join("sate-publish");
        std::fs::create_dir_all(&dir).map_err(|e| format!("一時ディレクトリの作成に失敗: {e}"))?;
        let file = dir.join(format!("{slug}.md"));
        std::fs::write(&file, &content).map_err(|e| format!("一時ファイルの書き出しに失敗: {e}"))?;

        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let mut cmd = Command::new(&shell);
        cmd.arg("-lc")
            .arg(&command)
            .env("SATE_FILE", &file)
            .env("SATE_SLUG", &slug)
            .env("SATE_TITLE", &title);
        if let Some(home) = std::env::var_os("HOME") {
            cmd.current_dir(home);
        }
        let result = cmd.output();
        let _ = std::fs::remove_file(&file);

        let out = result.map_err(|e| format!("コマンドを実行できませんでした（{shell}）: {e}"))?;
        let log = format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        )
        .trim()
        .to_string();
        if out.status.success() {
            Ok(log)
        } else {
            let code = out
                .status
                .code()
                .map_or("シグナルで終了".to_string(), |c| format!("終了コード {c}"));
            Err(if log.is_empty() { code } else { format!("{code}\n\n{log}") })
        }
    })
    .await
    .map_err(|e| format!("コマンド実行スレッドの異常終了: {e}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_sql::Builder::default().build());
    #[cfg(target_os = "macos")]
    let builder = builder
        .plugin(tauri_nspanel::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build());
    builder
        .invoke_handler(tauri::generate_handler![
            run_publish_command,
            reveal_in_finder,
            #[cfg(target_os = "macos")]
            visor::hide_visor,
            #[cfg(target_os = "macos")]
            visor::set_visor_shortcut,
            #[cfg(target_os = "macos")]
            visor::release_baton,
            #[cfg(target_os = "macos")]
            visor::baton_ready,
            #[cfg(target_os = "macos")]
            main_window::hide_main_window
        ])
        .on_window_event(|window, event| {
            #[cfg(target_os = "macos")]
            if let tauri::WindowEvent::Focused(true) = event {
                main_window::on_focused(window);
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (window, event);
        })
        .setup(|app| {
            // Get the main window and set fullscreen
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_fullscreen(true);
            }
            #[cfg(target_os = "macos")]
            visor::setup(app.handle())?;
            #[cfg(target_os = "macos")]
            main_window::setup(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                main_window::reopen(app);
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}
