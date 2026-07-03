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
    #[serde(default)]
    pub pinned: bool,
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
    /// Optional path for folder hierarchy (e.g., "数学" or "数学/线性代数")
    #[serde(default, alias = "folder")]
    pub path: Option<String>,
    /// If this document is a split part, the ID of the parent document
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_doc_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")] // Serialize as lowercase; Deserialize is case-insensitive below
pub enum ParseStatus {
    Pending,
    Parsing,
    Done,
    Failed,
}

impl<'de> Deserialize<'de> for ParseStatus {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        match s.to_lowercase().as_str() {
            "pending" => Ok(ParseStatus::Pending),
            "parsing" => Ok(ParseStatus::Parsing),
            "done" => Ok(ParseStatus::Done),
            "failed" => Ok(ParseStatus::Failed),
            _ => Err(serde::de::Error::unknown_variant(
                &s,
                &["pending", "parsing", "done", "failed"],
            )),
        }
    }
}

/// Document content with parsed markdown
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentContent {
    pub id: String,
    pub name: String,
    pub markdown: String,
    pub md_available: bool,
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
    pub percent: u8,
    pub stage: String,
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
