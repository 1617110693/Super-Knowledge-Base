use crate::error::AppError;
use crate::models::ParseProgress;
use reqwest::Client;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::time::sleep;

const POLL_INTERVAL_SECS: u64 = 3;
const MAX_POLL_ATTEMPTS: u32 = 200; // Max 10 minutes

/// Result from a MinerU Precise parse.
pub struct PreciseResult {
    pub markdown: String,
    /// The JSON file from the ZIP containing pdf_info with page metadata.
    /// None if no JSON was found in the archive.
    pub json_content: Option<String>,
    /// The content_list.json from the ZIP — each block has page_idx directly,
    /// giving perfect page mapping without fingerprint matching.
    pub content_list_json: Option<String>,
    /// Images extracted from the ZIP (filename → bytes).
    pub extracted_images: Vec<(String, Vec<u8>)>,
    /// Raw ZIP bytes for dev-mode caching.
    pub raw_zip: Vec<u8>,
}

/// Parse a document using MinerU's Precise API (v4/extract/task).
/// This mode requires a token and supports files up to 200MB / 200 pages.
/// Returns both the markdown and the JSON metadata (for page number tracking).
pub async fn parse_with_precise(
    token: &str,
    file_path: &Path,
    progress: Option<Arc<Mutex<ParseProgress>>>,
) -> Result<PreciseResult, AppError> {
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
        .use_rustls_tls()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| AppError::MinerU(format!("Failed to create HTTP client: {}", e)))?;

    // Step 1: Request upload URL
    if let Some(ref p) = progress {
        p.lock().unwrap().stage = "uploading".into();
        p.lock().unwrap().percent = 5;
    }
    let batch_response = request_upload_urls(token, &client, file_name).await?;
    let (batch_id, upload_url) = batch_response;

    // Step 2: Upload file to pre-signed URL
    if let Some(ref p) = progress {
        p.lock().unwrap().stage = "uploading".into();
        p.lock().unwrap().percent = 10;
    }
    upload_file_to_url(&client, &upload_url, file_path).await?;

    // Step 3 & 4: Poll for batch results
    let result = poll_batch_results(token, &client, &batch_id, file_name, progress.clone()).await?;

    Ok(result)
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
    progress: Option<Arc<Mutex<ParseProgress>>>,
) -> Result<PreciseResult, AppError> {
    let url = format!(
        "https://mineru.net/api/v4/extract-results/batch/{}",
        batch_id
    );

    for attempt in 0..MAX_POLL_ATTEMPTS {
        sleep(Duration::from_secs(POLL_INTERVAL_SECS)).await;

        // Update progress: 10% + polling progress (up to 80%)
        if let Some(ref p) = progress {
            let mut pg = p.lock().unwrap();
            pg.stage = "processing".into();
            pg.percent = 10 + ((attempt as f32 / MAX_POLL_ATTEMPTS as f32) * 80.0) as u8;
        }

        let resp = match client
            .get(&url)
            .header("Authorization", format!("Bearer {}", token))
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                eprintln!(
                    "[SKB] MinerU poll request failed (attempt {}): {}, skipping",
                    attempt + 1,
                    e
                );
                continue;
            }
        };

        let result: serde_json::Value = match resp.json().await {
            Ok(v) => v,
            Err(e) => {
                eprintln!(
                    "[SKB] MinerU poll json failed (attempt {}): {}, skipping",
                    attempt + 1,
                    e
                );
                continue;
            }
        };

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
                if let Some(ref p) = progress {
                    let mut pg = p.lock().unwrap();
                    pg.stage = "downloading".into();
                    pg.percent = 90;
                }
                let full_zip_url = item["full_zip_url"]
                    .as_str()
                    .ok_or_else(|| AppError::MinerU("Missing full_zip_url".to_string()))?;

                let result = download_and_extract_markdown(client, full_zip_url, file_name).await;

                if let Some(ref p) = progress {
                    let mut pg = p.lock().unwrap();
                    pg.stage = "done".into();
                    pg.percent = 100;
                }

                return result;
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
) -> Result<PreciseResult, AppError> {
    // Download the ZIP file (with retry — CDN connections can be flaky)
    let zip_bytes = download_zip_with_retry(client, zip_url).await?;
    let raw_zip = zip_bytes.clone(); // clone for caching

    // Extract the ZIP in memory — find both full.md and the JSON metadata
    let cursor = std::io::Cursor::new(zip_bytes);
    let mut archive = zip::ZipArchive::new(cursor)
        .map_err(|e| AppError::MinerU(format!("Failed to open ZIP: {}", e)))?;

    let mut markdown: Option<String> = None;
    let mut json_content: Option<String> = None;
    let mut content_list_json: Option<String> = None;
    let mut extracted_images: Vec<(String, Vec<u8>)> = Vec::new();

    eprintln!("[SKB] MinerU ZIP contains {} entries:", archive.len());
    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| AppError::MinerU(format!("Failed to read ZIP entry: {}", e)))?;

        let name = file.name().to_string();
        let name_lower = name.to_lowercase();
        let size = file.size();
        eprintln!("[SKB]   ZIP[{i}]: {name} ({size} bytes)");

        if name_lower.ends_with("full.md") || name_lower == "full.md" {
            let mut content = String::new();
            use std::io::Read;
            file.read_to_string(&mut content)
                .map_err(|e| AppError::MinerU(format!("Failed to read markdown: {}", e)))?;
            let chars = content.len();
            markdown = Some(content);
            eprintln!("[SKB]   -> extracted full.md ({chars} chars)");
        } else if name_lower.ends_with(".json") {
            let mut content = String::new();
            use std::io::Read;
            match file.read_to_string(&mut content) {
                Ok(_) => {
                    let has_pdf_info = content.contains("\"pdf_info\"");
                    let has_page_idx = content.contains("\"page_idx\"");
                    let is_layout = name_lower.contains("layout");
                    eprintln!("[SKB]   -> read JSON ({}.chars), is_layout={is_layout}, has_pdf_info={has_pdf_info}, has_page_idx={has_page_idx}", content.len());
                    if has_pdf_info {
                        json_content = Some(content);
                    } else if has_page_idx && content.contains("\"type\"") {
                        // content_list.json: each block has page_idx + type
                        content_list_json = Some(content);
                        eprintln!("[SKB]   -> identified as content_list.json");
                    }
                }
                Err(e) => {
                    eprintln!("[SKB]   -> failed to read JSON: {e}");
                }
            }
        } else {
            // Check for image files
            let lower = name.to_lowercase();
            let is_img = lower.ends_with(".png") || lower.ends_with(".jpg")
                || lower.ends_with(".jpeg") || lower.ends_with(".gif")
                || lower.ends_with(".bmp") || lower.ends_with(".webp");
            if is_img {
                match read_zip_bytes(&mut file) {
                    Ok(data) => {
                        let fname = std::path::Path::new(&name)
                            .file_name()
                            .map(|n| n.to_string_lossy().to_string())
                            .unwrap_or(name.clone());
                        eprintln!("[SKB]   -> extracted image: {fname} ({} bytes)", data.len());
                        extracted_images.push((fname, data));
                    }
                    Err(e) => {
                        eprintln!("[SKB]   -> failed to read image: {e}");
                    }
                }
            }
        }
    }

    match markdown {
        Some(md) => Ok(PreciseResult {
            markdown: md,
            json_content,
            content_list_json,
            extracted_images,
            raw_zip,
        }),
        None => Err(AppError::MinerU(
            "full.md not found in result archive".to_string(),
        )),
    }
}

