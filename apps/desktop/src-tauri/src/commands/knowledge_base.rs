use crate::error::CommandResult;
use crate::models::KnowledgeBase;
use crate::AppState;
use tauri::State;

#[tauri::command]
pub async fn create_kb(
    state: State<'_, AppState>,
    name: String,
    description: String,
) -> CommandResult<KnowledgeBase> {
    state.file_store.create_kb(name, description)
}

#[tauri::command]
pub async fn rename_kb(
    state: State<'_, AppState>,
    kb_id: String,
    name: String,
) -> CommandResult<KnowledgeBase> {
    state.file_store.rename_kb(&kb_id, name)
}

#[tauri::command]
pub async fn delete_kb(
    state: State<'_, AppState>,
    kb_id: String,
) -> CommandResult<()> {
    state.file_store.delete_kb(&kb_id)
}

#[tauri::command]
pub async fn list_kbs(
    state: State<'_, AppState>,
) -> CommandResult<Vec<KnowledgeBase>> {
    state.file_store.list_kbs()
}

#[tauri::command]
pub async fn get_kb(
    state: State<'_, AppState>,
    kb_id: String,
) -> CommandResult<KnowledgeBase> {
    state.file_store.get_kb(&kb_id)
}
