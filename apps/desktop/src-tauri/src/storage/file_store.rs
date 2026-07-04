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
            pinned: false,
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
            pinned: false,
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

    pub fn clear_all_kbs(&self) -> CommandResult<u32> {
        let registry = self.load_registry()?;
        let count = registry.knowledge_bases.len() as u32;

        for kb in &registry.knowledge_bases {
            // Delete KB document directory
            let kb_dir = self.root_dir.join(format!("kb_{}", kb.id));
            if kb_dir.exists() {
                std::fs::remove_dir_all(&kb_dir)?;
            }
            // Delete LanceDB vector table
            let lance_table = self
                .root_dir
                .join("lancedb_data")
                .join(format!("kb_{}.lance", kb.id.replace('-', "_")));
            if lance_table.exists() {
                std::fs::remove_dir_all(&lance_table)?;
            }
        }

        // Wipe registry
        self.save_registry(&KnowledgeBaseRegistry::default())?;

        Ok(count)
    }

    pub fn export_kbs(&self, kb_ids: &[String], output_path: &str) -> CommandResult<String> {
        use std::io::Write;
        let registry = self.load_registry()?;

        let selected: Vec<&KnowledgeBase> = registry
            .knowledge_bases
            .iter()
            .filter(|kb| kb_ids.contains(&kb.id))
            .collect();

        if selected.is_empty() {
            return Err(AppError::InvalidInput("No knowledge bases selected".into()));
        }

        let file = std::fs::File::create(output_path)?;
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);

        // Export selected KB registry subset
        let export_registry = crate::models::KnowledgeBaseRegistry {
            version: 1,
            knowledge_bases: selected.iter().map(|k| (*k).clone()).collect(),
        };
        let reg_json = serde_json::to_string_pretty(&export_registry)?;
        zip.start_file("knowledge_bases.json", options)?;
        zip.write_all(reg_json.as_bytes())?;

        let root = self.root_dir.clone();
        fn add_dir(
            zip: &mut zip::ZipWriter<std::fs::File>,
            dir: &std::path::Path,
            root: &std::path::Path,
            options: zip::write::SimpleFileOptions,
        ) -> Result<(), Box<dyn std::error::Error>> {
            if !dir.exists() { return Ok(()); }
            for entry in std::fs::read_dir(dir)? {
                let entry = entry?;
                let path = entry.path();
                if path.is_file() {
                    let rel = path.strip_prefix(root)
                        .unwrap_or(&path)
                        .to_string_lossy()
                        .replace('\\', "/");
                    zip.start_file(&rel, options)?;
                    std::io::copy(&mut std::fs::File::open(&path)?, zip)?;
                } else if path.is_dir() {
                    add_dir(zip, &path, root, options)?;
                }
            }
            Ok(())
        }

        for kb in &selected {
            let kb_dir = root.join(format!("kb_{}", kb.id));
            add_dir(&mut zip, &kb_dir, &root, options)?;

            let lance_table = root
                .join("lancedb_data")
                .join(format!("kb_{}.lance", kb.id.replace('-', "_")));
            add_dir(&mut zip, &lance_table, &root, options)?;
        }

        zip.finish()?;
        Ok(output_path.to_string())
    }

    pub fn import_kbs(&self, zip_path: &str) -> CommandResult<u32> {
        let file = std::fs::File::open(zip_path)?;
        let mut archive = zip::ZipArchive::new(file)?;

        // First, read the manifest
        let mut export_registry: Option<crate::models::KnowledgeBaseRegistry> = None;
        for i in 0..archive.len() {
            let entry = archive.by_index(i)?;
            if entry.name() == "knowledge_bases.json" {
                let data = std::io::read_to_string(entry)?;
                export_registry = Some(serde_json::from_str(&data)?);
                break;
            }
        }

        let export_registry = export_registry
            .ok_or_else(|| AppError::InvalidInput("ZIP missing knowledge_bases.json".into()))?;

        // Generate new IDs to avoid conflicts
        let mut id_map: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        let mut new_kbs = Vec::new();
        for kb in &export_registry.knowledge_bases {
            let new_id = uuid::Uuid::new_v4().to_string();
            id_map.insert(kb.id.clone(), new_id.clone());
            let mut new_kb = kb.clone();
            new_kb.id = new_id;
            new_kbs.push(new_kb);
        }

        // Extract files, remapping paths with new IDs
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i)?;
            let name = entry.name().to_string();
            if name == "knowledge_bases.json" {
                continue;
            }

            let mut out_path = self.root_dir.clone();
            // Remap kb directory names
            let mut resolved = name.clone();
            for (old_id, new_id) in &id_map {
                let old_kb_dir = format!("kb_{}", old_id);
                let new_kb_dir = format!("kb_{}", new_id);
                if resolved.starts_with(&old_kb_dir) {
                    resolved = resolved.replacen(&old_kb_dir, &new_kb_dir, 1);
                }
                // Also remap LanceDB table names
                let old_lance = format!("lancedb_data/kb_{}.lance", old_id.replace('-', "_"));
                let new_lance = format!("lancedb_data/kb_{}.lance", new_id.replace('-', "_"));
                if resolved.starts_with(&old_lance) {
                    resolved = resolved.replacen(&old_lance, &new_lance, 1);
                }
            }
            out_path.push(&resolved);

            if entry.is_dir() {
                std::fs::create_dir_all(&out_path)?;
            } else {
                if let Some(parent) = out_path.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                let mut outfile = std::fs::File::create(&out_path)?;
                std::io::copy(&mut entry, &mut outfile)?;
            }
        }

        // Merge into registry
        let mut registry = self.load_registry()?;
        let count = new_kbs.len() as u32;
        registry.knowledge_bases.extend(new_kbs);
        self.save_registry(&registry)?;

        Ok(count)
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

    pub fn toggle_pin_kb(&self, kb_id: &str) -> CommandResult<Vec<KnowledgeBase>> {
        let mut registry = self.load_registry()?;

        // Toggle pinned flag
        let mut target_pinned = false;
        for kb in &mut registry.knowledge_bases {
            if kb.id == kb_id {
                kb.pinned = !kb.pinned;
                target_pinned = kb.pinned;
                break;
            }
        }

        // Re-sort: pinned KBs first, then unpinned (preserving relative order within each group)
        let mut kbs = std::mem::take(&mut registry.knowledge_bases);
        if target_pinned {
            // Move the toggled KB to just after the last already-pinned KB
            if let Some(pos) = kbs.iter().position(|k| k.id == kb_id) {
                let kb = kbs.remove(pos);
                let insert_pos = kbs.iter().position(|k| !k.pinned).unwrap_or(kbs.len());
                kbs.insert(insert_pos, kb);
            }
        } else {
            // Move unpinned KB to just after the pinned group
            if let Some(pos) = kbs.iter().position(|k| k.id == kb_id) {
                let kb = kbs.remove(pos);
                let insert_pos = kbs.iter().position(|k| !k.pinned).unwrap_or(kbs.len());
                kbs.insert(insert_pos, kb);
            }
        }
        registry.knowledge_bases = kbs;

        self.save_registry(&registry)?;
        Ok(registry.knowledge_bases.clone())
    }

    pub fn reorder_kbs(&self, ordered_ids: &[String]) -> CommandResult<Vec<KnowledgeBase>> {
        let mut registry = self.load_registry()?;
        let mut old_kbs = std::mem::take(&mut registry.knowledge_bases);
        let mut reordered = Vec::with_capacity(old_kbs.len());

        for id in ordered_ids {
            if let Some(pos) = old_kbs.iter().position(|k| k.id == *id) {
                reordered.push(old_kbs.remove(pos));
            }
        }
        // Append any KBs not in the ordered list (safety net)
        reordered.extend(old_kbs);
        registry.knowledge_bases = reordered;

        self.save_registry(&registry)?;
        Ok(registry.knowledge_bases.clone())
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
        parent_doc_id: Option<String>,
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
            path: None,
            parent_doc_id,
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
        // Cascade: also remove child documents (split parts)
        let children = self.get_child_documents(kb_id, doc_id).unwrap_or_default();
        let child_count = children.len() as i32;
        for child in &children {
            let child_dir = self.get_doc_dir(kb_id, &child.id);
            if child_dir.exists() {
                std::fs::remove_dir_all(&child_dir)?;
            }
        }

        let doc_dir = self.get_doc_dir(kb_id, doc_id);
        if doc_dir.exists() {
            std::fs::remove_dir_all(&doc_dir)?;
        }
        // Account for main doc + all children
        self.update_kb_after_doc_change(kb_id, -(1 + child_count), 0)?;
        Ok(())
    }

    pub fn rename_document(&self, kb_id: &str, doc_id: &str, new_name: &str) -> CommandResult<Document> {
        let mut doc = self.get_document(kb_id, doc_id)?;
        doc.name = new_name.to_string();
        doc.updated_at = Utc::now();
        self.save_document_meta(&doc)?;
        Ok(doc)
    }

    pub fn set_document_path(&self, kb_id: &str, doc_id: &str, path: Option<&str>) -> CommandResult<Document> {
        let mut doc = self.get_document(kb_id, doc_id)?;
        doc.path = path.map(|f| f.to_string());
        doc.updated_at = Utc::now();
        self.save_document_meta(&doc)?;

        // Propagate path to child documents (split parts)
        let children = self.get_child_documents(kb_id, doc_id).unwrap_or_default();
        for mut child in children {
            child.path = path.map(|f| f.to_string());
            child.updated_at = Utc::now();
            self.save_document_meta(&child)?;
        }

        Ok(doc)
    }

    // ── Folder (empty path) persistence ──

    fn folders_path(&self, kb_id: &str) -> PathBuf {
        self.get_docs_dir(kb_id).parent().unwrap().join("folders.json")
    }

    fn load_folders(&self, kb_id: &str) -> Vec<String> {
        let p = self.folders_path(kb_id);
        if !p.exists() {
            return Vec::new();
        }
        std::fs::read_to_string(&p)
            .ok()
            .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
            .unwrap_or_default()
    }

    fn save_folders(&self, kb_id: &str, folders: &[String]) -> CommandResult<()> {
        let p = self.folders_path(kb_id);
        let json = serde_json::to_string_pretty(folders)?;
        std::fs::write(&p, json)?;
        Ok(())
    }

    /// Create an empty folder path (persisted even without documents).
    pub fn create_folder(&self, kb_id: &str, path: &str) -> CommandResult<()> {
        let mut folders = self.load_folders(kb_id);
        let normalized = path.trim_matches('/').to_string();
        if normalized.is_empty() {
            return Err(AppError::InvalidInput("Folder path cannot be empty".into()));
        }
        if !folders.contains(&normalized) {
            folders.push(normalized.clone());
        }
        // Also add all parent folders
        let mut parts: Vec<&str> = Vec::new();
        for seg in normalized.split('/') {
            if !seg.is_empty() {
                parts.push(seg);
                let parent = parts.join("/");
                if !folders.contains(&parent) {
                    folders.push(parent);
                }
            }
        }
        folders.sort();
        self.save_folders(kb_id, &folders)
    }

    /// Remove a folder path from the persistent list.
    pub fn remove_folder(&self, kb_id: &str, path: &str) -> CommandResult<()> {
        let mut folders = self.load_folders(kb_id);
        let normalized = path.trim_matches('/');
        let prefix = format!("{}/", normalized);
        folders.retain(|f| f != normalized && !f.starts_with(&prefix));
        self.save_folders(kb_id, &folders)
    }

    /// Build a folder tree from document paths + persistent empty folders.
    /// Paths like "数学", "数学/线性代数" represent nested folders.
    pub fn list_paths(&self, kb_id: &str) -> CommandResult<Vec<String>> {
        let docs = self.list_documents(kb_id)?;
        let mut paths: Vec<String> = docs
            .iter()
            .filter_map(|d| d.path.clone())
            .flat_map(|p| {
                let mut all: Vec<String> = Vec::new();
                let mut parts: Vec<&str> = Vec::new();
                for segment in p.split('/') {
                    if !segment.is_empty() {
                        parts.push(segment);
                        all.push(parts.join("/"));
                    }
                }
                all
            })
            .collect();

        // Merge persistent empty folders that don't already appear from documents
        let folders = self.load_folders(kb_id);
        for f in &folders {
            if !paths.contains(f) {
                paths.push(f.clone());
            }
            // Ensure parent paths are included
            let mut parts: Vec<&str> = Vec::new();
            for seg in f.split('/') {
                if !seg.is_empty() {
                    parts.push(seg);
                    let parent = parts.join("/");
                    if !paths.contains(&parent) {
                        paths.push(parent);
                    }
                }
            }
        }

        paths.sort();
        paths.dedup();
        Ok(paths)
    }

    pub fn delete_path(&self, kb_id: &str, path: &str) -> CommandResult<u32> {
        let docs = self.list_documents(kb_id)?;
        let prefix = format!("{}/", path);
        let mut count = 0u32;
        for doc in docs {
            let matches = doc.path.as_deref() == Some(path)
                || doc.path.as_deref().map_or(false, |p| p.starts_with(&prefix));
            if matches {
                let mut d = doc;
                d.path = None;
                d.updated_at = Utc::now();
                self.save_document_meta(&d)?;
                count += 1;
            }
        }
        Ok(count)
    }

    pub fn rename_path(&self, kb_id: &str, old_path: &str, new_path: &str) -> CommandResult<u32> {
        let docs = self.list_documents(kb_id)?;
        let prefix = format!("{}/", old_path);
        let mut count = 0u32;
        for doc in docs {
            if doc.path.as_deref() == Some(old_path) {
                let mut d = doc;
                d.path = Some(new_path.to_string());
                d.updated_at = Utc::now();
                self.save_document_meta(&d)?;
                count += 1;
            } else if let Some(ref p) = doc.path {
                if p.starts_with(&prefix) {
                    let rest = p[prefix.len()..].to_string();
                    let mut d = doc;
                    d.path = Some(format!("{}/{}", new_path, rest));
                    d.updated_at = Utc::now();
                    self.save_document_meta(&d)?;
                    count += 1;
                }
            }
        }
        Ok(count)
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

    /// Get all child documents (split parts) for a given parent document
    pub fn get_child_documents(&self, kb_id: &str, parent_doc_id: &str) -> CommandResult<Vec<Document>> {
        let all_docs = self.list_documents(kb_id)?;
        Ok(all_docs
            .into_iter()
            .filter(|d| d.parent_doc_id.as_deref() == Some(parent_doc_id))
            .collect())
    }

    pub fn get_document_content(&self, kb_id: &str, doc_id: &str) -> CommandResult<crate::models::DocumentContent> {
        let doc_dir = self.get_doc_dir(kb_id, doc_id);
        let md_path = doc_dir.join("full.md");
        let (markdown, md_available) = if md_path.exists() {
            (std::fs::read_to_string(&md_path)?, true)
        } else {
            (String::new(), false)
        };

        let meta_path = doc_dir.join("parse_meta.json");
        let metadata = if meta_path.exists() {
            let data = std::fs::read_to_string(&meta_path)?;
            serde_json::from_str(&data)?
        } else {
            serde_json::json!({})
        };

        // Try to read document metadata to get the name
        let doc_meta_path = doc_dir.join("metadata.json");
        let name = if doc_meta_path.exists() {
            let data = std::fs::read_to_string(&doc_meta_path).unwrap_or_default();
            let doc: Document = serde_json::from_str(&data).unwrap_or_else(|_| Document {
                id: doc_id.to_string(),
                kb_id: "".to_string(),
                name: doc_id.to_string(),
                file_type: "".to_string(),
                file_size: 0,
                parse_status: crate::models::ParseStatus::Done,
                parse_error: None,
                chunk_count: 0,
                embedding_model: "".to_string(),
                path: None,
                parent_doc_id: None,
                created_at: chrono::Utc::now(),
                updated_at: chrono::Utc::now(),
            });
            doc.name
        } else {
            doc_id.to_string()
        };

        // Read page_offset from metadata
        let page_offset = if doc_meta_path.exists() {
            let data = std::fs::read_to_string(&doc_meta_path).unwrap_or_default();
            serde_json::from_str::<serde_json::Value>(&data)
                .ok()
                .and_then(|v| v.get("page_offset").and_then(|o| o.as_i64()))
                .unwrap_or(0) as i32
        } else {
            0
        };

        Ok(crate::models::DocumentContent {
            id: doc_id.to_string(),
            name,
            markdown,
            md_available,
            metadata,
            page_offset,
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

        // Recalculate KB total chunk count from all documents
        let total_chunks: u32 = self.list_documents(kb_id)?
            .iter()
            .map(|d| d.chunk_count)
            .sum();
        let mut registry = self.load_registry()?;
        if let Some(kb) = registry.knowledge_bases.iter_mut().find(|k| k.id == kb_id) {
            kb.chunk_count = total_chunks;
            kb.updated_at = Utc::now();
        }
        self.save_registry(&registry)?;

        Ok(doc)
    }

    /// Update just the file_size of a document (used after PDF split replaces the file).
    pub fn update_document_file_size(
        &self,
        kb_id: &str,
        doc_id: &str,
        file_size: u64,
    ) -> CommandResult<()> {
        let mut doc = self.get_document(kb_id, doc_id)?;
        doc.file_size = file_size;
        doc.updated_at = Utc::now();
        self.save_document_meta(&doc)?;
        Ok(())
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

    /// Save the MinerU result JSON (contains pdf_info with page metadata).
    pub fn save_mineru_json(
        &self,
        kb_id: &str,
        doc_id: &str,
        json_content: &str,
    ) -> CommandResult<()> {
        let json_path = self.get_doc_dir(kb_id, doc_id).join("mineru_result.json");
        std::fs::write(&json_path, json_content)?;
        Ok(())
    }

    /// List image filenames, filtered to actual images (not equation renders).
    /// Filters by images_meta.json (preferred) or content_list.json types
    /// (image/picture/chart), so formula renders like inline_math_*.png
    /// are never shown.
    pub fn list_document_images(&self, kb_id: &str, doc_id: &str) -> CommandResult<Vec<String>> {
        let img_dir = self.get_doc_dir(kb_id, doc_id).join("images");
        if !img_dir.exists() || !img_dir.is_dir() {
            return Ok(Vec::new());
        }

        // Priority 1: filter by images_meta.json (only images that were VLM-processed)
        let meta_path = self.get_doc_dir(kb_id, doc_id).join("images_meta.json");
        if meta_path.exists() {
            if let Ok(data) = std::fs::read_to_string(&meta_path) {
                if let Ok(meta) = serde_json::from_str::<serde_json::Value>(&data) {
                    if let Some(obj) = meta.as_object() {
                        let filtered: Vec<String> = std::fs::read_dir(&img_dir)?
                            .filter_map(|e| e.ok())
                            .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
                            .filter_map(|e| e.file_name().to_str().map(|s| s.to_string()))
                            .filter(|n| obj.contains_key(n))
                            .collect();
                        if !filtered.is_empty() {
                            return Ok(filtered);
                        }
                    }
                }
            }
        }

        // Priority 2: filter by content_list.json image/picture/chart types
        let cl_path = self.get_doc_dir(kb_id, doc_id).join("content_list.json");
        if cl_path.exists() {
            if let Ok(data) = std::fs::read_to_string(&cl_path) {
                if let Ok(items) = serde_json::from_str::<Vec<serde_json::Value>>(&data) {
                    let real_images: std::collections::HashSet<String> = items.iter()
                        .filter_map(|item| {
                            let itype = item.get("type")?.as_str()?;
                            if !matches!(itype, "image" | "picture" | "chart") {
                                return None;
                            }
                            let img_path = item.get("img_path")?.as_str()?;
                            // Extract just the filename from the path
                            img_path.rsplit('/').next()
                                .or_else(|| img_path.rsplit('\\').next())
                                .map(|s| s.to_string())
                        })
                        .collect();
                    if !real_images.is_empty() {
                        let filtered: Vec<String> = std::fs::read_dir(&img_dir)?
                            .filter_map(|e| e.ok())
                            .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
                            .filter_map(|e| e.file_name().to_str().map(|s| s.to_string()))
                            .filter(|n| real_images.contains(n))
                            .collect();
                        if !filtered.is_empty() {
                            return Ok(filtered);
                        }
                    }
                }
            }
        }

        // Last resort: return empty (better than showing formula images)
        Ok(Vec::new())
    }

    /// Read an image file from the document's images directory.
    pub fn read_document_image(&self, kb_id: &str, doc_id: &str, filename: &str) -> CommandResult<Vec<u8>> {
        let path = self.get_doc_dir(kb_id, doc_id).join("images").join(filename);
        if !path.exists() { return Err(crate::error::AppError::InvalidInput("Image not found".into())); }
        Ok(std::fs::read(&path)?)
    }

    /// Get image metadata from images_meta.json, falling back to defaults.
    pub fn get_image_meta(&self, kb_id: &str, doc_id: &str) -> CommandResult<serde_json::Value> {
        let path = self.get_doc_dir(kb_id, doc_id).join("images_meta.json");
        if path.exists() {
            let data = std::fs::read_to_string(&path)?;
            Ok(serde_json::from_str(&data).unwrap_or(serde_json::json!({})))
        } else {
            Ok(serde_json::json!({}))
        }
    }

    /// Save description for a single image in images_meta.json.
    pub fn save_image_desc(&self, kb_id: &str, doc_id: &str, filename: &str, description: &str) -> CommandResult<()> {
        let path = self.get_doc_dir(kb_id, doc_id).join("images_meta.json");
        let mut meta: serde_json::Value = if path.exists() {
            let data = std::fs::read_to_string(&path)?;
            serde_json::from_str(&data).unwrap_or(serde_json::json!({}))
        } else {
            serde_json::json!({})
        };
        if let Some(obj) = meta.as_object_mut() {
            let entry = obj.entry(filename.to_string()).or_insert(serde_json::json!({}));
            entry["description"] = serde_json::Value::String(description.to_string());
            entry["edited_at"] = serde_json::Value::String(chrono::Utc::now().to_rfc3339());
        }
        std::fs::write(&path, serde_json::to_string_pretty(&meta)?)?;
        Ok(())
    }

    /// Save raw MinerU ZIP for dev-mode caching.
    pub fn save_mineru_zip(&self, kb_id: &str, doc_id: &str, data: &[u8]) -> CommandResult<()> {
        let path = self.get_doc_dir(kb_id, doc_id).join("mineru_bundle.zip");
        std::fs::write(&path, data)?;
        Ok(())
    }

    /// Save images extracted from MinerU ZIP.
    pub fn save_images(
        &self,
        kb_id: &str,
        doc_id: &str,
        images: &[(String, Vec<u8>)],
    ) -> CommandResult<()> {
        if images.is_empty() { return Ok(()); }
        let img_dir = self.get_doc_dir(kb_id, doc_id).join("images");
        std::fs::create_dir_all(&img_dir)?;
        for (name, data) in images {
            std::fs::write(img_dir.join(name), data)?;
        }
        Ok(())
    }

    /// Save the MinerU content_list.json (each block has page_idx + type).
    pub fn save_content_list_json(
        &self,
        kb_id: &str,
        doc_id: &str,
        content: &str,
    ) -> CommandResult<()> {
        let path = self.get_doc_dir(kb_id, doc_id).join("content_list.json");
        std::fs::write(&path, content)?;
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
