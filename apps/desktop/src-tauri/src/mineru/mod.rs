pub mod precise;

use crate::error::AppError;
use std::path::PathBuf;

/// Which MinerU parse mode to use
pub enum ParseMode {
    /// Precise mode: uses v4/file-urls/batch with token auth, supports up to 200MB/200 pages
    Precise {
        token: String,
        file_path: PathBuf,
    },
}

/// Parse a document using the MinerU Precise API.
/// Returns the parsed markdown content.
pub async fn parse_document(mode: ParseMode) -> Result<String, AppError> {
    match mode {
        ParseMode::Precise { token, file_path } => {
            precise::parse_with_precise(&token, &file_path).await
        }
    }
}
