mod commands;
mod error;
mod mineru;
mod models;
mod storage;

use commands::{
    claude_config, documents, knowledge_base, parsing, python_service, settings,
};
use models::settings::AppSettings;
use storage::file_store::FileStore;
use tauri::Manager;
use std::path::PathBuf;
use std::sync::Mutex;

/// Main application state
pub struct AppState {
    pub settings: Mutex<AppSettings>,
    pub file_store: FileStore,
    pub python_port: Mutex<u16>,
    /// The directory where settings.json lives (~/.local-knowledge-base).
    /// This is separate from file_store.root_dir() which may be a custom data_dir.
    pub settings_dir: PathBuf,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .setup(|app| {
            // Default data directory: ~/.local-knowledge-base
            let home = std::env::var("HOME")
                .or_else(|_| std::env::var("USERPROFILE"))
                .expect("Failed to get home directory");
            let default_dir = std::path::PathBuf::from(&home).join(".local-knowledge-base");

            // Load settings from default location first
            let settings = AppSettings::load(&default_dir).unwrap_or_default();

            // Use custom data_dir if set, otherwise default
            let data_dir = if settings.data_dir.is_empty() {
                default_dir.clone()
            } else {
                std::path::PathBuf::from(&settings.data_dir)
            };
            std::fs::create_dir_all(&data_dir).ok();

            // Always ensure default dir exists for settings.json
            if data_dir != default_dir {
                std::fs::create_dir_all(&default_dir).ok();
            }

            // Initialize file store at the chosen data directory
            let file_store = FileStore::new(data_dir);

            // Allocate Python backend port
            let port = settings.python_port;

            // Manage app state
            app.manage(AppState {
                settings: Mutex::new(settings),
                file_store,
                python_port: Mutex::new(port),
                settings_dir: default_dir,
            });
            app.manage(python_service::PythonProcess(Mutex::new(None)));

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Settings commands
            settings::get_settings,
            settings::update_settings,
            // Knowledge base commands
            knowledge_base::create_kb,
            knowledge_base::rename_kb,
            knowledge_base::delete_kb,
            knowledge_base::list_kbs,
            knowledge_base::get_kb,
            // Document commands
            documents::upload_document,
            documents::delete_document,
            documents::list_documents,
            documents::get_document_content,
            documents::save_document_chunks,
            // Parsing commands
            parsing::start_parsing,
            parsing::poll_parse_status,
            parsing::cancel_parse_task,
            // Python service commands
            python_service::get_python_backend_url,
            python_service::start_python_backend,
            python_service::stop_python_backend,
            python_service::get_python_backend_status,
            claude_config::configure_claude_mcp,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
