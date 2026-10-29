//! Water Desktop：Tauri 壳。
//! sidecar：优先打包内嵌的 SEA 单文件（water-server-<triple>.exe，无需系统 node），
//! 开发期回退到 dist-sea 产物，最后才用系统 node 跑 dist。
//! 详见 docs/articles/06。

use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::Manager;

/// 管理 sidecar 子进程，窗口关闭时清理
struct ServerChild(Mutex<Option<Child>>);

const SIDE_CAR_NAME: &str = "water-server-x86_64-pc-windows-msvc.exe";

fn sidecar_candidates(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut v = Vec::new();
    // 1) 打包形态：资源目录里的 externalBin
    if let Ok(res) = app.path().resource_dir() {
        v.push(res.join("binaries").join(SIDE_CAR_NAME));
        v.push(res.join(SIDE_CAR_NAME));
    }
    // 2) 开发形态：仓库内的 dist-sea 产物（apps/desktop/src-tauri → apps/server/dist-sea）
    v.push(PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../server/dist-sea/water-server.exe"
    )));
    v
}

fn spawn_server(app: &tauri::AppHandle) -> Option<Child> {
    // 找 SEA 单文件 sidecar
    for cand in sidecar_candidates(app) {
        if cand.exists() {
            let mut cmd = Command::new(&cand);
            cmd.current_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/../../.."))
                .env("WATER_PORT", "3210");
            if std::env::var("ZHIPU_API_KEY").is_err() {
                cmd.env("WATER_MOCK", "1");
            }
            return match cmd.spawn() {
                Ok(c) => {
                    println!("[water] sidecar(SEA) 已启动 pid={} {:?}", c.id(), cand);
                    Some(c)
                }
                Err(e) => {
                    eprintln!("[water] sidecar 启动失败 {cand:?}: {e}");
                    None
                }
            };
        }
    }

    // 回退：系统 node + 构建产物（开发早期路径）
    let entry = concat!(env!("CARGO_MANIFEST_DIR"), "/../..", "/server/dist/index.js");
    if !std::path::Path::new(entry).exists() {
        eprintln!("[water] server 产物不存在: {entry}（先 npm run build 或 scripts/build-sea.ps1）");
        return None;
    }
    let mut cmd = Command::new("node");
    cmd.arg(entry)
        .current_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/../../.."))
        .env("WATER_PORT", "3210");
    if std::env::var("ZHIPU_API_KEY").is_err() {
        cmd.env("WATER_MOCK", "1");
    }
    match cmd.spawn() {
        Ok(c) => {
            println!("[water] sidecar(node) 已启动 pid={}", c.id());
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
            let child = spawn_server(app.handle());
            app.manage(ServerChild(Mutex::new(child)));
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
