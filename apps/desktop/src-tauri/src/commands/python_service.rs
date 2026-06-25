use crate::error::{AppError, CommandResult};
use crate::AppState;
use serde::Serialize;
use tauri::State;
use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// Python backend process handle
pub struct PythonProcess(pub Mutex<Option<Child>>);

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

fn kill_backend_processes() {
    // Kill the known backend exe (production)
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/IM", "knowledge-backend.exe"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = std::process::Command::new("pkill")
            .args(["-9", "-f", "knowledge-backend"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
    }
}

/// Force-kill a child process tree. On Windows uses taskkill /F /T /PID.
fn kill_process_tree(child: &mut std::process::Child) {
    let pid = child.id();
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = std::process::Command::new("kill")
            .args(["-9", &format!("-{}", pid)])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
    }
    let _ = child.wait();
}

/// Kill any process holding the given port (Windows only via netstat)
fn kill_process_on_port(port: u16) {
    #[cfg(target_os = "windows")]
    {
        if let Ok(output) = std::process::Command::new("netstat")
            .args(["-ano", "-p", "TCP"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
        {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                if line.contains(&format!(":{}", port)) && line.contains("LISTENING") {
                    let parts: Vec<&str> = line.split_whitespace().collect();
                    if let Some(pid) = parts.last() {
                        let _ = std::process::Command::new("taskkill")
                            .args(["/F", "/PID", pid])
                            .stdout(std::process::Stdio::null())
                            .stderr(std::process::Stdio::null())
                            .creation_flags(CREATE_NO_WINDOW)
                            .spawn();
                    }
                }
            }
        }
    }
}

impl Drop for PythonProcess {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.0.lock() {
            if let Some(ref mut child) = *guard {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        kill_backend_processes();
    }
}

/// Explicitly kill the Python backend (call from app cleanup)
pub fn force_kill_backend() {
    kill_backend_processes();
}

#[derive(Debug, Serialize)]
pub struct PythonBackendStatus {
    pub running: bool,
    pub url: String,
    pub port: u16,
    pub error: Option<String>,
}

/// Find the backend command: always use uv run in dev, sidecar exe in production
fn resolve_backend_command() -> (String, Vec<String>) {
    // Dev mode: CARGO_MANIFEST_DIR is set during `cargo run` / `tauri dev`
    let is_dev = std::env::var("CARGO_MANIFEST_DIR").is_ok();

    // Production: try bundled sidecar first
    if !is_dev {
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                for name in &[
                    "knowledge-backend.exe",
                    "knowledge-backend",
                    "knowledge-backend-x86_64-pc-windows-msvc.exe",
                    "knowledge-backend-aarch64-apple-darwin",
                    "knowledge-backend-x86_64-unknown-linux-gnu",
                ] {
                    let sidecar = dir.join(name);
                    if sidecar.exists() {
                        if let Ok(meta) = std::fs::metadata(&sidecar) {
                            if meta.len() > 1024 {
                                return (sidecar.to_string_lossy().to_string(), vec![]);
                            }
                        }
                    }
                }
            }
        }
    }

    // Dev mode (or fallback): use uv run from source tree
    let backend_dir: std::path::PathBuf =
        if let Ok(manifest) = std::env::var("CARGO_MANIFEST_DIR") {
            std::path::PathBuf::from(&manifest)
                .join("..").join("..").join("..")
                .join("services").join("python-backend")
        } else if let Ok(exe) = std::env::current_exe() {
            exe.parent().unwrap_or(std::path::Path::new("."))
                .parent().unwrap_or(std::path::Path::new("."))
                .parent().unwrap_or(std::path::Path::new("."))
                .join("services").join("python-backend")
        } else {
            std::path::PathBuf::from("services/python-backend")
        };

    (
        "uv".to_string(),
        vec![
            "run".to_string(),
            "--directory".to_string(),
            backend_dir.to_string_lossy().to_string(),
            "knowledge-backend".to_string(),
        ],
    )
}

#[tauri::command]
pub async fn get_python_backend_url(state: State<'_, AppState>) -> CommandResult<String> {
    let port = state.python_port.lock().unwrap();
    Ok(format!("http://127.0.0.1:{}", *port))
}

