use crate::error::{AppError, CommandResult};
use crate::models::{Document, KnowledgeBase, KnowledgeBaseRegistry, ParseStatus};
use chrono::Utc;
use std::path::PathBuf;
use uuid::Uuid;

/// Manages local file storage for knowledge bases
#[derive(Debug, Clone)]
pub struct FileStore {
    root_dir: PathBuf,
}

impl FileStore {
    pub fn new(root_dir: PathBuf) -> Self {
        Self { root_dir }
    }

    // ── Knowledge Base Registry ──

    fn registry_path(&self) -> PathBuf {
        self.root_dir.join("knowledge_bases.json")
    }

    pub fn load_registry(&self) -> CommandResult<KnowledgeBaseRegistry> {
        let path = self.registry_path();
        if path.exists() {
            let data = std::fs::read_to_string(&path)?;
            let registry: KnowledgeBaseRegistry = serde_json::from_str(&data)?;
            Ok(registry)
        } else {
            Ok(KnowledgeBaseRegistry::default())
        }
    }

    pub fn save_registry(&self, registry: &KnowledgeBaseRegistry) -> CommandResult<()> {
        let path = self.registry_path();
        let data = serde_json::to_string_pretty(registry)?;
        std::fs::write(&path, data)?;
        Ok(())
    }

    // ── Knowledge Base Operations ──

    pub fn create_kb(&self, name: String, description: String) -> CommandResult<KnowledgeBase> {
        let mut registry = self.load_registry()?;
        let kb = KnowledgeBase {
            id: Uuid::new_v4().to_string(),
            name,
            description,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            document_count: 0,
            chunk_count: 0,
            embedding_model: String::new(),
            embedding_dim: 0,
        };

        // Create KB directory
        let kb_dir = self.root_dir.join(format!("kb_{}", kb.id));
        std::fs::create_dir_all(kb_dir.join("docs"))?;

        registry.knowledge_bases.push(kb.clone());
        self.save_registry(&registry)?;

        Ok(kb)
    }

    /// Update KB name and/or description.  Pass `None` to keep the current value.
    pub fn update_kb(
        &self,
        kb_id: &str,
        name: Option<String>,
        description: Option<String>,
    ) -> CommandResult<KnowledgeBase> {
        let mut registry = self.load_registry()?;
        let kb = registry
            .knowledge_bases
            .iter_mut()
            .find(|kb| kb.id == kb_id)
            .ok_or_else(|| AppError::NotFound(format!("Knowledge base not found: {}", kb_id)))?;
        if let Some(n) = name {
            kb.name = n;
        }
        if let Some(d) = description {
            kb.description = d;
        }
        kb.updated_at = Utc::now();
        let result = kb.clone();
        self.save_registry(&registry)?;
        Ok(result)
    }

    pub fn copy_kb(&self, kb_id: &str) -> CommandResult<KnowledgeBase> {
        let registry = self.load_registry()?;
        let source = registry
            .knowledge_bases
            .iter()
            .find(|kb| kb.id == kb_id)
            .ok_or_else(|| AppError::NotFound(format!("Knowledge base not found: {}", kb_id)))?
            .clone();

        let new_id = Uuid::new_v4().to_string();
        let new_kb = KnowledgeBase {
            id: new_id.clone(),
            name: format!("{} (copy)", source.name),
            description: source.description.clone(),
            created_at: Utc::now(),
            updated_at: Utc::now(),
            document_count: source.document_count,
            chunk_count: source.chunk_count,
            embedding_model: source.embedding_model.clone(),
            embedding_dim: source.embedding_dim,
        };

        let mut registry = self.load_registry()?;
        registry.knowledge_bases.push(new_kb.clone());
        self.save_registry(&registry)?;

        // Copy KB directory (documents)
        let src_dir = self.root_dir.join(format!("kb_{}", kb_id));
        let dst_dir = self.root_dir.join(format!("kb_{}", new_id));
        if src_dir.exists() {
            copy_dir_recursive(&src_dir, &dst_dir)?;
        }

        Ok(new_kb)
    }

