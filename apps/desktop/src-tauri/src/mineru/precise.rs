use crate::error::AppError;
use reqwest::Client;
use std::path::Path;
use std::time::Duration;
use tokio::time::sleep;

const POLL_INTERVAL_SECS: u64 = 3;
const MAX_POLL_ATTEMPTS: u32 = 200; // Max 10 minutes

/// Parse a document using MinerU's Precise API (v4/extract/task).
/// This mode requires a token and supports files up to 200MB / 200 pages.
/// For local files, we'd need to upload first — this implementation uses
/// a local file path and simulates the flow. In production, you'd first upload
/// the file to a public URL or use the batch upload endpoint.
pub async fn parse_with_precise(token: &str, file_path: &Path) -> Result<String, AppError> {
    // For precise mode with local files, the recommended flow is:
    // 1. Use the batch upload API (api/v4/file-urls/batch) to get upload URLs
    // 2. Upload the file to the pre-signed URL
    // 3. MinerU auto-submits the parse task
    // 4. Poll for results using batch_id
    //
    // We implement the batch upload flow here.

    let file_name = file_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("document.pdf");

    let client = Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| AppError::MinerU(format!("Failed to create HTTP client: {}", e)))?;

    // Step 1: Request upload URL
    let batch_response = request_upload_urls(token, &client, file_name).await?;
    let (batch_id, upload_url) = batch_response;

    // Step 2: Upload file to pre-signed URL
    upload_file_to_url(&client, &upload_url, file_path).await?;

    // Step 3 & 4: Poll for batch results
    let markdown = poll_batch_results(token, &client, &batch_id, file_name).await?;

    Ok(markdown)
}

async fn request_upload_urls(
    token: &str,
    client: &Client,
    file_name: &str,
) -> Result<(String, String), AppError> {
    let lower = file_name.to_lowercase();
    let is_html = lower.ends_with(".html") || lower.ends_with(".htm");

    // Model selection per MinerU docs:
    // - vlm: recommended for PDF and images (best quality)
    // - pipeline: for Office docs (doc/docx/ppt/pptx/xls/xlsx)
    // - MinerU-HTML: for HTML files
    let is_office = lower.ends_with(".doc") || lower.ends_with(".docx")
        || lower.ends_with(".ppt") || lower.ends_with(".pptx")
        || lower.ends_with(".xls") || lower.ends_with(".xlsx");
    let model = if is_html {
        "MinerU-HTML"
    } else if is_office {
        "pipeline"
    } else {
        "vlm"
    };

    let body = serde_json::json!({
        "files": [
            {
                "name": file_name,
                "data_id": format!("parse-{}", uuid::Uuid::new_v4())
            }
        ],
        "model_version": model
    });

    let resp = client
        .post("https://mineru.net/api/v4/file-urls/batch")
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", token))
        .json(&body)
        .send()
        .await?;

    if !resp.status().is_success() {
        return Err(AppError::MinerU(format!(
            "Failed to request upload URL: HTTP {}",
            resp.status()
        )));
    }

    let result: serde_json::Value = resp.json().await?;
    if result["code"].as_i64().unwrap_or(-1) != 0 {
        return Err(AppError::MinerU(format!(
            "Upload URL request failed: {}",
            result["msg"].as_str().unwrap_or("unknown error")
        )));
    }

    let batch_id = result["data"]["batch_id"]
        .as_str()
        .ok_or_else(|| AppError::MinerU("Missing batch_id in response".to_string()))?
        .to_string();

    let upload_url = result["data"]["file_urls"][0]
        .as_str()
        .ok_or_else(|| AppError::MinerU("Missing upload URL in response".to_string()))?
        .to_string();

    Ok((batch_id, upload_url))
}

async fn upload_file_to_url(
    client: &Client,
    url: &str,
    file_path: &Path,
) -> Result<(), AppError> {
    let file_data = std::fs::read(file_path)?;

    let resp = client
        .put(url)
        .body(file_data)
        .send()
        .await?;

    if !resp.status().is_success() {
        return Err(AppError::MinerU(format!(
            "File upload failed: HTTP {}",
            resp.status()
        )));
    }

    Ok(())
}

async fn poll_batch_results(
    token: &str,
    client: &Client,
    batch_id: &str,
    file_name: &str,
) -> Result<String, AppError> {
    let url = format!(
        "https://mineru.net/api/v4/extract-results/batch/{}",
        batch_id
    );

    for _ in 0..MAX_POLL_ATTEMPTS {
        sleep(Duration::from_secs(POLL_INTERVAL_SECS)).await;

        let resp = client
            .get(&url)
            .header("Authorization", format!("Bearer {}", token))
            .send()
            .await?;

        let result: serde_json::Value = resp.json().await?;

        if result["code"].as_i64().unwrap_or(-1) != 0 {
            continue; // Keep polling
        }

        let extract_results = match result["data"]["extract_result"].as_array() {
            Some(arr) => arr,
            None => continue,
        };

        for item in extract_results {
            let state = item["state"].as_str().unwrap_or("unknown");

            if state == "done" {
                // Download the result ZIP
                let full_zip_url = item["full_zip_url"]
                    .as_str()
                    .ok_or_else(|| AppError::MinerU("Missing full_zip_url".to_string()))?;

                return download_and_extract_markdown(client, full_zip_url, file_name).await;
            } else if state == "failed" {
                let err = item["err_msg"]
                    .as_str()
                    .unwrap_or("Unknown parse error");
                return Err(AppError::MinerU(format!("Parse failed: {}", err)));
            }
            // Otherwise still running or processing, keep polling
        }
    }

    Err(AppError::MinerU(
        "Parse timed out after maximum polling attempts".to_string(),
    ))
}

async fn download_and_extract_markdown(
    client: &Client,
    zip_url: &str,
    _file_name: &str,
) -> Result<String, AppError> {
    // Download the ZIP file
    let resp = client.get(zip_url).send().await?;
    let zip_bytes = resp.bytes().await?;

    // Extract the ZIP in memory and find full.md
    let cursor = std::io::Cursor::new(zip_bytes);
    let mut archive = zip::ZipArchive::new(cursor)
        .map_err(|e| AppError::MinerU(format!("Failed to open ZIP: {}", e)))?;

    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| AppError::MinerU(format!("Failed to read ZIP entry: {}", e)))?;

        let name = file.name().to_string();
        if name.ends_with("full.md") || name == "full.md" {
            let mut content = String::new();
            use std::io::Read;
            file.read_to_string(&mut content)
                .map_err(|e| AppError::MinerU(format!("Failed to read markdown: {}", e)))?;
            return Ok(content);
        }
    }

    Err(AppError::MinerU(
        "full.md not found in result archive".to_string(),
    ))
}
