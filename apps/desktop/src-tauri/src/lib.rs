mod commands;
mod error;
mod mineru;
mod models;
mod storage;

use commands::{
    chat, claude_config, documents, knowledge_base, parsing, python_service, settings,
};
use models::settings::AppSettings;
use storage::file_store::FileStore;
use tauri::Manager;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{TrayIconBuilder, MouseButton, MouseButtonState, TrayIconEvent};
use std::path::PathBuf;
use std::sync::Mutex;

/// Main application state
pub struct AppState {
    pub settings: Mutex<AppSettings>,
    pub file_store: FileStore,
    pub python_port: Mutex<u16>,
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
            let home = std::env::var("HOME")
                .or_else(|_| std::env::var("USERPROFILE"))
                .expect("Failed to get home directory");
            let default_dir = std::path::PathBuf::from(&home).join(".super-knowledge-base");

            let settings = AppSettings::load(&default_dir).unwrap_or_default();

            let data_dir = if settings.data_dir.is_empty() {
                default_dir.clone()
            } else {
                let custom = std::path::PathBuf::from(&settings.data_dir);
                // If the custom directory exists or has a parent that exists,
                // use it. Otherwise reset to default (stale path from migration).
                if custom.exists() || custom.parent().map_or(false, |p| p.exists()) {
                    custom
                } else {
                    eprintln!("[SKB] Custom data_dir '{}' does not exist, falling back to default", settings.data_dir);
                    default_dir.clone()
                }
            };
            std::fs::create_dir_all(&data_dir).ok();

            if data_dir != default_dir {
                std::fs::create_dir_all(&default_dir).ok();
            }

            let file_store = FileStore::new(data_dir);
            let port = settings.python_port;

            app.manage(AppState {
                settings: Mutex::new(settings),
                file_store,
                python_port: Mutex::new(port),
                settings_dir: default_dir,
            });
            app.manage(python_service::PythonProcess(Mutex::new(None)));

            // ── System Tray ──
            let show_item = MenuItemBuilder::with_id("show", "Show Window").build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
            let tray_menu = MenuBuilder::new(app)
                .items(&[&show_item, &quit_item])
                .build()?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("SKB")
                .menu(&tray_menu)
                .on_menu_event(|app, event| {
                    match event.id().as_ref() {
                        "show" => {
                            if let Some(w) = app.get_webview_window("main") {
                                w.show().ok();
                                w.set_focus().ok();
                            }
                        }
                        "quit" => {
                            python_service::force_kill_backend();
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event {
                        if let Some(w) = tray.app_handle().get_webview_window("main") {
                            w.show().ok();
                            w.set_focus().ok();
                        }
                    }
                })
                .build(app)?;

            // ── Close → Hide to Tray ──
            if let Some(window) = app.get_webview_window("main") {
                let w = window.clone();
                let _ = window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        w.hide().ok();
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            settings::get_settings,
            settings::update_settings,
            knowledge_base::create_kb,
            knowledge_base::update_kb,
            knowledge_base::copy_kb,
            knowledge_base::delete_kb,
            knowledge_base::list_kbs,
            knowledge_base::get_kb,
            knowledge_base::toggle_pin_kb,
            knowledge_base::reorder_kbs,
            knowledge_base::clear_all_kbs,
            knowledge_base::export_kbs,
            knowledge_base::import_kbs,
            documents::upload_document,
            documents::delete_document,
            documents::rename_document,
            documents::set_document_path,
            documents::list_paths,
            documents::delete_path,
            documents::rename_path,
            documents::list_documents,
            documents::get_document_content,
            documents::save_document_chunks,
            documents::save_document_content,
            documents::reveal_document_in_explorer,
            documents::open_document_file,
            parsing::start_parsing,
            parsing::poll_parse_status,
            parsing::cancel_parse_task,
            python_service::get_python_backend_url,
            python_service::start_python_backend,
            python_service::stop_python_backend,
            python_service::restart_python_backend,
            python_service::get_python_backend_status,
            claude_config::get_mcp_config_json,
            claude_config::configure_claude_mcp,
            chat::load_chat_conversations,
            chat::save_chat_conversations,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