    pub fn delete_kb(&self, kb_id: &str) -> CommandResult<()> {
        let mut registry = self.load_registry()?;
        registry.knowledge_bases.retain(|kb| kb.id != kb_id);
        self.save_registry(&registry)?;

        // Delete KB document directory
        let kb_dir = self.root_dir.join(format!("kb_{}", kb_id));
        if kb_dir.exists() {
            std::fs::remove_dir_all(&kb_dir)?;
        }

        // Delete LanceDB vector table
        let lance_table = self
            .root_dir
            .join("lancedb_data")
            .join(format!("kb_{}.lance", kb_id.replace('-', "_")));
        if lance_table.exists() {
            std::fs::remove_dir_all(&lance_table)?;
        }

        Ok(())
    }

    pub fn list_kbs(&self) -> CommandResult<Vec<KnowledgeBase>> {
        let registry = self.load_registry()?;
        Ok(registry.knowledge_bases)
    }

    pub fn get_kb(&self, kb_id: &str) -> CommandResult<KnowledgeBase> {
        let registry = self.load_registry()?;
        registry
            .knowledge_bases
            .iter()
            .find(|kb| kb.id == kb_id)
            .cloned()
            .ok_or_else(|| AppError::NotFound(format!("Knowledge base not found: {}", kb_id)))
    }

    // ── Document Operations ──

    pub fn get_kb_dir(&self, kb_id: &str) -> PathBuf {
        self.root_dir.join(format!("kb_{}", kb_id))
    }

    pub fn get_docs_dir(&self, kb_id: &str) -> PathBuf {
        self.get_kb_dir(kb_id).join("docs")
    }

    pub fn get_doc_dir(&self, kb_id: &str, doc_id: &str) -> PathBuf {
        self.get_docs_dir(kb_id).join(doc_id)
    }

    pub fn add_document(
        &self,
        kb_id: &str,
        name: String,
        file_type: String,
        file_size: u64,
    ) -> CommandResult<Document> {
        let doc = Document {
            id: Uuid::new_v4().to_string(),
            kb_id: kb_id.to_string(),
            name,
            file_type,
            file_size,
            parse_status: ParseStatus::Pending,
            parse_error: None,
            chunk_count: 0,
            embedding_model: String::new(),
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };

        // Create document directory
        let doc_dir = self.get_doc_dir(kb_id, &doc.id);
        std::fs::create_dir_all(&doc_dir)?;

        // Save document metadata
        self.save_document_meta(&doc)?;

        // Update KB registry
        self.update_kb_after_doc_change(kb_id, 1, 0)?;

        Ok(doc)
    }

    pub fn remove_document(&self, kb_id: &str, doc_id: &str) -> CommandResult<()> {
        let doc_dir = self.get_doc_dir(kb_id, doc_id);
        if doc_dir.exists() {
            std::fs::remove_dir_all(&doc_dir)?;
        }
        self.update_kb_after_doc_change(kb_id, -1, 0)?;
        Ok(())
    }

    pub fn list_documents(&self, kb_id: &str) -> CommandResult<Vec<Document>> {
        let docs_dir = self.get_docs_dir(kb_id);
        if !docs_dir.exists() {
            return Ok(Vec::new());
        }

        let mut documents = Vec::new();
        for entry in std::fs::read_dir(&docs_dir)? {
            let entry = entry?;
            if entry.file_type()?.is_dir() {
                let meta_path = entry.path().join("metadata.json");
                if meta_path.exists() {
                    match std::fs::read_to_string(&meta_path) {
                        Ok(data) => match serde_json::from_str::<Document>(&data) {
                            Ok(doc) => documents.push(doc),
                            Err(e) => {
                                eprintln!(
                                    "[WARN] Skipping document with invalid metadata.json: {} — {}",
                                    meta_path.display(),
                                    e
                                );
                            }
                        },
                        Err(e) => {
                            eprintln!(
                                "[WARN] Skipping document with unreadable metadata.json: {} — {}",
                                meta_path.display(),
                                e
                            );
                        }
                    }
                }
            }
        }
        documents.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(documents)
    }

    pub fn get_document(&self, kb_id: &str, doc_id: &str) -> CommandResult<Document> {
        let meta_path = self.get_doc_dir(kb_id, doc_id).join("metadata.json");
        if !meta_path.exists() {
            return Err(AppError::NotFound(format!(
                "Document not found: {}",
                doc_id
            )));
        }
        let data = std::fs::read_to_string(&meta_path)?;
        let doc: Document = serde_json::from_str(&data)?;
        Ok(doc)
    }

