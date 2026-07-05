# SKB — Super Knowledge Base

A local-first desktop knowledge base for AI agents. Built with **Tauri v2 + React + Python**, supports **OpenAI-compatible & local (llama.cpp) embedding/rerank models**, **MinerU document parsing**, ships with an **MCP server** for Claude Code, and includes an **LLM Chat (RAG)** module.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-v2-orange)](https://tauri.app/)
[![Python](https://img.shields.io/badge/Python-3.11+-green)](https://python.org)
[![README](https://img.shields.io/badge/README-中文-red)](README_CN.md)

## Features

### Document Management
- **Multi-format**: PDF, DOCX, PPTX, XLSX, images, HTML, Markdown, plain text
- **Auto pipeline**: Upload → MinerU Precise parse → chunk → embed → index — fully automatic with progress tracking
- **Progress display**: MinerU parse progress (real-time), indexing progress (chunking → VLM → embedding → storing) with percentage
- **Split documents**: Large PDFs (>200 pages) auto-split into manageable parts, grouped under parent in file tree
- **File manager**: Explorer-style with folder tree, rename, move, delete, open original file
- **Markdown preview**: Full rendering with LaTeX math (KaTeX), HTML table math, section lazy loading
- **Document TOC**: Collapsible sidebar with heading tree, linear page bar, page jump input — bidirectional scroll sync
- **Image gallery**: Thumbnail grid/list views, full-size dialog with prev/next, editable AI descriptions, VLM re-analyze
- **Document editing**: Edit parsed Markdown, auto re-index on save
- **Smart Back button**: Navigates back to wherever you came from (chat, KB, search)

### Knowledge Management
- **Multiple KBs** with independent indexes, dashboard statistics bar
- **Display modes**: Card, Grid, Compact — with sorting and pin-to-top
- **Hybrid search**: Dense vector + Chinese bigram keyword (FTS) + reranking, keyword-first strategy
- **In-document search**: Search within a single document from the preview page
- **Global search**: Search all KBs from the Dashboard

### AI Model Integration
- **Cloud APIs (OpenAI-compatible)**: OpenAI, Ollama, vLLM, LiteLLM, DashScope — any `/v1/embeddings` or `/rerank` endpoint
- **Local models (llama.cpp)**: Built-in CPU inference via llama-server. Bundled with Qwen3-Embedding & Qwen3-Reranker GGUF models. Users can bring any GGUF file
- **Independent toggles**: Embedding and rerank can use local or cloud models independently
- **VLM (Vision Language Model)**: AI-powered image descriptions during indexing with configurable concurrency (1-20), caching to skip already-described images on re-index, and toggle on/off
- **Test Connection** buttons for Embedding, Rerank, LLM, and VLM

### LLM Chat (RAG)
- Built-in chat module with multi-conversation support, persisted to data directory
- **Tool calling**: LLM actively searches KBs, lists documents, reads content, fetches chunks by index
- **Web search**: Free DuckDuckGo integration (no API key) with Tavily/SearXNG options; Jina proxy fallback for reliability
- **SSE streaming with instant rendering**: Streamdown (Vercel) — incremental markdown/LaTeX/math parsing during streaming, no OOM from full re-render
- **Deferred persistence**: Disk writes skipped during streaming (only on completion) — eliminates I/O jank
- **Multi-KB selection**: Search across multiple KBs with access isolation; uncheck all → KB tools disabled
- **Citations**: Inline `[N]` badges and `[M-N]` range badges — click to preview source chunks with prev/next navigation and "View full document" button
- **Thinking block**: Collapsible reasoning display (DeepSeek-R1 etc.) — auto-scroll during streaming, auto-collapse when done
- **Image references**: LLM can reference document images — rendered as clickable thumbnails with full-screen preview
- **Conversation actions**: Rename, delete (from sidebar & popover), regenerate, copy messages
- **Tab system**: Multi-tab support in the desktop app — chat tabs, document tabs, KB tabs with keyboard shortcuts and "reopen closed tab"
- Code block copy, math rendering (KaTeX), auto-scroll toggle
- **Sidebar popover**: When sidebar is collapsed, click Chat icon → floating panel with conversation history, new conversation, and per-item delete

### MCP Server
20 tools for AI agents — single executable, requires the app running (or minimized to tray).
Search results and chunks include `content_type` (`text`, `image`, `table`, `equation`) for content-aware rendering.

| Tool | Description |
|------|-------------|
| `search_knowledge_base` | Hybrid search with reranking, optional context window. Results include `content_type` |
| `search_all_knowledge_bases` | Global search across all KBs without specifying a target |
| `search_document` | Search within a single document — precise, no KB-wide noise |
| `list_knowledge_bases` | List all KBs with stats, detect orphaned data |
| `list_documents` | List all documents in a KB with metadata |
| `get_document` | Document content with `max_chars` truncation safeguard |
| `get_document_summary` | Structured summary: metadata + heading outline + first/last chunk previews |
| `get_document_chunks` | Get document chunks with `limit` param (N=first N, -N=last N, 0=all). Includes `content_type` |
| `get_chunk_by_index` | Fetch a single chunk by doc_id + chunk_index. Includes `content_type` |
| `get_chunks_by_page` | Fetch all chunks on a specific page of a document |
| `read_document_image` | Read a document's extracted image — returns absolute file path for inline display |
| `create_knowledge_base` | Create a new KB |
| `delete_knowledge_base` | Delete a KB and all its data |
| `rename_knowledge_base` | Rename a KB and update description |
| `add_document` | Import text or parse files (PDF/DOCX/PPTX/XLSX/images/HTML) |
| `delete_document` | Delete a document and its chunks |
| `rename_document` | Rename a document |
| `move_document` | Move a document to a folder path |
| `list_folders` | List all folder paths in a KB |
| `clean_orphans` | Clean orphaned data: stale LanceDB tables, docs without content, orphan chunks, kb_id mismatches, .bak files |

### Desktop UI
- Custom frameless window with dark/light/system theme
- English/Chinese localization, built-in user guide
- **System tray** — close to tray, backend stays alive for MCP
- **Single instance** — launching the app again brings existing window to front
- **Collapsible sidebar**: KB list + conversations with floating popover when collapsed
- **Tab system**: Multi-tab with close-to-right, close-others, reopen-closed, keyboard navigation (Ctrl+Tab / Ctrl+Shift+Tab)
- **Settings**: Collapsible card sections with sticky Save button, test connection buttons for all API configs, clean orphans with detailed feedback
- **Data management**: KB ZIP import/export, settings.json import/export, one-click orphan cleanup

## Quick Start

### Prerequisites
- **Node.js** ≥ 18, **Rust** ≥ 1.75, **Python** ≥ 3.11, **uv** (Python package manager)

### Install & Run

```bash
git clone https://github.com/1617110693/Local-Agent-Knowledge-Base.git
cd super-knowledge-base
npm install
cd services/python-backend && uv sync && cd ../..
npm run tauri dev
```

### First Launch
The user guide opens automatically on first launch. Core steps:
1. **Settings** → configure Embedding API and MinerU Token (required), optionally Rerank and LLM APIs
2. Create a **Knowledge Base** → upload documents
3. Search via the UI, or connect Claude Code via MCP
4. Configure LLM API → open Chat in the sidebar for RAG-powered Q&A
5. (Optional) Enable **Local Models** for offline embedding/reranking via llama.cpp

## MCP Server Setup

Open the app → Settings → click **"Configure Claude Code MCP"** to auto-generate the config.

**Dev mode** (auto-detected):
```json
{
  "mcpServers": {
    "skb": {
      "command": "uv",
      "args": ["run", "--directory", "/path/to/services/python-backend", "knowledge-backend", "mcp"],
      "env": { "KNOWLEDGE_BASE_DATA_DIR": "~/.super-knowledge-base" }
    }
  }
}
```

> The app must be running (or minimized to tray) for MCP to work. API keys are read from `settings.json`.

## Technology Stack

| Layer | Technology |
|-------|-----------|
| Desktop | Tauri v2 (Rust) |
| Frontend | React 18 + TypeScript + Vite + Tailwind CSS |
| Backend | FastAPI + FastMCP (Python) |
| Local Models | llama.cpp (CPU inference) |
| Vector DB | LanceDB (embedded) |
| Doc Parsing | MinerU API (Precise mode) |
| Streaming Markdown | Streamdown (Vercel) + @streamdown/math + @streamdown/cjk |
| Math Rendering | KaTeX + rehype-katex + remark-math |

## Project Structure

```
super-knowledge-base/
├── apps/desktop/                  # Tauri v2 + React app
│   ├── src-tauri/                 # Rust backend + llama.cpp binaries + http/fs/shell/dialog/store plugins
│   └── src/                       # React frontend (Chat, Documents, Search, Settings, Sidebar)
├── services/python-backend/       # Python backend (REST API + MCP in one executable)
├── models/                        # GGUF models for local inference
└── scripts/                       # Build & release scripts
```

## Data Storage

All data stored locally at `~/.super-knowledge-base/`:

```
~/.super-knowledge-base/
├── settings.json                  # App configuration
├── knowledge_bases.json           # KB registry
├── chat_conversations.json        # LLM chat history
├── kb_{uuid}/                     # Knowledge base
│   └── docs/{doc_id}/             # Document (metadata.json + full.md)
└── lancedb_data/                  # Vector indexes
```

## License

MIT © 2026 SKB Contributors
