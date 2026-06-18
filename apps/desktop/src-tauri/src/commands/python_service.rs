use crate::error::{AppError, CommandResult};
use crate::AppState;
use serde::Serialize;
use tauri::State;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

/// Python backend process handle (kept alive by Tauri state)
pub struct PythonProcess(pub Mutex<Option<Child>>);

#[derive(Debug, Serialize)]
pub struct PythonBackendStatus {
    pub running: bool,
    pub url: String,
    pub port: u16,
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

    // Find the python-backend directory relative to the app
    // In development, this is in the monorepo
    let backend_dir = std::env::current_dir()
        .unwrap_or_default()
        .join("..")
        .join("..")
        .join("services")
        .join("python-backend");

    // Kill existing process if any
    {
        let mut proc = py_state.0.lock().unwrap();
        if let Some(ref mut child) = *proc {
            let _ = child.kill();
            let _ = child.wait();
        }

        // Spawn new Python backend process using uv run
        let child = Command::new("uv")
            .args([
                "run",
                "--directory",
                backend_dir.to_str().unwrap_or("."),
                "knowledge-backend",
            ])
            .env("KNOWLEDGE_BASE_DATA_DIR", app_data_dir.to_str().unwrap_or("."))
            .env("KNOWLEDGE_BACKEND_PORT", port.to_string())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| AppError::PythonBackend(format!("Failed to start Python backend: {}", e)))?;

        *proc = Some(child);
    }

    // Wait for health check
    let url = format!("http://127.0.0.1:{}/api/v1/health", port);
    let client = reqwest::Client::new();

    for _ in 0..30 {
        tokio::time::sleep(Duration::from_millis(500)).await;
        if let Ok(resp) = client.get(&url).send().await {
            if resp.status().is_success() {
                return Ok(PythonBackendStatus {
                    running: true,
                    url: format!("http://127.0.0.1:{}", port),
                    port,
                });
            }
        }
    }

    Err(AppError::PythonBackend("Python backend failed to start within timeout".to_string()))
}

#[tauri::command]
pub async fn stop_python_backend(
    py_state: State<'_, PythonProcess>,
) -> CommandResult<()> {
    let mut proc = py_state.0.lock().unwrap();
    if let Some(ref mut child) = *proc {
        child.kill().ok();
        child.wait().ok();
    }
    *proc = None;
    Ok(())
}

#[tauri::command]
pub async fn get_python_backend_status(
    state: State<'_, AppState>,
    py_state: State<'_, PythonProcess>,
) -> CommandResult<PythonBackendStatus> {
    let port = *state.python_port.lock().unwrap();
    let url = format!("http://127.0.0.1:{}", port);

    let proc = py_state.0.lock().unwrap();
    let running = proc.is_some();

    // Actually check health
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
    })
}