/// Download the MinerU result ZIP with retry + friendly error classification.
/// - 404 → link expired, tell user to re-parse (no retry, retrying won't help)
/// - connect/timeout/5xx → retry with exponential backoff
async fn download_zip_with_retry(client: &Client, url: &str) -> Result<Vec<u8>, AppError> {
    const MAX_RETRIES: u32 = 3;
    let mut last_err: String = "unknown".into();

    for attempt in 0..MAX_RETRIES {
        if attempt > 0 {
            let backoff = 1u64 << (attempt - 1); // 1s, 2s
            sleep(Duration::from_secs(backoff)).await;
            eprintln!("[SKB] MinerU zip download retry {}/{}", attempt + 1, MAX_RETRIES);
        }

        match client.get(url).timeout(Duration::from_secs(300)).send().await {
            Ok(resp) => {
                let status = resp.status();
                if !status.is_success() {
                    if status.as_u16() == 404 {
                        return Err(AppError::MinerU(
                            "结果链接已过期或不存在(404),请重新解析该文档".to_string(),
                        ));
                    }
                    last_err = format!("HTTP {status}");
                    eprintln!("[SKB] MinerU zip download {status} (attempt {})", attempt + 1);
                    continue;
                }
                match resp.bytes().await {
                    Ok(b) => {
                        eprintln!(
                            "[SKB] MinerU zip downloaded {} bytes (attempt {})",
                            b.len(),
                            attempt + 1
                        );
                        return Ok(b.to_vec());
                    }
                    Err(e) => {
                        last_err = format!("读取响应体失败: {e}");
                        eprintln!(
                            "[SKB] MinerU zip bytes error: {e} (attempt {})",
                            attempt + 1
                        );
                    }
                }
            }
            Err(e) => {
                let kind = if e.is_timeout() {
                    "超时"
                } else if e.is_connect() {
                    "连接失败"
                } else {
                    "请求失败"
                };
                let mut chain = format!("{e}");
                let mut src = std::error::Error::source(&e);
                while let Some(s) = src {
                    chain.push_str(&format!(" → {s}"));
                    src = s.source();
                }
                last_err = format!("{kind}: {chain}");
                eprintln!(
                    "[SKB] MinerU zip download {kind}: {chain} (attempt {})",
                    attempt + 1
                );
            }
        }
    }

    // reqwest 全部失败 — fallback 到系统 curl(绕过 rustls/native-tls 的 TLS 握手兼容性问题,
    // 某些本地网络/中间盒会阻断 reqwest 的 ClientHello 但放行 curl/schannel 的)
    eprintln!("[SKB] reqwest 下载失败({last_err}),尝试 curl fallback");
    match download_zip_via_curl(url).await {
        Ok(bytes) => Ok(bytes),
        Err(curl_err) => Err(AppError::MinerU(format!(
            "结果下载失败: reqwest({last_err}); curl fallback({curl_err})。可能是本地网络对 CDN 的 TLS 兼容性问题,请检查网络或稍后重试。"
        ))),
    }
}

