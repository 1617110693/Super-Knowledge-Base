use crate::error::CommandResult;
use crate::AppState;
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChatConversation {
    pub id: String,
    pub title: String,
    pub messages: Vec<serde_json::Value>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

#[tauri::command]
pub async fn load_chat_conversations(
    state: State<'_, AppState>,
) -> CommandResult<Vec<ChatConversation>> {
    let path = state.file_store.root_dir().join("chat_conversations.json");
    if !path.exists() {
        return Ok(Vec::new());
    }
    let data = std::fs::read_to_string(&path)
        .map_err(|e| crate::error::AppError::Io(e.to_string()))?;
    let convs: Vec<ChatConversation> = serde_json::from_str(&data)
        .unwrap_or_default();
    Ok(convs)
}

#[tauri::command]
pub async fn save_chat_conversations(
    state: State<'_, AppState>,
    conversations: Vec<ChatConversation>,
) -> CommandResult<()> {
    let path = state.file_store.root_dir().join("chat_conversations.json");
    let data = serde_json::to_string_pretty(&conversations)
        .map_err(|e| crate::error::AppError::Json(e.to_string()))?;
    std::fs::write(&path, data)
        .map_err(|e| crate::error::AppError::Io(e.to_string()))?;
    Ok(())
}