    pub fn get_document_content(&self, kb_id: &str, doc_id: &str) -> CommandResult<crate::models::DocumentContent> {
        let doc_dir = self.get_doc_dir(kb_id, doc_id);
        let md_path = doc_dir.join("full.md");
        let markdown = if md_path.exists() {
            std::fs::read_to_string(&md_path)?
        } else {
            String::from("*Document is still being parsed...*")
        };

        let meta_path = doc_dir.join("parse_meta.json");
        let metadata = if meta_path.exists() {
            let data = std::fs::read_to_string(&meta_path)?;
            serde_json::from_str(&data)?
        } else {
            serde_json::json!({})
        };

        Ok(crate::models::DocumentContent {
            id: doc_id.to_string(),
            markdown,
            metadata,
        })
    }

    pub fn update_document_status(
        &self,
        kb_id: &str,
        doc_id: &str,
        status: ParseStatus,
        error: Option<String>,
    ) -> CommandResult<Document> {
        let mut doc = self.get_document(kb_id, doc_id)?;
        doc.parse_status = status;
        doc.parse_error = error;
        doc.updated_at = Utc::now();
        self.save_document_meta(&doc)?;
        Ok(doc)
    }

    pub fn update_document_chunks(
        &self,
        kb_id: &str,
        doc_id: &str,
        chunk_count: u32,
        embedding_model: String,
    ) -> CommandResult<Document> {
        let mut doc = self.get_document(kb_id, doc_id)?;
        doc.chunk_count = chunk_count;
        doc.embedding_model = embedding_model;
        doc.updated_at = Utc::now();
        self.save_document_meta(&doc)?;
        Ok(doc)
    }

    pub fn save_parsed_markdown(
        &self,
        kb_id: &str,
        doc_id: &str,
        markdown: &str,
    ) -> CommandResult<()> {
        let md_path = self.get_doc_dir(kb_id, doc_id).join("full.md");
        std::fs::write(&md_path, markdown)?;
        Ok(())
    }

    pub fn save_document_meta(&self, doc: &Document) -> CommandResult<()> {
        let meta_path = self.get_doc_dir(&doc.kb_id, &doc.id).join("metadata.json");
        let data = serde_json::to_string_pretty(doc)?;
        std::fs::write(&meta_path, data)?;
        Ok(())
    }

    // ── Helpers ──

    fn update_kb_after_doc_change(
        &self,
        kb_id: &str,
        doc_delta: i32,
        chunk_delta: i32,
    ) -> CommandResult<()> {
        let mut registry = self.load_registry()?;
        if let Some(kb) = registry.knowledge_bases.iter_mut().find(|k| k.id == kb_id) {
            kb.document_count = (kb.document_count as i32 + doc_delta).max(0) as u32;
            kb.chunk_count = (kb.chunk_count as i32 + chunk_delta).max(0) as u32;
            kb.updated_at = Utc::now();
        }
        self.save_registry(&registry)?;
        Ok(())
    }

    pub fn update_kb_embedding(
        &self,
        kb_id: &str,
        embedding_model: &str,
        embedding_dim: u32,
    ) -> CommandResult<()> {
        let mut registry = self.load_registry()?;
        if let Some(kb) = registry.knowledge_bases.iter_mut().find(|k| k.id == kb_id) {
            kb.embedding_model = embedding_model.to_string();
            kb.embedding_dim = embedding_dim;
            kb.updated_at = Utc::now();
        }
        self.save_registry(&registry)?;
        Ok(())
    }

    /// Get the LanceDB data directory
    pub fn get_lancedb_dir(&self) -> PathBuf {
        self.root_dir.join("lancedb_data")
    }

    /// Get a reference to the root directory
    pub fn root_dir(&self) -> &PathBuf {
        &self.root_dir
    }
}

fn copy_dir_recursive(src: &PathBuf, dst: &PathBuf) -> CommandResult<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            std::fs::copy(&src_path, &dst_path)?;
        }
    }
    Ok(())
}