/// Fallback: 用系统 curl 下载 zip,绕过 reqwest TLS 后端的握手兼容性问题。
/// curl 在 Windows 用 Schannel,对某些 CDN/中间盒的 TLS 兼容性更好。
/// Windows 10 1803+ 自带 curl;macOS/Linux 通常也有。
async fn download_zip_via_curl(url: &str) -> Result<Vec<u8>, AppError> {
    let output = tokio::process::Command::new("curl")
        .arg("--ssl-no-revoke")
        .arg("-sSL")
        .arg("--fail")
        .arg("--max-time")
        .arg("300")
        .arg(url)
        .output()
        .await
        .map_err(|e| AppError::MinerU(format!("curl 启动失败(系统可能未安装 curl): {e}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let code = output.status.code().unwrap_or(-1);
        // curl 退出码 22 = HTTP 错误(如 404 链接过期)
        if code == 22 {
            return Err(AppError::MinerU(
                "结果链接已过期或不存在(404),请重新解析该文档".to_string(),
            ));
        }
        return Err(AppError::MinerU(format!(
            "curl 退出码 {code}: {}",
            stderr.trim()
        )));
    }

    if output.stdout.is_empty() {
        return Err(AppError::MinerU("curl 返回空数据".to_string()));
    }

    eprintln!(
        "[SKB] curl fallback 下载 {} bytes",
        output.stdout.len()
    );
    Ok(output.stdout)
}

fn read_zip_bytes(file: &mut zip::read::ZipFile) -> Result<Vec<u8>, std::io::Error> {
    use std::io::Read;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf)?;
    Ok(buf)
}

/// Parse a local MinerU ZIP bundle (dev-mode replay).
/// Extracts markdown, JSON, and images directly from the file.
pub fn parse_local_zip(path: &std::path::Path) -> Result<PreciseResult, AppError> {
    let file = std::fs::File::open(path)
        .map_err(|e| AppError::MinerU(format!("Cannot open ZIP: {}", e)))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| AppError::MinerU(format!("Failed to open ZIP: {}", e)))?;

    let mut markdown: Option<String> = None;
    let mut json_content: Option<String> = None;
    let mut content_list_json: Option<String> = None;
    let mut extracted_images: Vec<(String, Vec<u8>)> = Vec::new();

    let zip_data = std::fs::read(path).unwrap_or_default();

    for i in 0..archive.len() {
        let mut file = archive.by_index(i)
            .map_err(|e| AppError::MinerU(format!("Failed to read ZIP entry: {}", e)))?;
        let name = file.name().to_string();
        let name_lower = name.to_lowercase();

        if name_lower.ends_with("full.md") || name_lower == "full.md" {
            let mut content = String::new();
            use std::io::Read;
            file.read_to_string(&mut content)
                .map_err(|e| AppError::MinerU(format!("Failed to read markdown: {}", e)))?;
            markdown = Some(content);
        } else if name_lower.ends_with(".json") {
            let mut content = String::new();
            use std::io::Read;
            match file.read_to_string(&mut content) {
                Ok(_) => {
                    if content.contains("\"pdf_info\"") {
                        json_content = Some(content);
                    } else if content.contains("\"page_idx\"") && content.contains("\"type\"") {
                        content_list_json = Some(content);
                    }
                }
                Err(_) => {}
            }
        } else {
            let lower = name.to_lowercase();
            let is_img = lower.ends_with(".png") || lower.ends_with(".jpg")
                || lower.ends_with(".jpeg") || lower.ends_with(".gif")
                || lower.ends_with(".bmp") || lower.ends_with(".webp");
            if is_img {
                if let Ok(data) = read_zip_bytes(&mut file) {
                    let fname = std::path::Path::new(&name)
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or(name.clone());
                    extracted_images.push((fname, data));
                }
            }
        }
    }

    match markdown {
        Some(md) => Ok(PreciseResult {
            markdown: md,
            json_content,
            content_list_json,
            extracted_images,
            raw_zip: zip_data,
        }),
        None => Err(AppError::MinerU("full.md not found in ZIP".to_string())),
    }
}
