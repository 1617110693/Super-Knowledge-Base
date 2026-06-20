use crate::error::{AppError, CommandResult};
use crate::mineru::{self, ParseMode};
use crate::models::{ParseStatus, ParseTask};
use crate::AppState;
use tauri::State;

#[tauri::command]
pub async fn start_parsing(
    state: State<'_, AppState>,
    kb_id: String,
    doc_id: String,
) -> CommandResult<ParseTask> {
    // Get document
    let doc = state.file_store.get_document(&kb_id, &doc_id)?;

    // Get settings for token
    let settings = state.settings.lock().unwrap().clone();

    let doc_dir = state.file_store.get_doc_dir(&kb_id, &doc_id);
    let ext = doc.file_type;
    let original_path = doc_dir.join(format!("original.{}", ext));

    // Markdown and plain-text files: skip MinerU, directly use content as parsed result
    let is_text = matches!(ext.as_str(), "md" | "markdown" | "txt");
    if is_text {
        let content = std::fs::read_to_string(&original_path)?;
        state
            .file_store
            .save_parsed_markdown(&kb_id, &doc_id, &content)?;
        state.file_store.update_document_status(
            &kb_id,
            &doc_id,
            ParseStatus::Done,
            None,
        )?;
        return Ok(ParseTask {
            task_id: doc_id.clone(),
            state: crate::models::ParseTaskState::Done,
            progress: None,
            full_zip_url: None,
            err_msg: None,
        });
    }

    // Check if file is small enough for agent mode
    let file_size = std::fs::metadata(&original_path)
        .map(|m| m.len())
        .unwrap_or(0);

    // Choose parse mode: Agent first for small files (fast, native Office
    // parsers, no token needed).  Precise API only for large files or when
    // Agent fails — the Agent API is limited to 10 MB / 20 pages.
    let mode = if file_size <= 10 * 1024 * 1024 {
        ParseMode::Agent {
            file_path: original_path,
        }
    } else if !settings.mineru_token.is_empty() && file_size <= 200 * 1024 * 1024 {
        ParseMode::Precise {
            token: settings.mineru_token.clone(),
            file_path: original_path,
        }
    } else {
        return Err(AppError::InvalidInput(
            "File too large for agent mode and no MinerU token configured for precise mode"
                .to_string(),
        ));
    };

    // Update document status
    state.file_store.update_document_status(
        &kb_id,
        &doc_id,
        ParseStatus::Parsing,
        None,
    )?;

    // Spawn parse task (async, runs in background)
    let file_store = state.file_store.clone();
    let kb_id_clone = kb_id.clone();
    let doc_id_clone = doc_id.clone();

    tokio::spawn(async move {
        let result = mineru::parse_document(mode).await;
        match result {
            Ok(markdown) => {
                // Save parsed markdown
                let _ = file_store.save_parsed_markdown(&kb_id_clone, &doc_id_clone, &markdown);
                let _ = file_store.update_document_status(
                    &kb_id_clone,
                    &doc_id_clone,
                    ParseStatus::Done,
                    None,
                );
            }
            Err(e) => {
                let _ = file_store.update_document_status(
                    &kb_id_clone,
                    &doc_id_clone,
                    ParseStatus::Failed,
                    Some(e.to_string()),
                );
            }
        }
    });

    // Return an initial "running" task (simplified — in production we'd track the task_id)
    Ok(ParseTask {
        task_id: doc_id.clone(),
        state: crate::models::ParseTaskState::Running,
        progress: None,
        full_zip_url: None,
        err_msg: None,
    })
}

#[tauri::command]
pub async fn poll_parse_status(
    state: State<'_, AppState>,
    kb_id: String,
    doc_id: String,
) -> CommandResult<crate::models::Document> {
    state.file_store.get_document(&kb_id, &doc_id)
}

#[tauri::command]
pub async fn cancel_parse_task(
    state: State<'_, AppState>,
    kb_id: String,
    doc_id: String,
) -> CommandResult<()> {
    // For now, just mark as failed
    state.file_store.update_document_status(
        &kb_id,
        &doc_id,
        ParseStatus::Failed,
        Some("Cancelled by user".to_string()),
    )?;
    Ok(())
}
