# SKB — Super Knowledge Base

A local-first desktop knowledge base for AI agents. Built with **Tauri v2 + Vue 3 + Python**, supports **OpenAI-compatible & local (llama.cpp) embedding/rerank models**, **MinerU document parsing**, ships with an **MCP server** for Claude Code, and includes an **LLM Chat (RAG)** module.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-v2-orange)](https://tauri.app/)
[![Python](https://img.shields.io/badge/Python-3.11+-green)](https://python.org)
[![README](https://img.shields.io/badge/README-中文-red)](README_CN.md)

## Quick Start

### Prerequisites
- **Node.js** ≥ 18, **Rust** ≥ 1.75, **Python** ≥ 3.11, **uv** (Python package manager)

### Install & Run

```bash
git clone https://github.com/1617110693/Local-Agent-Knowledge-Base.git
cd super-knowledge-base
npm install
cd services/python-backend && uv sync --extra build && cd ../..
npm run tauri dev
```

### First Launch
1. **Settings** → configure Embedding API and MinerU Token (required), optionally Rerank and LLM APIs
2. Create a **Knowledge Base** → upload documents (PDF, DOCX, images, Markdown, etc.)
3. Search or connect Claude Code via MCP
4. Open **Chat** in the sidebar for RAG-powered Q&A

## Features

**Document Management** — Auto pipeline: upload → MinerU parse → chunk → embed → index. Multi-format (PDF/DOCX/PPTX/images/Markdown). Full Markdown preview with KaTeX math, section lazy loading, document editing.

**Knowledge Management** — Multiple KBs with independent indexes. Hybrid search (vector + keyword + rerank). Global search across all KBs.

**AI Models** — OpenAI-compatible cloud APIs (embedding, rerank, LLM, VLM) or local models via llama.cpp (CPU inference). Test-connection buttons.

**LLM Chat (RAG)** — Tool-calling loop: LLM actively searches KBs, reads documents, fetches chunks. Web search (Bing/DuckDuckGo/Tavily/SearXNG). SSE streaming with incremental render. Inline citations `[N]` with source preview.

**MCP Server** — 20 tools for AI agents. Single executable (bundled with the app). Connect Claude Code in one click.

**Desktop UI** — Custom frameless window, dark/light/system theme, English/Chinese i18n, system tray, multi-tab, collapsible sidebar, data management (import/export KBs as ZIP).

## Technology Stack

| Layer | Technology |
|-------|-----------|
| Desktop | Tauri v2 (Rust) |
| Frontend | Vue 3 + TypeScript + Vite + Tailwind CSS + Element Plus |
| Backend | FastAPI + FastMCP (Python) |
| Local Models | llama.cpp (CPU inference) |
| Vector DB | LanceDB (embedded) |
| Doc Parsing | MinerU API (Precise mode) |
| Math Rendering | KaTeX |

## MCP Server Setup

Open the app → Settings → **"Configure Claude Code MCP"** to auto-generate the config.

**Dev mode:**
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

> The app must be running (or minimized to tray) for MCP to work.

## Project Structure

```
super-knowledge-base/
├── apps/desktop/                   # Tauri v2 + Vue 3 app
│   ├── src-tauri/                  # Rust backend + sidecars
│   └── src/                        # Vue 3 frontend
├── services/python-backend/        # Python backend (REST API + MCP)
├── scripts/                        # Build & release scripts
```

## License

MIT © 2026 SKB Contributors
