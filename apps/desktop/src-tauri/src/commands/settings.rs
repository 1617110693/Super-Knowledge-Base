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

    // Persist to disk
    let app_data_dir = state.file_store.root_dir().clone();
    settings.save(&app_data_dir).map_err(|e| crate::error::AppError::Internal(e.to_string()))?;

    Ok(new_settings)
}
