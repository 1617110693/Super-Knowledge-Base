use crate::error::{AppError, CommandResult};
use crate::models::{Document, DocumentContent, ParseStatus};
use crate::AppState;
use std::path::Path;
use tauri::State;

#[derive(Debug, serde::Serialize)]
pub struct UploadResult {
    pub document: Document,
    pub parts: Vec<Document>,
}

#[tauri::command]
pub async fn upload_document(
    state: State<'_, AppState>,
    kb_id: String,
    file_path: String,
    folder_path: Option<String>,
) -> CommandResult<UploadResult> {
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

    // Create document entry (main doc keeps the original file; parts created below)
    let mut doc = state
        .file_store
        .add_document(&kb_id, file_name.clone(), extension.clone(), file_size, None)?;

    // If uploading into a folder, set the path
    if let Some(ref fp) = folder_path {
        if !fp.is_empty() {
            doc = state.file_store.set_document_path(&kb_id, &doc.id, Some(fp.as_str()))?;
        }
    }

    // Copy original file to document directory
    let dest_path = state
        .file_store
        .get_doc_dir(&kb_id, &doc.id)
        .join(format!("original.{}", extension));
    std::fs::copy(path, &dest_path)?;

    // For PDFs: check if splitting is needed (Precise mode: ≤200 pages, ≤200MB)
    let mut parts = Vec::new();
    if extension == "pdf" {
        let port = *state.python_port.lock().unwrap();
        let client = reqwest::Client::new();
        let split_url = format!("http://127.0.0.1:{}/api/v1/utils/split-pdf", port);
        match client
            .post(&split_url)
            .json(&serde_json::json!({
                "file_path": dest_path.to_string_lossy(),
                "max_pages": 200,
                "max_size_mb": 200,
            }))
            .timeout(std::time::Duration::from_secs(30))
            .send()
            .await
        {
            Ok(resp) => {
                match resp.json::<serde_json::Value>().await {
                    Ok(result) => {
                        if result["split"].as_bool().unwrap_or(false) {
                            if let Some(part_paths) = result["parts"].as_array() {
                                let name_stem = Path::new(&file_name)
                                    .file_stem()
                                    .and_then(|s| s.to_str())
                                    .unwrap_or(&file_name);
                                // Create ALL parts (including part1) as child documents.
                                // The main doc keeps the complete original file so users can
                                // still open/preview it; each part is independently parseable.
                                let parent_id = &doc.id;
                                for (i, part_path) in part_paths.iter().enumerate() {
                                    if let Some(p) = part_path.as_str() {
                                        let part_num = i + 1;
                                        let part_name = format!("{}_part{}.pdf", name_stem, part_num);
                                        let part_size = std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
                                        if let Ok(part_doc) = state.file_store.add_document(
                                            &kb_id, part_name, "pdf".to_string(), part_size,
                                            Some(parent_id.clone()),
                                        ) {
                                            let part_dest = state
                                                .file_store
                                                .get_doc_dir(&kb_id, &part_doc.id)
                                                .join("original.pdf");
                                            if std::fs::copy(p, &part_dest).is_ok() {
                                                parts.push(part_doc);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!("[upload] Failed to parse split-pdf response: {}", e);
                    }
                }
            }
            Err(e) => {
                eprintln!("[upload] Cannot reach split-pdf at {}: {}", split_url, e);
            }
        }
    }

    Ok(UploadResult { document: doc, parts })
}

#[tauri::command]
pub async fn delete_document(
    state: State<'_, AppState>,
    kb_id: String,
    doc_id: String,
) -> CommandResult<()> {
    // Collect child doc IDs before removing (remove_document cascades)
    let child_ids: Vec<String> = state
        .file_store
        .get_child_documents(&kb_id, &doc_id)
        .unwrap_or_default()
        .into_iter()
        .map(|d| d.id)
        .collect();

    // Remove document from file store (cascades to children)
    state.file_store.remove_document(&kb_id, &doc_id)?;

    // Clean up vector chunks from LanceDB via Python backend
    let port = *state.python_port.lock().unwrap();
    let client = reqwest::Client::new();
    let all_ids = std::iter::once(doc_id.clone()).chain(child_ids.into_iter());
    for id in all_ids {
        let url = format!("http://127.0.0.1:{}/api/v1/delete-chunks", port);
        let _ = client
            .post(&url)
            .json(&serde_json::json!({"kb_id": kb_id, "doc_id": id}))
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await;
    }

    Ok(())
}

#[tauri::command]
pub async fn rename_document(
    state: State<'_, AppState>,
    kb_id: String,
    doc_id: String,
    new_name: String,
) -> CommandResult<Document> {
    if new_name.trim().is_empty() {
        return Err(AppError::InvalidInput("Document name cannot be empty".to_string()));
    }
    state.file_store.rename_document(&kb_id, &doc_id, new_name.trim())
}

#[tauri::command]
pub async fn set_document_path(
    state: State<'_, AppState>,
    kb_id: String,
    doc_id: String,
    path: Option<String>,
) -> CommandResult<Document> {
    state.file_store.set_document_path(&kb_id, &doc_id, path.as_deref())
}

#[tauri::command]
pub async fn list_paths(
    state: State<'_, AppState>,
    kb_id: String,
) -> CommandResult<Vec<String>> {
    state.file_store.list_paths(&kb_id)
}

#[tauri::command]
pub async fn delete_path(
    state: State<'_, AppState>,
    kb_id: String,
    path: String,
) -> CommandResult<u32> {
    state.file_store.delete_path(&kb_id, &path)
}

#[tauri::command]
pub async fn rename_path(
    state: State<'_, AppState>,
    kb_id: String,
    old_path: String,
    new_path: String,
) -> CommandResult<u32> {
    state.file_store.rename_path(&kb_id, &old_path, &new_path)
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
pub async fn reveal_document_in_explorer(
    state: State<'_, AppState>,
    kb_id: String,
    doc_id: String,
) -> CommandResult<String> {
    let doc = state.file_store.get_document(&kb_id, &doc_id)?;
    let doc_dir = state.file_store.get_doc_dir(&kb_id, &doc_id);
    let original_path = doc_dir.join(format!("original.{}", doc.file_type));

    // Use the original file if it exists, otherwise fall back to the doc directory itself
    let target = if original_path.exists() {
        original_path
    } else {
        doc_dir
    };

    let path_str = target.to_string_lossy().to_string();

    #[cfg(target_os = "windows")]
    {
        if target.is_dir() {
            std::process::Command::new("explorer")
                .arg(&path_str)
                .spawn()
                .map_err(|e| AppError::PythonBackend(format!("Failed to open explorer: {}", e)))?;
        } else {
            std::process::Command::new("explorer")
                .args(["/select,", &path_str])
                .spawn()
                .map_err(|e| AppError::PythonBackend(format!("Failed to open explorer: {}", e)))?;
        }
    }
    #[cfg(target_os = "macos")]
    {
        if target.is_dir() {
            std::process::Command::new("open")
                .arg(&path_str)
                .spawn()
                .map_err(|e| AppError::PythonBackend(format!("Failed to open Finder: {}", e)))?;
        } else {
            std::process::Command::new("open")
                .args(["-R", &path_str])
                .spawn()
                .map_err(|e| AppError::PythonBackend(format!("Failed to open Finder: {}", e)))?;
        }
    }
    #[cfg(target_os = "linux")]
    {
        let parent = target.parent().map(|p| p.to_string_lossy().to_string()).unwrap_or(path_str.clone());
        std::process::Command::new("xdg-open")
            .arg(&parent)
            .spawn()
            .map_err(|e| AppError::PythonBackend(format!("Failed to open file manager: {}", e)))?;
    }

    Ok(path_str)
}

#[tauri::command]
pub async fn open_document_file(
    state: State<'_, AppState>,
    kb_id: String,
    doc_id: String,
) -> CommandResult<String> {
    let doc = state.file_store.get_document(&kb_id, &doc_id)?;
    let doc_dir = state.file_store.get_doc_dir(&kb_id, &doc_id);
    let original_path = doc_dir.join(format!("original.{}", doc.file_type));

    if !original_path.exists() {
        return Err(AppError::NotFound(format!(
            "Original file not found for document: {}",
            doc.name
        )));
    }

    // Open with OS default application
    open::that(&original_path).map_err(|e| {
        AppError::PythonBackend(format!("Failed to open file: {}", e))
    })?;

    Ok(original_path.to_string_lossy().to_string())
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

#[tauri::command]
pub async fn save_document_content(
    state: State<'_, AppState>,
    kb_id: String,
    doc_id: String,
    content: String,
) -> CommandResult<()> {
    state.file_store.save_parsed_markdown(&kb_id, &doc_id, &content)?;
    Ok(())
}

// ── Folder persistence ──

#[tauri::command]
pub async fn create_folder(
    state: State<'_, AppState>,
    kb_id: String,
    path: String,
) -> CommandResult<()> {
    state.file_store.create_folder(&kb_id, &path)
}

#[tauri::command]
pub async fn remove_folder(
    state: State<'_, AppState>,
    kb_id: String,
    path: String,
) -> CommandResult<()> {
    state.file_store.remove_folder(&kb_id, &path)
}

// ── Cross-KB document copy ──

#[tauri::command]
pub async fn copy_document_to_kb(
    state: State<'_, AppState>,
    kb_id: String,
    doc_id: String,
    target_kb_id: String,
    target_path: Option<String>,
) -> CommandResult<Document> {
    // Validate: target KB must exist
    let registry = state.file_store.load_registry()?;
    if !registry.knowledge_bases.iter().any(|kb| kb.id == target_kb_id) {
        return Err(AppError::InvalidInput("Target knowledge base not found".into()));
    }

    // Read source document — get content, file_type, and source directory
    let content = state.file_store.get_document_content(&kb_id, &doc_id)?;
    let source_doc = state.file_store.get_document(&kb_id, &doc_id)?;
    let source_doc_dir = state.file_store.get_doc_dir(&kb_id, &doc_id);

    // Create new document in target KB
    let file_type = source_doc.file_type.clone();
    let new_doc = state.file_store.add_document(&target_kb_id, content.name.clone(), file_type.clone(), source_doc.file_size, None)?;
    let target_doc_dir = state.file_store.get_doc_dir(&target_kb_id, &new_doc.id);

    // Copy full.md
    let source_md = source_doc_dir.join("full.md");
    if source_md.exists() {
        std::fs::copy(&source_md, target_doc_dir.join("full.md"))?;
    }

    // Copy original file
    let orig = source_doc_dir.join(format!("original.{}", file_type));
    if orig.exists() {
        std::fs::copy(&orig, target_doc_dir.join(format!("original.{}", file_type)))?;
    }

    // Copy mineru_result.json
    let json_src = source_doc_dir.join("mineru_result.json");
    if json_src.exists() {
        std::fs::copy(&json_src, target_doc_dir.join("mineru_result.json"))?;
    }

    // Update path and status
    let mut saved = state.file_store.get_document(&target_kb_id, &new_doc.id)?;
    saved.path = target_path;
    saved.parse_status = ParseStatus::Done;
    state.file_store.save_document_meta(&saved)?;

    Ok(saved)
}
