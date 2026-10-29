//! Water Desktop：Tauri 壳。
//! 启动时拉起 water-server（sidecar 简化版：复用系统 node 跑 server 构建产物）。
//! 生产硬化路线（Node SEA 单文件 sidecar、端口协商）见 docs/articles/06。

use std::process::{Child, Command};
use std::sync::Mutex;

/// 管理 sidecar 子进程，窗口关闭时清理
struct ServerChild(Mutex<Option<Child>>);

fn spawn_server() -> Option<Child> {
    // 仓库布局：apps/desktop/src-tauri/../../server/dist/index.js
    let entry = concat!(env!("CARGO_MANIFEST_DIR"), "/../..", "/server/dist/index.js");
    if !std::path::Path::new(entry).exists() {
        eprintln!("[water] server 产物不存在: {entry}（先 npm run build）");
        return None;
    }

    let mut cmd = Command::new("node");
    cmd.arg(entry)
        // Agent 的工作区 = 桌面端启动目录的上级（仓库根），生产版应弹目录选择器
        .current_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/../../.."));
    // 没有凭据时降级 mock，保证桌面端开箱可玩
    if std::env::var("ZHIPU_API_KEY").is_err() {
        cmd.env("WATER_MOCK", "1");
    }
    // 固定端口，与 vite.config 的代理约定一致
    cmd.env("WATER_PORT", "3210");

    match cmd.spawn() {
        Ok(c) => {
            println!("[water] server sidecar 已启动 pid={}", c.id());
            Some(c)
        }
        Err(e) => {
            eprintln!("[water] server 启动失败: {e}");
            None
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            app.manage(ServerChild(Mutex::new(spawn_server())));
            Ok(())
        })
        .on_window_event(|window, event| {
            // 窗口关闭 → 杀 sidecar，不留孤儿进程
            if let tauri::WindowEvent::Destroyed = event {
                let state = window.state::<ServerChild>();
                if let Some(mut child) = state.0.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
