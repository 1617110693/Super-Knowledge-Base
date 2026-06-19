pub mod settings;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Knowledge base metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeBase {
    pub id: String,
    pub name: String,
    pub description: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub document_count: u32,
    pub chunk_count: u32,
    pub embedding_model: String,
    pub embedding_dim: u32,
}

/// Document metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Document {
    pub id: String,
    pub kb_id: String,
    pub name: String,
    pub file_type: String,
    pub file_size: u64,
    pub parse_status: ParseStatus,
    pub parse_error: Option<String>,
    pub chunk_count: u32,
    #[serde(default)]
    pub embedding_model: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ParseStatus {
    Pending,
    Parsing,
    Done,
    Failed,
}

/// Document content with parsed markdown
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentContent {
    pub id: String,
    pub markdown: String,
    pub metadata: serde_json::Value,
}

/// MinerU parse task info
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParseTask {
    pub task_id: String,
    pub state: ParseTaskState,
    pub progress: Option<ParseProgress>,
    pub full_zip_url: Option<String>,
    pub err_msg: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ParseTaskState {
    Pending,
    Running,
    Done,
    Failed,
    Converting,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParseProgress {
    pub extracted_pages: u32,
    pub total_pages: u32,
    pub start_time: String,
}

/// Knowledge base registry stored as JSON
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeBaseRegistry {
    pub version: u32,
    pub knowledge_bases: Vec<KnowledgeBase>,
}

impl Default for KnowledgeBaseRegistry {
    fn default() -> Self {
        Self {
            version: 1,
            knowledge_bases: Vec::new(),
        }
    }
}