#[tauri::command]
pub async fn start_python_backend(
    state: State<'_, AppState>,
    py_state: State<'_, PythonProcess>,
) -> CommandResult<PythonBackendStatus> {
    let port = *state.python_port.lock().unwrap();
    let app_data_dir = state.file_store.root_dir().clone();
    let (cmd, args) = resolve_backend_command();

    // Kill existing process if any
    {
        let mut proc = py_state.0.lock().unwrap();
        if let Some(ref mut child) = *proc {
            let _ = child.kill();
            let _ = child.wait();
        }

        let mut child = Command::new(&cmd);
        child
            .args(&args)
            .env("KNOWLEDGE_BASE_DATA_DIR", app_data_dir.to_str().unwrap_or(""))
            .env("KNOWLEDGE_BACKEND_PORT", port.to_string())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(target_os = "windows")]
        {
            child.creation_flags(CREATE_NO_WINDOW);
        }

        let child = child.spawn().map_err(|e| {
            AppError::PythonBackend(format!(
                "Failed to start backend ({}): {}. In dev, run: uv sync",
                if args.is_empty() { "bundled" } else { "uv run" }, e
            ))
        })?;

        *proc = Some(child);
    }

    // Health check
    let url = format!("http://127.0.0.1:{}/api/v1/health", port);
    let client = reqwest::Client::new();

    for i in 0..120 {
        tokio::time::sleep(Duration::from_millis(500)).await;
        if let Ok(resp) = client.get(&url).send().await {
            if resp.status().is_success() {
                return Ok(PythonBackendStatus {
                    running: true,
                    url: format!("http://127.0.0.1:{}", port),
                    port,
                    error: None,
                });
            }
        }
        if i == 20 {
            let mut proc = py_state.0.lock().unwrap();
            if let Some(ref mut child) = *proc {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        let mut stderr = String::new();
                        if let Some(ref mut s) = child.stderr {
                            s.read_to_string(&mut stderr).ok();
                        }
                        return Ok(PythonBackendStatus {
                            running: false, url: format!("http://127.0.0.1:{}", port), port,
                            error: Some(format!("Backend exited early ({}).\n{}", status, stderr)),
                        });
                    }
                    _ => {}
                }
            }
        }
    }

    let mut err_msg = "Backend failed to start within 60s".to_string();
    {
        let mut proc = py_state.0.lock().unwrap();
        if let Some(ref mut child) = *proc {
            match child.try_wait() {
                Ok(Some(status)) => {
                    let mut stderr = String::new();
                    if let Some(ref mut s) = child.stderr {
                        s.read_to_string(&mut stderr).ok();
                    }
                    err_msg = format!("Backend exited with {}.\n{}", status, stderr);
                }
                _ => {}
            }
        }
    }

    Ok(PythonBackendStatus {
        running: false,
        url: format!("http://127.0.0.1:{}", port),
        port,
        error: Some(err_msg),
    })
}

#[tauri::command]
pub async fn stop_python_backend(
    state: State<'_, AppState>,
    py_state: State<'_, PythonProcess>,
) -> CommandResult<()> {
    let port = *state.python_port.lock().unwrap();
    let mut proc = py_state.0.lock().unwrap();
    if let Some(ref mut child) = *proc {
        kill_process_tree(child);
    }
    *proc = None;
    // Also kill anything still holding the port
    kill_process_on_port(port);
    kill_backend_processes();
    Ok(())
}

#[tauri::command]
pub async fn restart_python_backend(
    state: State<'_, AppState>,
    py_state: State<'_, PythonProcess>,
) -> CommandResult<PythonBackendStatus> {
    let port = *state.python_port.lock().unwrap();

    // Force-stop: kill process tree, kill port holder, kill known exe
    {
        let mut proc = py_state.0.lock().unwrap();
        if let Some(ref mut child) = *proc {
            kill_process_tree(child);
        }
        *proc = None;
    }
    kill_process_on_port(port);
    kill_backend_processes();

    // Wait for port to be free
    for _ in 0..20 {
        std::thread::sleep(Duration::from_millis(250));
        // Try to connect — if it fails, port is free
        if std::net::TcpStream::connect_timeout(
            &format!("127.0.0.1:{}", port).parse().unwrap(),
            Duration::from_millis(100),
        ).is_err() {
            break; // Port is free
        }
    }

    // Start a new one
    start_python_backend(state, py_state).await
}

#[tauri::command]
pub async fn get_python_backend_status(
    state: State<'_, AppState>,
    py_state: State<'_, PythonProcess>,
) -> CommandResult<PythonBackendStatus> {
    let port = *state.python_port.lock().unwrap();
    let url = format!("http://127.0.0.1:{}", port);

    let running = {
        let proc = py_state.0.lock().unwrap();
        proc.is_some()
    };

    let actually_running = if running {
        let client = reqwest::Client::new();
        if let Ok(resp) = client
            .get(format!("{}/api/v1/health", url))
            .timeout(Duration::from_secs(2))
            .send()
            .await
        {
            resp.status().is_success()
        } else {
            false
        }
    } else {
        false
    };

    Ok(PythonBackendStatus {
        running: actually_running,
        url,
        port,
        error: None,
    })
}
