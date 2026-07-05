# SKB — Super Knowledge Base

A local-first desktop knowledge base for AI agents. Built with **Tauri v2 + React + Python**, supports **OpenAI-compatible embedding & rerank models**, **MinerU document parsing**, ships with an **MCP server** for Claude Code, and includes an **LLM Chat (RAG)** module.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-v2-orange)](https://tauri.app/)
[![Python](https://img.shields.io/badge/Python-3.11+-green)](https://python.org)
[![README](https://img.shields.io/badge/README-中文-red)](README.md)

## Features

### Document Management
- **Multi-format**: PDF, DOCX, PPTX, XLSX, images, HTML, Markdown, plain text
- **Auto pipeline**: Upload → MinerU Precise parse → chunk → embed → index — fully automatic
- **Split documents**: Large PDFs (>200 pages) auto-split into manageable parts, grouped under parent in file tree
- **File manager**: Explorer-style with folder tree, rename, move, delete, open original file
- **Markdown preview**: Full rendering with LaTeX math (KaTeX), HTML table math, section lazy loading, chunk-level scroll navigation
- **Document editing**: Edit parsed Markdown, auto re-index on save

### Knowledge Management
- **Multiple KBs** with independent indexes, dashboard statistics bar
- **Display modes**: Card, Grid, Compact — with sorting and pin-to-top
- **Hybrid search**: Dense vector + Chinese bigram keyword (FTS) + reranking, keyword-first; context window for neighboring chunks; jump to chunk by index
- **Global search**: Search all KBs from the Dashboard with configurable search type and context window

### AI Model Integration (OpenAI-compatible)
- **Embedding**: OpenAI, Ollama, vLLM, LiteLLM — any `/v1/embeddings` endpoint
- **Rerank**: Jina AI, Cohere, DashScope — any compatible endpoint
- **LLM Chat**: Any OpenAI-compatible model with multi-KB RAG
- **Test Connection** buttons in Settings

### LLM Chat (RAG)
- Built-in chat module with multi-conversation support, persisted to data directory
- **Tool calling**: LLM actively searches KBs, lists documents, reads full content, and fetches chunks by index
- **Web search**: Free DuckDuckGo integration (no API key) with Tavily/SearXNG options; Jina proxy fallback
- **SSE streaming with instant rendering**: Streamdown (Vercel) — incremental markdown/LaTeX/math parsing during streaming, no OOM
- **Deferred persistence**: Disk writes skipped during streaming (only on completion) — eliminates I/O jank
- **Multi-KB selection**: Search across multiple KBs with access isolation; uncheck all → KB tools disabled
- **Citations**: Inline `[N]` badges and `[M-N]` range badges — click to preview source chunks, "View full document" navigates to chunk position
- **Thinking block**: Collapsible reasoning display (DeepSeek-R1 etc.) — auto-scroll during streaming
- **Image references**: LLM can reference document images — rendered as clickable thumbnails with full-screen preview
- **Conversation actions**: Rename, delete (from sidebar & popover), regenerate, copy messages
- **Tab system**: Multi-tab support (chat, document, KB tabs) with keyboard shortcuts and "reopen closed tab"
- Code block copy, math rendering (KaTeX), auto-scroll toggle

### MCP Server
20 tools for AI agents — single executable, requires the app running (or minimized to tray):

| Tool | Description |
|------|-------------|
| `search_knowledge_base` | Hybrid search with reranking, optional context window |
| `search_all_knowledge_bases` | Global search across all KBs without specifying a target |
| `search_document` | Search within a single document — precise, no KB-wide noise |
| `list_knowledge_bases` | List all KBs with stats, detect orphaned data |
| `list_documents` | List all documents in a KB with metadata |
| `get_document` | Document content with `max_chars` truncation safeguard |
| `get_document_summary` | Structured summary: metadata + heading outline + first/last chunk previews — no full content |
| `get_document_chunks` | Get document chunks with `limit` param (N=first N, -N=last N, 0=all) |
| `get_chunk_by_index` | Fetch a single chunk by doc_id + chunk_index |
| `create_knowledge_base` | Create a new KB |
| `delete_knowledge_base` | Delete a KB and all its data |
| `rename_knowledge_base` | Rename a KB and update description |
| `add_document` | Import text or parse files (PDF/DOCX/PPTX/XLSX/images/HTML) |
| `delete_document` | Delete a document and its chunks |
| `rename_document` | Rename a document |
| `move_document` | Move a document to a folder path |
| `list_folders` | List all folder paths in a KB |
| `clean_orphans` | Clean orphaned data (LanceDB tables, documents, backups) |

### Desktop UI
- Custom frameless window with dark/light/system theme
- English/Chinese localization, built-in user guide
- **System tray** — close to tray, backend stays alive for MCP
- **Collapsible sidebar**: KB list + conversations with floating popover when collapsed
- **Tab system**: Multi-tab management with close-to-right, close-others, reopen-closed, keyboard navigation (Ctrl+Tab / Ctrl+Shift+Tab)
- Settings with tabbed navigation (General/Models/Chat/Data), configurable tool limits
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
| Vector DB | LanceDB (embedded) |
| Doc Parsing | MinerU API (Precise mode) |
| Streaming Markdown | Streamdown (Vercel) + @streamdown/math + @streamdown/cjk |
| Math Rendering | KaTeX + rehype-katex + remark-math |

## Project Structure

```
super-knowledge-base/
├── apps/desktop/              # Tauri v2 + React app
│   ├── src-tauri/             # Rust backend + llama.cpp + http/fs/shell/dialog/store plugins
│   └── src/                   # React frontend (Chat, Documents, Search, Settings, Sidebar)
├── services/python-backend/   # Python backend (REST API + MCP in one executable)
└── scripts/                   # Build & release scripts
```

## Data Storage

All data stored locally at `~/.super-knowledge-base/`:

```
~/.super-knowledge-base/
├── settings.json              # App configuration
├── knowledge_bases.json       # KB registry
├── kb_{uuid}/                 # Knowledge base
│   └── docs/{doc_id}/         # Document (metadata.json + full.md)
└── lancedb_data/              # Vector indexes
```

## License

MIT © 2026 SKB Contributors
