mod commands;
mod error;
mod mineru;
mod models;
mod storage;

use commands::{
    documents, knowledge_base, parsing, python_service, settings,
};
use models::settings::AppSettings;
use storage::file_store::FileStore;
use tauri::Manager;
use std::sync::Mutex;

/// Main application state
pub struct AppState {
    pub settings: Mutex<AppSettings>,
    pub file_store: FileStore,
    pub python_port: Mutex<u16>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .setup(|app| {
            // Use ~/.local-knowledge-base as the data directory (consistent across platforms)
            let home = std::env::var("HOME")
                .or_else(|_| std::env::var("USERPROFILE"))
                .expect("Failed to get home directory");
            let app_data_dir = std::path::PathBuf::from(home).join(".local-knowledge-base");
            std::fs::create_dir_all(&app_data_dir).ok();

            // Initialize file store
            let file_store = FileStore::new(app_data_dir.clone());

            // Load or create settings
            let settings = AppSettings::load(&app_data_dir).unwrap_or_default();

            // Allocate Python backend port
            let port = settings.python_port;

            // Manage app state
            app.manage(AppState {
                settings: Mutex::new(settings),
                file_store,
                python_port: Mutex::new(port),
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Settings commands
            settings::get_settings,
            settings::update_settings,
            // Knowledge base commands
            knowledge_base::create_kb,
            knowledge_base::delete_kb,
            knowledge_base::list_kbs,
            knowledge_base::get_kb,
            // Document commands
            documents::upload_document,
            documents::delete_document,
            documents::list_documents,
            documents::get_document_content,
            // Parsing commands
            parsing::start_parsing,
            parsing::poll_parse_status,
            parsing::cancel_parse_task,
            // Python service commands
            python_service::get_python_backend_url,
            python_service::start_python_backend,
            python_service::stop_python_backend,
            python_service::get_python_backend_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
