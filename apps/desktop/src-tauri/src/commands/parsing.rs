use crate::error::{AppError, CommandResult};
use crate::mineru::{self, ParseMode};
use crate::models::{ParseProgress, ParseStatus, ParseTask};
use crate::AppState;
use std::sync::{Arc, Mutex};
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
    let zip_path = doc_dir.join("mineru_bundle.zip");

    // Detect ZIP bundle: prefer mineru_bundle.zip if it exists
    let is_zip = zip_path.exists();
    let parse_path = if is_zip { &zip_path } else { &original_path };

    // Markdown and plain-text files: skip MinerU, directly use content as parsed result
    let is_text = matches!(ext.as_str(), "md" | "markdown" | "txt");
    if is_text && !is_zip {
        let content = std::fs::read_to_string(parse_path)?;
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

    // Always use Precise API (requires token, supports up to 200 MB / 200 pages)
    let file_size = std::fs::metadata(parse_path)
        .map(|m| m.len())
        .unwrap_or(0);

    // Size check only for MinerU API (ZIP bundles can be larger)
    if !is_zip && file_size > 200 * 1024 * 1024 {
        return Err(AppError::InvalidInput(format!(
            "File too large: {} bytes. Maximum is 200 MB for Precise mode.",
            file_size
        )));
    }

    // Token check only for MinerU API
    if !is_zip && settings.mineru_token.is_empty() {
        return Err(AppError::InvalidInput(
            "MinerU token not configured. Please go to Settings and add your MinerU API token.".to_string(),
        ));
    }

    let mode = if is_zip {
        ParseMode::LocalZip {
            file_path: parse_path.to_path_buf(),
        }
    } else {
        ParseMode::Precise {
            token: settings.mineru_token.clone(),
            file_path: parse_path.to_path_buf(),
        }
    };

    // Update document status
    state.file_store.update_document_status(
        &kb_id,
        &doc_id,
        ParseStatus::Parsing,
        None,
    )?;

    // Create progress shared between command and background task
    let progress = Arc::new(Mutex::new(ParseProgress {
        percent: 0,
        stage: "starting".into(),
    }));
    {
        let mut map = state.parse_progress.lock().unwrap();
        map.insert(doc_id.clone(), progress.lock().unwrap().clone());
    }

    // Spawn parse task (async, runs in background)
    let file_store = state.file_store.clone();
    let kb_id_clone = kb_id.clone();
    let doc_id_clone = doc_id.clone();
    let progress_clone = progress.clone();
    let parse_progress_map = state.parse_progress.clone();

    tokio::spawn(async move {
        let result = mineru::parse_document(mode, Some(progress_clone)).await;
        // Clean up progress entry
        {
            let mut map = parse_progress_map.lock().unwrap();
            map.remove(&doc_id_clone);
        }
        match result {
            Ok(precise_result) => {
                let _ = file_store.save_parsed_markdown(&kb_id_clone, &doc_id_clone, &precise_result.markdown);
                if let Some(ref json) = precise_result.json_content {
                    let _ = file_store.save_mineru_json(&kb_id_clone, &doc_id_clone, json);
                }
                if let Some(ref content_list) = precise_result.content_list_json {
                    let _ = file_store.save_content_list_json(&kb_id_clone, &doc_id_clone, content_list);
                }
                if !precise_result.extracted_images.is_empty() {
                    let _ = file_store.save_images(&kb_id_clone, &doc_id_clone, &precise_result.extracted_images);
                }
                let _ = file_store.save_mineru_zip(&kb_id_clone, &doc_id_clone, &precise_result.raw_zip);
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

    Ok(ParseTask {
        task_id: doc_id.clone(),
        state: crate::models::ParseTaskState::Running,
        progress: Some(ParseProgress {
            percent: 0,
            stage: "starting".into(),
        }),
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
pub async fn get_parse_progress(
    state: State<'_, AppState>,
    kb_id: String,
    doc_id: String,
) -> CommandResult<Option<ParseProgress>> {
    let doc = state.file_store.get_document(&kb_id, &doc_id)?;
    if doc.parse_status != ParseStatus::Parsing {
        return Ok(None);
    }
    let map = state.parse_progress.lock().unwrap();
    Ok(map.get(&doc_id).cloned())
}

#[tauri::command]
pub async fn cancel_parse_task(
    state: State<'_, AppState>,
    kb_id: String,
    doc_id: String,
) -> CommandResult<()> {
    state.file_store.update_document_status(
        &kb_id,
        &doc_id,
        ParseStatus::Failed,
        Some("Cancelled by user".to_string()),
    )?;
    Ok(())
}
