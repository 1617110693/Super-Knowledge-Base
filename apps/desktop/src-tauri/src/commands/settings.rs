use crate::error::CommandResult;
use crate::models::settings::AppSettings;
use crate::AppState;
use tauri::State;

#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> CommandResult<AppSettings> {
    let settings = state.settings.lock().unwrap();
    Ok(settings.clone())
}

#[tauri::command]
pub async fn update_settings(
    state: State<'_, AppState>,
    new_settings: AppSettings,
) -> CommandResult<AppSettings> {
    let mut settings = state.settings.lock().unwrap();
    *settings = new_settings.clone();

    // Save to canonical location (~/.local-knowledge-base) for app restart
    let settings_dir = state.settings_dir.clone();
    std::fs::create_dir_all(&settings_dir).ok();
    settings.save(&settings_dir).map_err(|e| crate::error::AppError::Internal(e.to_string()))?;

    // Also save to data_dir so the Python backend can read it
    let data_dir = state.file_store.root_dir().clone();
    if data_dir != settings_dir {
        std::fs::create_dir_all(&data_dir).ok();
        settings.save(&data_dir).map_err(|e| crate::error::AppError::Internal(e.to_string()))?;
    }

    Ok(new_settings)
}
