use serde::{Deserialize, Serialize};
use std::path::Path;

fn default_llama_port() -> u16 { 8081 }
fn default_llama_threads() -> u32 { 4 }

/// Application settings persisted to disk
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    pub data_dir: String,
    pub mineru_token: String,
    pub embedding_api_base: String,
    pub embedding_api_key: String,
    pub embedding_model: String,
    pub rerank_api_base: String,
    pub rerank_api_key: String,
    pub rerank_model: String,
    #[serde(default)]
    pub llm_api_base: String,
    #[serde(default)]
    pub llm_api_key: String,
    #[serde(default)]
    pub llm_model: String,
    #[serde(default)]
    pub use_local_embedding: bool,
    #[serde(default)]
    pub local_embedding_model: String,
    #[serde(default)]
    pub use_local_rerank: bool,
    #[serde(default)]
    pub local_rerank_model: String,
    #[serde(default = "default_llama_port")]
    pub llama_port: u16,
    #[serde(default = "default_llama_threads")]
    pub llama_threads: u32,
    pub chunk_strategy: String,
    pub chunk_size: u32,
    pub chunk_overlap: u32,
    pub python_port: u16,
    pub theme: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            data_dir: String::new(),
            mineru_token: String::new(),
            embedding_api_base: "https://api.openai.com/v1".to_string(),
            embedding_api_key: String::new(),
            embedding_model: "text-embedding-3-small".to_string(),
            rerank_api_base: "https://api.jina.ai/v1".to_string(),
            rerank_api_key: String::new(),
            rerank_model: "jina-reranker-v2-base-multilingual".to_string(),
            llm_api_base: "https://api.openai.com/v1".to_string(),
            llm_api_key: String::new(),
            llm_model: "gpt-4o-mini".to_string(),
            use_local_embedding: false,
            local_embedding_model: String::new(),
            use_local_rerank: false,
            local_rerank_model: String::new(),
            llama_port: 8081,
            llama_threads: 4,
            chunk_strategy: "recursive".to_string(),
            chunk_size: 512,
            chunk_overlap: 50,
            python_port: 17390,
            theme: "system".to_string(),
        }
    }
}

impl AppSettings {
    /// Load settings from the app data directory
    pub fn load(app_data_dir: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        let path = app_data_dir.join("settings.json");
        if path.exists() {
            let data = std::fs::read_to_string(&path)?;
            let settings: AppSettings = serde_json::from_str(&data)?;
            Ok(settings)
        } else {
            let settings = AppSettings::default();
            settings.save(app_data_dir)?;
            Ok(settings)
        }
    }

    /// Save settings to the app data directory
    pub fn save(&self, app_data_dir: &Path) -> Result<(), Box<dyn std::error::Error>> {
        let path = app_data_dir.join("settings.json");
        let data = serde_json::to_string_pretty(self)?;
        std::fs::write(&path, data)?;
        Ok(())
    }
}
