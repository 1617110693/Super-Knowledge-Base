use crate::error::AppError;
use reqwest::Client;
use std::path::Path;
use std::time::Duration;
use tokio::time::sleep;

const AGENT_PARSE_FILE: &str = "https://mineru.net/api/v1/agent/parse/file";
const POLL_INTERVAL_SECS: u64 = 3;
const MAX_POLL_ATTEMPTS: u32 = 60; // Max ~3 minutes

/// Parse a document using MinerU's Agent Lightweight API.
///
/// Uses the **signed URL** flow (JSON request → signed upload URL →
/// PUT file → poll for result).  This mode does NOT require a token
/// (IP rate-limited).  Limits: ≤10 MB file size, ≤20 pages.
pub async fn parse_with_agent(file_path: &Path) -> Result<String, AppError> {
    // Verify file size limit
    let file_size = std::fs::metadata(file_path)
        .map(|m| m.len())
        .unwrap_or(0);

    if file_size > 10 * 1024 * 1024 {
        return Err(AppError::MinerU(
            "File exceeds 10MB limit for Agent mode.".to_string(),
        ));
    }

    let file_data = std::fs::read(file_path)?;
    let file_name = file_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("document.pdf")
        .to_string();

    let client = Client::new();

    // ── Step 1: request signed upload URL (JSON body, NOT multipart) ──
    let body = serde_json::json!({
        "file_name": file_name,
        "language": "ch",
    });

    let resp = client
        .post(AGENT_PARSE_FILE)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await?;

    let result: serde_json::Value = resp.json().await?;

    if result["code"].as_i64().unwrap_or(-1) != 0 {
        return Err(AppError::MinerU(format!(
            "Agent API error: {}",
            result["msg"].as_str().unwrap_or("unknown")
        )));
    }

    let task_id = result["data"]["task_id"]
        .as_str()
        .ok_or_else(|| AppError::MinerU("Missing task_id".to_string()))?
        .to_string();
    let file_url = result["data"]["file_url"]
        .as_str()
        .ok_or_else(|| AppError::MinerU("Missing file_url".to_string()))?
        .to_string();

    // ── Step 2: PUT upload file to signed URL ──
    let put_resp = client.put(&file_url).body(file_data).send().await?;
    if !put_resp.status().is_success() {
        return Err(AppError::MinerU(format!(
            "Agent upload failed: HTTP {}",
            put_resp.status()
        )));
    }

    // ── Step 3: poll for result ──
    poll_agent_result(&client, &task_id).await
}

async fn poll_agent_result(client: &Client, task_id: &str) -> Result<String, AppError> {
    let url = format!("https://mineru.net/api/v1/agent/parse/{}", task_id);

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
                let md_url = result["data"]["markdown_url"]
                    .as_str()
                    .or_else(|| result["data"]["md_url"].as_str())
                    .ok_or_else(|| AppError::MinerU("Missing markdown_url".to_string()))?;

                let md_resp = client.get(md_url).send().await?;
                return Ok(md_resp.text().await?);
            }
            "failed" => {
                let err = result["data"]["err_msg"]
                    .as_str()
                    .unwrap_or("Unknown error");
                return Err(AppError::MinerU(format!("Parse failed: {}", err)));
            }
            _ => { /* running / pending — keep polling */ }
        }
    }

    Err(AppError::MinerU(
        "Agent parse timed out".to_string(),
    ))
}
