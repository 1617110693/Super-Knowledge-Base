use crate::error::AppError;
use reqwest::Client;
use std::path::Path;
use std::time::Duration;
use tokio::time::sleep;

const MINERU_AGENT_API: &str = "https://mineru.net/api/v1/agent/parse/file";
const POLL_INTERVAL_SECS: u64 = 2;
const MAX_POLL_ATTEMPTS: u32 = 100; // Max ~3 minutes

/// Parse a document using MinerU's Agent Lightweight API (v1/agent/parse/file).
/// This mode does NOT require a token (IP rate-limited).
/// Limits: ≤10MB file size, ≤20 pages.
pub async fn parse_with_agent(file_path: &Path) -> Result<String, AppError> {
    // Verify file size limit
    let file_size = std::fs::metadata(file_path)
        .map(|m| m.len())
        .unwrap_or(0);

    if file_size > 10 * 1024 * 1024 {
        return Err(AppError::MinerU(
            "File exceeds 10MB limit for Agent mode. Use Precise mode with a token for larger files."
                .to_string(),
        ));
    }

    let client = Client::new();

    // Prepare multipart form with the file
    let file_data = std::fs::read(file_path)?;
    let file_name = file_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("document.pdf")
        .to_string();

    let file_part = reqwest::multipart::Part::bytes(file_data)
        .file_name(file_name.clone())
        .mime_str(mime_type_for_path(file_path))
        .map_err(|e| AppError::MinerU(format!("Failed to create multipart: {}", e)))?;

    let form = reqwest::multipart::Form::new()
        .part("file", file_part);

    // Submit parse task
    let resp = client
        .post(MINERU_AGENT_API)
        .multipart(form)
        .send()
        .await?;

    if !resp.status().is_success() {
        return Err(AppError::MinerU(format!(
            "Agent parse submission failed: HTTP {}",
            resp.status()
        )));
    }

    let result: serde_json::Value = resp.json().await?;

    if result["code"].as_i64().unwrap_or(-1) != 0 {
        return Err(AppError::MinerU(format!(
            "Agent parse error: {}",
            result["msg"].as_str().unwrap_or("unknown error")
        )));
    }

    let task_id = result["data"]["task_id"]
        .as_str()
        .ok_or_else(|| AppError::MinerU("Missing task_id in response".to_string()))?
        .to_string();

    // Poll for result
    poll_agent_result(&client, &task_id).await
}

async fn poll_agent_result(client: &Client, task_id: &str) -> Result<String, AppError> {
    let url = format!("https://mineru.net/api/v1/agent/parse/file/{}", task_id);

    for _ in 0..MAX_POLL_ATTEMPTS {
        sleep(Duration::from_secs(POLL_INTERVAL_SECS)).await;

        let resp = client.get(&url).send().await?;

        if !resp.status().is_success() {
            continue;
        }

        let result: serde_json::Value = resp.json().await?;

        if result["code"].as_i64().unwrap_or(-1) != 0 {
            continue;
        }

        let state = result["data"]["state"].as_str().unwrap_or("unknown");

        match state {
            "done" => {
                // Agent mode returns a markdown CDN URL
                let md_url = result["data"]["md_url"]
                    .as_str()
                    .ok_or_else(|| AppError::MinerU("Missing md_url in response".to_string()))?;

                // Download the markdown content
                let md_resp = client.get(md_url).send().await?;
                let markdown = md_resp.text().await?;
                return Ok(markdown);
            }
            "failed" => {
                let err = result["data"]["err_msg"]
                    .as_str()
                    .unwrap_or("Unknown parse error");
                return Err(AppError::MinerU(format!("Parse failed: {}", err)));
            }
            _ => {
                // "running" or "pending" — continue polling
            }
        }
    }

    Err(AppError::MinerU(
        "Agent parse timed out after maximum polling attempts".to_string(),
    ))
}

fn mime_type_for_path(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("pdf") => "application/pdf",
        Some("doc") => "application/msword",
        Some("docx") => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        Some("ppt") => "application/vnd.ms-powerpoint",
        Some("pptx") => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        Some("xls") => "application/vnd.ms-excel",
        Some("xlsx") => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        Some("html") | Some("htm") => "text/html",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("jp2") => "image/jp2",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        Some("bmp") => "image/bmp",
        _ => "application/octet-stream",
    }
}
