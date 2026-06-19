use crate::error::{AppError, CommandResult};
use crate::models::{Document, DocumentContent};
use crate::AppState;
use std::path::Path;
use tauri::State;

#[tauri::command]
pub async fn upload_document(
    state: State<'_, AppState>,
    kb_id: String,
    file_path: String,
) -> CommandResult<Document> {
    let path = Path::new(&file_path);

    // Validate file exists
    if !path.exists() {
        return Err(AppError::InvalidInput(format!(
            "File not found: {}",
            file_path
        )));
    }

    // Get file info
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string();

    let extension = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let file_size = std::fs::metadata(path)?.len();

    // Validate supported file types
    let supported = [
        "pdf", "doc", "docx", "ppt", "pptx", "xls", "xlsx",
        "png", "jpg", "jpeg", "jp2", "webp", "gif", "bmp", "html",
        "md", "markdown", "txt",
    ];
    if !supported.contains(&extension.as_str()) {
        return Err(AppError::InvalidInput(format!(
            "Unsupported file type: .{}",
            extension
        )));
    }

    // Create document entry
    let doc = state
        .file_store
        .add_document(&kb_id, file_name.clone(), extension.clone(), file_size)?;

    // Copy original file to document directory
    let dest_path = state
        .file_store
        .get_doc_dir(&kb_id, &doc.id)
        .join(format!("original.{}", extension));
    std::fs::copy(path, &dest_path)?;

    Ok(doc)
}

#[tauri::command]
pub async fn delete_document(
    state: State<'_, AppState>,
    kb_id: String,
    doc_id: String,
) -> CommandResult<()> {
    // Remove document from file store
    state.file_store.remove_document(&kb_id, &doc_id)?;

    // Also clean up vector chunks from LanceDB via Python backend
    let port = *state.python_port.lock().unwrap();
    let url = format!("http://127.0.0.1:{}/api/v1/delete-chunks", port);
    let client = reqwest::Client::new();
    let _ = client
        .post(&url)
        .json(&serde_json::json!({"kb_id": kb_id, "doc_id": doc_id}))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await;

    Ok(())
}

#[tauri::command]
pub async fn list_documents(
    state: State<'_, AppState>,
    kb_id: String,
) -> CommandResult<Vec<Document>> {
    state.file_store.list_documents(&kb_id)
}

#[tauri::command]
pub async fn get_document_content(
    state: State<'_, AppState>,
    kb_id: String,
    doc_id: String,
) -> CommandResult<DocumentContent> {
    state.file_store.get_document_content(&kb_id, &doc_id)
}

#[tauri::command]
pub async fn save_document_chunks(
    state: State<'_, AppState>,
    kb_id: String,
    doc_id: String,
    chunk_count: u32,
    embedding_model: String,
    embedding_dim: u32,
) -> CommandResult<Document> {
    // Update KB-level embedding info first (borrows), then doc chunks (moves)
    state.file_store.update_kb_embedding(&kb_id, &embedding_model, embedding_dim)?;
    let doc = state.file_store.update_document_chunks(&kb_id, &doc_id, chunk_count, embedding_model)?;
    Ok(doc)
}
