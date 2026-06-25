# Local Agent Knowledge Base

A local-first desktop knowledge base for AI agents. Built with **Tauri v2 + React + Python**, supports **OpenAI-compatible embedding & rerank models**, **MinerU document parsing**, ships with an **MCP server** for Claude Code, and includes an **LLM Chat (RAG)** module in the sidebar.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-v2-orange)](https://tauri.app/)
[![Python](https://img.shields.io/badge/Python-3.11+-green)](https://python.org)
[![README](https://img.shields.io/badge/README-中文-red)](README.md)

## Features

### Document Management
- **Multi-format**: PDF, DOCX, PPTX, XLSX, images, HTML, Markdown, plain text
- **Auto pipeline**: Upload → MinerU Precise parse → chunk → embed → index — fully automatic
- **File manager**: Explorer-style with folder tree, rename, move, delete
- **Markdown preview**: Full rendering with LaTeX math (KaTeX) and lazy loading for large files
- **Document editing**: Edit parsed Markdown, auto re-index on save

### Knowledge Management
- **Multiple KBs** with independent indexes and embedding model binding
- **Display modes**: Card, Grid, Compact — with sorting and pin-to-top
- **Hybrid search**: Dense vector + Chinese bigram keyword (FTS) + reranking, keyword-first strategy
- **Global search**: Search all KBs from the Dashboard in one query
- **Export/Import**: ZIP backup with multi-select

### AI Model Integration (OpenAI-compatible)
- **Embedding**: OpenAI, Ollama, vLLM, LiteLLM — any `/v1/embeddings` endpoint
- **Rerank**: Jina AI, Cohere, DashScope (Qwen3-rerank) — any compatible endpoint
- **LLM Chat**: Any OpenAI-compatible model, with optional KB selection for RAG
- **Test Connection** buttons for each API in Settings

### LLM Chat (RAG)
- Built-in chat module in the sidebar with multi-conversation support
- **SSE streaming**: Real-time token-by-token display
- **KB selection**: Pick a knowledge base for RAG-augmented answers
- **Citations**: Responses include `[N]` markers — click to preview the source chunk
- **Conversation management**: Rename or delete conversations (hover to reveal buttons)
- **Markdown + Math**: Full Markdown rendering with KaTeX math formula support
- Persistent storage via localStorage

### MCP Server
12 tools for AI agents — runs as part of the backend, requires the app to be running (or minimized to tray):

| Tool | Description |
|------|-------------|
| `search_knowledge_base` | Hybrid search with reranking |
| `list_knowledge_bases` | List all KBs with stats, detect orphaned data |
| `get_document` | Full document content with optional chunk details |
| `get_document_chunks` | Get all chunks of a document |
| `create_knowledge_base` | Create a new KB |
| `delete_knowledge_base` | Delete a KB and all its data |
| `rename_knowledge_base` | Rename a KB and update description |
| `add_document` | Import text or parse files (PDF/DOCX/PPTX/XLSX/images/HTML) |
| `delete_document` | Delete a document and its chunks |
| `rename_document` | Rename a document |
| `move_document` | Move a document to a folder path |
| `list_folders` | List all folder paths in a KB |

### Desktop UI
- Custom frameless window with dark/light/system theme
- English/Chinese localization
- **System tray** — close to tray, backend stays alive for MCP
- **Collapsible sidebar**: KB list + Chat conversations in separate sections, centered Overview icon
- Settings panel: API keys, model parameters, chunking strategy all in one place
- **Force restart backend**: Kill old process tree and restart from Settings

## Quick Start

### Prerequisites
- **Node.js** ≥ 18, **Rust** ≥ 1.75, **Python** ≥ 3.11, **uv** (Python package manager)

### Install & Run

```bash
git clone https://github.com/1617110693/Local-Agent-Knowledge-Base.git
cd local-knowledge-base
npm install
cd services/python-backend && uv sync && cd ../..
npm run tauri dev
```

### First Launch
1. Go to **Settings** → configure Embedding API (required) and optionally Rerank API
2. Create a **Knowledge Base** → upload documents
3. Search via the UI, or connect **Claude Code** via MCP
4. Configure **LLM API** in Settings → open Chat in the sidebar to start asking questions

## MCP Server Setup

Open the app → Settings → click **"Configure Claude Code MCP"** to auto-generate the config. Or use **"Copy MCP Config"** for one-click copy.

**Dev mode** (auto-detected):
```json
{
  "mcpServers": {
    "local-knowledge-base": {
      "command": "uv",
      "args": ["run", "--directory", "/path/to/services/python-backend", "local-kb-mcp"],
      "env": { "KNOWLEDGE_BASE_DATA_DIR": "~/.local-knowledge-base" }
    }
  }
}
```

> The app must be running (or minimized to tray) for MCP to work. API keys are read from `settings.json` — no duplicate config needed.

## Technology Stack

| Layer | Technology |
|-------|-----------|
| Desktop | Tauri v2 (Rust) |
| Frontend | React 18 + TypeScript + Vite + Tailwind CSS |
| Backend | FastAPI + FastMCP (Python) |
| Vector DB | LanceDB (embedded) |
| Doc Parsing | MinerU API (Precise mode) |
| Math Rendering | KaTeX + remark-math |

## Project Structure

```
local-knowledge-base/
├── apps/desktop/              # Tauri v2 + React app
│   ├── src-tauri/             # Rust backend
│   └── src/                   # React frontend
├── services/python-backend/   # Python backend (FastAPI REST + MCP stdio server, shared codebase)
└── scripts/                   # Build & release scripts
```

## Data Storage

All data stored locally at `~/.local-knowledge-base/`:

```
~/.local-knowledge-base/
├── settings.json              # App configuration (API keys, etc.)
├── knowledge_bases.json       # KB registry
├── kb_{uuid}/                 # Knowledge base
│   └── docs/{doc_id}/         # Document (metadata.json + full.md)
└── lancedb_data/              # Vector indexes
```

## License

MIT © 2026 Local Knowledge Base Contributors
