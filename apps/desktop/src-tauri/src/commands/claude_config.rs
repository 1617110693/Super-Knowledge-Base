use crate::error::{AppError, CommandResult};
use crate::AppState;
use serde::Serialize;
use std::path::PathBuf;
use tauri::State;

#[derive(Debug, Serialize)]
pub struct ConfigureResult {
    pub success: bool,
    pub path: String,
    pub message: String,
}

fn find_claude_config() -> Result<PathBuf, AppError> {
    // Priority: .claude.json in home dir (Claude Code's primary config)
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| AppError::Internal("Cannot find home directory".to_string()))?;
    let home = PathBuf::from(&home);

    // Check common Claude config locations
    let candidates = vec![
        home.join(".claude.json"),
        home.join(".claude").join("settings.json"),
    ];

    for path in &candidates {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
    }

    // Prefer .claude.json in home (Claude Code reads this)
    Ok(candidates[0].clone())
}

#[tauri::command]
pub async fn get_mcp_config_json(
    state: State<'_, AppState>,
) -> CommandResult<String> {
    let data_dir = state.file_store.root_dir().to_string_lossy().to_string();
    let is_dev = std::env::var("CARGO_MANIFEST_DIR").is_ok();

    // Production: check for bundled sidecar (only if not in dev mode)
    if !is_dev {
        if let Ok(current) = std::env::current_exe() {
            if let Some(dir) = current.parent() {
                for name in &[
                    "local-kb-mcp.exe",
                    "local-kb-mcp",
                    "local-kb-mcp-x86_64-pc-windows-msvc.exe",
                    "local-kb-mcp-aarch64-apple-darwin",
                    "local-kb-mcp-x86_64-unknown-linux-gnu",
                ] {
                    let sidecar = dir.join(name);
                    if sidecar.exists() {
                        if let Ok(meta) = std::fs::metadata(&sidecar) {
                            if meta.len() > 1024 {
                                let config = serde_json::json!({
                                    "mcpServers": {
                                        "local-knowledge-base": {
                                            "command": sidecar.to_string_lossy(),
                                            "env": {
                                                "KNOWLEDGE_BASE_DATA_DIR": &data_dir,
                                            }
                                        }
                                    }
                                });
                                return Ok(serde_json::to_string_pretty(&config).unwrap_or_default());
                            }
                        }
                    }
                }
            }
        }
    }

    // Dev mode: use uv run
    let mcp_dir = resolve_mcp_source_dir();
    let config = serde_json::json!({
        "mcpServers": {
            "local-knowledge-base": {
                "command": "uv",
                "args": ["run", "--directory", &mcp_dir.to_string_lossy(), "local-kb-mcp"],
                "env": {
                    "KNOWLEDGE_BASE_DATA_DIR": &data_dir,
                }
            }
        }
    });
    Ok(serde_json::to_string_pretty(&config).unwrap_or_default())
}

#[tauri::command]
pub async fn configure_claude_mcp(
    state: State<'_, AppState>,
) -> CommandResult<ConfigureResult> {
    let settings = state.settings.lock().unwrap().clone();

    let data_dir = state.file_store.root_dir().to_string_lossy().to_string();

    // Try to find the MCP server sidecar/script
    let is_dev = std::env::var("CARGO_MANIFEST_DIR").is_ok();
    let (command, args): (String, Vec<String>) = {
        // Production: check for bundled sidecar next to the exe
        if !is_dev {
            if let Ok(current) = std::env::current_exe() {
                if let Some(dir) = current.parent() {
                    for name in &[
                        "local-kb-mcp.exe",
                        "local-kb-mcp",
                        "local-kb-mcp-x86_64-pc-windows-msvc.exe",
                        "local-kb-mcp-aarch64-apple-darwin",
                        "local-kb-mcp-x86_64-unknown-linux-gnu",
                    ] {
                        let sidecar = dir.join(name);
                        if sidecar.exists() {
                            if let Ok(meta) = std::fs::metadata(&sidecar) {
                                if meta.len() > 1024 {
                                    return build_config(
                                        &sidecar.to_string_lossy(),
                                        &[],
                                        &data_dir,
                                        &settings,
                                    );
                                }
                            }
                        }
                    }
                }
            }
        }

        // Dev mode: use `uv run` from the backend source tree
        let mcp_dir = resolve_mcp_source_dir();
        ("uv".to_string(), vec![
            "run".to_string(),
            "--directory".to_string(),
            mcp_dir.to_string_lossy().to_string(),
            "local-kb-mcp".to_string(),
        ])
    };

    build_config(&command, &args, &data_dir, &settings)
}

fn resolve_mcp_source_dir() -> PathBuf {
    // MCP server is now part of the Python backend
    if let Ok(manifest) = std::env::var("CARGO_MANIFEST_DIR") {
        PathBuf::from(&manifest)
            .join("..").join("..").join("..")
            .join("services").join("python-backend")
    } else if let Ok(exe) = std::env::current_exe() {
        exe.parent().unwrap_or(std::path::Path::new("."))
            .parent().unwrap_or(std::path::Path::new("."))
            .parent().unwrap_or(std::path::Path::new("."))
            .join("services").join("python-backend")
    } else {
        PathBuf::from("services/python-backend")
    }
}

fn build_config(
    command: &str,
    args: &[String],
    data_dir: &str,
    _settings: &crate::models::settings::AppSettings,
) -> CommandResult<ConfigureResult> {
    let mut entry = serde_json::json!({
        "command": command,
        "env": {
            "KNOWLEDGE_BASE_DATA_DIR": data_dir,
        }
    });
    if !args.is_empty() {
        entry["args"] = serde_json::to_value(args).unwrap();
    }

    let mcp_config = serde_json::json!({
        "local-knowledge-base": entry
    });

    // Load existing config or create new
    let config_path = find_claude_config()?;
    let config_path_str = config_path.to_string_lossy().to_string();

    let mut existing: serde_json::Value = if config_path.exists() {
        let content = std::fs::read_to_string(&config_path)
            .map_err(|e| AppError::Io(e.to_string()))?;
        serde_json::from_str(&content).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    // Merge or create mcpServers
    if existing.get("mcpServers").is_none() {
        existing["mcpServers"] = serde_json::json!({});
    }
    existing["mcpServers"]["local-knowledge-base"] = mcp_config["local-knowledge-base"].clone();

    // Write back
    let content = serde_json::to_string_pretty(&existing)
        .map_err(|e| AppError::Json(e.to_string()))?;
    std::fs::write(&config_path, content)
        .map_err(|e| AppError::Io(e.to_string()))?;

    Ok(ConfigureResult {
        success: true,
        path: config_path_str.clone(),
        message: format!(
            "Claude Code MCP configured successfully.\nConfig: {}\nRestart Claude Code to apply.",
            config_path_str
        ),
    })
}
