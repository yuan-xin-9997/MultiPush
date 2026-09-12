#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{io::{BufRead, BufReader, Write}, process::{Child, ChildStdin, Command, Stdio}, sync::{Mutex, mpsc}, time::Duration};
use tauri::Manager;

struct Engine { child: Child, stdin: Option<ChildStdin>, responses: mpsc::Receiver<String> }
impl Engine {
    fn shutdown(&mut self) {
        // EOF lets Node close browser contexts and checkpoint SQLite before exiting.
        self.stdin.take();
        for _ in 0..50 {
            if matches!(self.child.try_wait(), Ok(Some(_))) { return; }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
impl Drop for Engine {
    fn drop(&mut self) { self.shutdown(); }
}

#[tauri::command]
async fn rpc(app: tauri::AppHandle, request: serde_json::Value) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<Engine>>();
        let mut engine = state.lock().map_err(|_| "发布引擎锁异常")?;
        let text = serde_json::to_string(&request).map_err(|e| e.to_string())?;
        if text.len() > 1_000_000 { return Err("请求超过1MB限制".into()); }
        let stdin = engine.stdin.as_mut().ok_or("发布引擎已关闭")?;
        writeln!(stdin, "{}", text).map_err(|_| "发布引擎已退出".to_string())?;
        stdin.flush().map_err(|e| e.to_string())?;
        let seconds = if request.get("method").and_then(|m| m.as_str()) == Some("task.saveDraft") { 150 } else { 45 };
        let line = match engine.responses.recv_timeout(Duration::from_secs(seconds)) {
            Ok(line) => line,
            Err(_) => { engine.shutdown(); return Err("发布引擎超时或已退出，请重启应用".into()); }
        };
        serde_json::from_str(&line).map_err(|e| e.to_string())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn pick_images(multiple: bool) -> Vec<String> {
    let dialog = rfd::AsyncFileDialog::new()
        .set_title("选择 PNG / JPEG 图片")
        .add_filter("图片", &["png", "jpg", "jpeg"]);
    if multiple {
        dialog
            .pick_files()
            .await
            .unwrap_or_default()
            .into_iter()
            .map(|file| file.path().to_string_lossy().into_owned())
            .collect()
    } else {
        dialog
            .pick_file()
            .await
            .into_iter()
            .map(|file| file.path().to_string_lossy().into_owned())
            .collect()
    }
}

#[tauri::command]
async fn choose_portable_archive_destination() -> Option<String> {
    rfd::AsyncFileDialog::new()
        .set_title("保存 TurboPush 便携归档")
        .set_file_name("turbopush-portable.turbopush.json")
        .add_filter("TurboPush 便携归档", &["json"])
        .save_file()
        .await
        .map(|file| file.path().to_string_lossy().into_owned())
}

#[tauri::command]
async fn pick_portable_archive() -> Option<String> {
    rfd::AsyncFileDialog::new()
        .set_title("选择 TurboPush 便携归档")
        .add_filter("TurboPush 便携归档", &["json"])
        .pick_file()
        .await
        .map(|file| file.path().to_string_lossy().into_owned())
}

fn main() {
    let mut context = tauri::generate_context!();
    #[cfg(debug_assertions)]
    if let Ok(port) = std::env::var("TURBOPUSH_TEST_CDP_PORT").unwrap_or_default().parse::<u16>() {
        if port > 1024 {
            context.config_mut().app.windows[0].additional_browser_args = Some(format!("--remote-debugging-address=127.0.0.1 --remote-debugging-port={port}"));
        }
    }
    tauri::Builder::default()
        .setup(|app| {
            // Development scaffold. Release packaging must embed Node and engine resources.
            let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
            let directory = std::env::var_os("TURBOPUSH_DATA_DIR").map(std::path::PathBuf::from)
                .unwrap_or(app.path().app_data_dir()?);
            std::fs::create_dir_all(&directory)?;
            let mut child = Command::new(std::env::var_os("TURBOPUSH_NODE").unwrap_or_else(|| "node".into()))
                .arg(root.join("packages/publisher-engine/dist/stdio.js"))
                .env("TURBOPUSH_DATA_DIR", &directory)
                .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn()?;
            let stdin = child.stdin.take().ok_or("无法打开引擎stdin")?;
            let stdout = BufReader::new(child.stdout.take().ok_or("无法打开引擎stdout")?);
            let (sender, responses) = mpsc::channel();
            std::thread::spawn(move || {
                for line in stdout.lines() {
                    match line { Ok(line) => { if sender.send(line).is_err() { break; } }, Err(_) => break }
                }
            });
            app.manage(Mutex::new(Engine { child, stdin: Some(stdin), responses }));
            #[cfg(debug_assertions)]
            eprintln!("Native setup complete: {} webviews", app.webview_windows().len());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![rpc, pick_images, choose_portable_archive_destination, pick_portable_archive])
        .build(context)
        .expect("桌面端启动失败")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app.try_state::<Mutex<Engine>>() {
                    if let Ok(mut engine) = state.lock() { engine.shutdown(); }
                }
            }
        });
}
