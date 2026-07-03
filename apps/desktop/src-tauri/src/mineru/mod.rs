pub mod precise;

use crate::error::AppError;
use crate::models::ParseProgress;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

pub use precise::PreciseResult;

/// Which MinerU parse mode to use
pub enum ParseMode {
    /// Precise mode: uses v4/file-urls/batch with token auth, supports up to 200MB/200 pages
    Precise {
        token: String,
        file_path: PathBuf,
    },
    /// Local ZIP mode: extracts a pre-downloaded MinerU bundle directly
    LocalZip {
        file_path: PathBuf,
    },
}

/// Parse a document using the MinerU Precise API.
/// Returns the parsed markdown and JSON metadata.
pub async fn parse_document(
    mode: ParseMode,
    progress: Option<Arc<Mutex<ParseProgress>>>,
) -> Result<PreciseResult, AppError> {
    match mode {
        ParseMode::Precise { token, file_path } => {
            precise::parse_with_precise(&token, &file_path, progress).await
        }
        ParseMode::LocalZip { file_path } => {
            if let Some(ref p) = progress {
                let mut pg = p.lock().unwrap();
                pg.stage = "extracting".into();
                pg.percent = 50;
            }
            let result = precise::parse_local_zip(&file_path);
            if let Some(ref p) = progress {
                let mut pg = p.lock().unwrap();
                pg.stage = "done".into();
                pg.percent = 100;
            }
            result
        }
    }
}
