pub mod agent;
pub mod precise;

use crate::error::AppError;
use std::path::PathBuf;

/// Which MinerU parse mode to use
pub enum ParseMode {
    /// Precise mode: uses v4/extract/task with token auth, supports up to 200MB/200 pages
    Precise {
        token: String,
        file_path: PathBuf,
    },
    /// Agent mode: uses v1/agent/parse without auth, limited to 10MB/20 pages
    Agent {
        file_path: PathBuf,
    },
}

/// Parse a document using the appropriate MinerU API mode.
/// Returns the parsed markdown content.
pub async fn parse_document(mode: ParseMode) -> Result<String, AppError> {
    match mode {
        ParseMode::Precise { token, file_path } => {
            precise::parse_with_precise(&token, &file_path).await
        }
        ParseMode::Agent { file_path } => {
            agent::parse_with_agent(&file_path).await
        }
    }
}
