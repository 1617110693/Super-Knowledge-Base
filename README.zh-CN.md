# Local Agent Knowledge Base · 本地知识库

一款面向 AI Agent 的本地优先桌面知识库应用。基于 **Tauri v2 + React + Python** 构建，支持 **OpenAI 兼容的 embedding 和 rerank 模型**、**MinerU 文档解析**，并附带 **MCP 服务器**，可直接接入 Claude Code 等 AI 助手。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-v2-orange)](https://tauri.app/)
[![Python](https://img.shields.io/badge/Python-3.11+-green)](https://python.org)
[![MCP](https://img.shields.io/badge/MCP-stdio-purple)](https://modelcontextprotocol.io/)
[![README](https://img.shields.io/badge/README-English-blue)](README.md) [![README](https://img.shields.io/badge/README-中文-red)](README.zh-CN.md)

## 功能特性

### 📄 文档管理
- **多格式支持**：PDF、DOCX、PPTX、XLSX、图片 (PNG/JPG/WebP)、HTML、Markdown (.md)、纯文本 (.txt)
- **拖拽上传**，支持多文件选择
- **自动解析 + 自动索引**：上传 → 解析 → 索引全自动
- **Markdown / 纯文本** 文件无需 MinerU，即时索引
- **超大 PDF 自动分割**：超过 200 页或 200MB 的 PDF 自动切分为多个部分后解析
- **MinerU 集成**，高质量文档解析：
  - 🎯 精准模式：Token 认证，≤200MB，≤200 页，支持表格/公式。自动选择模型（PDF/图片→vlm，Office→pipeline，HTML→MinerU-HTML）
  - ⚡ Agent 模式：无需 token，≤10MB，≤20 页，原生 Office 解析 — 小文件首选
- **Markdown 预览**，支持 LaTeX 数学公式渲染（KaTeX）
- **实时状态指示**：等待中 → 解析中 → 已完成/失败

### 🔍 知识管理
- **多知识库**，独立索引
- **KB 操作**：创建、重命名、编辑描述、拷贝（含向量数据）、删除
- **KB 级 embedding 模型绑定** — 保证索引一致性，模型不匹配时告警
- **一键重新索引**（单文档 / 全库），自动备份原有数据
- **智能分块**策略：递归分块（推荐）、语义分块、定长分块
- **混合搜索**：稠密向量 + BM25 关键词 (FTS)
- **重排序**，显示当前 rerank 模型名

### 🤖 AI 模型集成（OpenAI 兼容）
- **Embedding**：OpenAI、智谱/BigModel、Ollama、vLLM、LiteLLM 等任何 `/v1/embeddings` 接口
- **Rerank**：Jina AI、Cohere、DashScope (Qwen3-rerank) 等
- **测试连接** 按钮，即时验证配置
- **100% 厂商无关** — 模型由你掌控

### 🔌 MCP 服务器
- **8 个工具**供 AI Agent 调用：
  - `search_knowledge_base` — 混合搜索 + 重排序
  - `list_knowledge_bases` — 列出所有 KB 及统计，检测孤立数据
  - `get_document` — 全文检索，可选分块详情
  - `create_knowledge_base` — 创建新 KB
  - `delete_knowledge_base` — 删除 KB 及数据
  - `rename_knowledge_base` — 重命名 KB 并可选更新描述
  - `add_document` — 导入文本内容或解析本地文件（PDF/DOCX/PPTX/XLSX/图片/HTML）
  - `delete_document` — 删除文档及其所有块
- **stdio 传输** — 作为子进程运行
- **从 `settings.json` 读取 API 密钥** — 无需重复配置
- **不依赖桌面应用** — 直接读写 LanceDB
- **自动同步**桌面应用的文档注册表（`metadata.json`、`knowledge_bases.json`）
- 专为 **Claude Code** 设计，兼容任何 MCP 客户端

### 🎨 桌面界面
- **无边框窗口**，集成标题栏
- **暗色/亮色/系统** 主题切换 (☀️/🌙/🖥️)
- **中/英文** 界面
- **侧边栏**：KB 列表（可滚动）+ 设置固定底部
- **KB 工作区**：统计信息、文档管理、搜索入口
- **文档预览**：支持 LaTeX 公式
- **搜索界面**：混合/向量/关键词模式切换，显示 rerank 模型
- **设置面板**：连接测试、MCP 配置生成器

---

## 技术架构

```
┌─────────────────────────────────────────────────────┐
│                   Desktop App (Tauri)               │
│  ┌──────────┐   ┌──────────┐   ┌────────────────┐   │
│  │  React   │◄──│  Rust    │──►│  MinerU API    │   │
│  │  Frontend│   │  Backend │   │  (doc parsing) │   │
│  └────┬─────┘   └────┬─────┘   └────────────────┘   │
│       │              │                              │
│       │        spawns|                              │
│       ▼              ▼                              │
│  ┌─────────────────────────┐   ┌────────────────┐   │
│  │   Python Backend        │   │   MCP Server   │   │
│  │   (FastAPI)             │   │   (FastMCP)    │   │
│  │   • Chunk + Embed       │   │   • Search     │   │
│  │   • Vector Search       │   │   • KB Mgmt    │   │
│  │   • Index Mgmt          │   │   • Documents  │   │
│  └───────────┬─────────────┘   └───────┬────────┘   │
│              │                         │            │
│              └─────────┬───────────────┘            │
│                        ▼                            │
│              ┌─────────────────┐                    │
│              │    LanceDB      │                    │
│              │  (Embedded DB)  │                    │
│              └─────────────────┘                    │
└─────────────────────────────────────────────────────┘
```

### 技术栈

| 层级 | 技术 |
|------|------|
| 桌面框架 | [Tauri v2](https://tauri.app/) (Rust) |
| 前端 | React 18 + TypeScript + Vite + Tailwind CSS |
| 状态管理 | Zustand |
| 后端 | FastAPI + uvicorn (Python) |
| 向量数据库 | [LanceDB](https://lancedb.com/) (嵌入式) |
| MCP 服务器 | [FastMCP](https://github.com/jlowin/fastmcp) (Python) |
| PDF 工具 | [pypdf](https://pypi.org/project/pypdf/) |
| 工具链 | npm, uv, cargo |

---

## 快速开始

### 环境要求

- **Node.js** ≥ 18
- **npm** ≥ 8
- **Rust** ≥ 1.75（含 `cargo`）
- **Python** ≥ 3.11
- **uv**（Python 包管理器）— [安装指南](https://docs.astral.sh/uv/getting-started/installation/)

### 安装

```bash
# 克隆仓库
git clone https://github.com/1617110693/Local-Agent-Knowledge-Base.git
cd local-knowledge-base

# 安装前端依赖
npm install

# 安装 Python 依赖
cd services/python-backend && uv sync && cd ../..
cd apps/mcp-server && uv sync && cd ../..

# 启动桌面应用
npm run tauri dev
```

### 首次使用

1. 应用启动后自动拉起 Python 后端（端口 17390）
2. 进入**设置**，配置：
   - **Embedding API**：服务商地址、密钥、模型名
   - **Rerank API**（可选）：提升搜索质量
   - **MinerU Token**（推荐）：用于 PDF/DOC 解析
3. 创建**知识库**
4. **上传文档** — 支持拖拽多选
5. **搜索**，或通过 MCP 服务器连接 **Claude Code**

---

## 配置参考

| 设置项 | 说明 | 默认值 |
|--------|------|--------|
| `data_dir` | 自定义数据存储路径 | `~/.local-knowledge-base` |
| `mineru_token` | MinerU API 令牌 | (空) |
| `embedding_api_base` | Embedding API 地址 | `https://api.openai.com/v1` |
| `embedding_api_key` | Embedding API 密钥 | (空) |
| `embedding_model` | Embedding 模型名 | `text-embedding-3-small` |
| `rerank_api_base` | Rerank API 地址 | `https://api.jina.ai/v1` |
| `rerank_api_key` | Rerank API 密钥 | (空) |
| `rerank_model` | Rerank 模型名 | `jina-reranker-v2-base-multilingual` |
| `chunk_strategy` | 分块策略 | `recursive` |
| `chunk_size` | 每块字符数 | `512` |
| `chunk_overlap` | 块间重叠 | `50` |
| `theme` | 界面主题 | `system` |

### 常见服务商配置

**OpenAI**
```
Embedding: https://api.openai.com/v1  |  text-embedding-3-small
```

**Ollama（本地）**
```
Embedding: http://localhost:11434/api  |  nomic-embed-text
```

**智谱 / BigModel**
```
Embedding: https://open.bigmodel.cn/api/paas/v4  |  embedding-3
```

**Jina AI（rerank）**
```
Rerank: https://api.jina.ai/v1  |  jina-reranker-v2-base-multilingual
```

**Cohere（rerank）**
```
Rerank: https://api.cohere.com/v1  |  rerank-english-v3.0
```

**DashScope（rerank）**
```
Rerank: https://dashscope.aliyuncs.com/compatible-mode/v1  |  qwen3-rerank
```

### MinerU API 配置

1. 前往 [MinerU API 管理](https://mineru.net/apiManage/docs)
2. 创建 token
3. 在设置 → MinerU Token 中粘贴

**无 token**：降级为 Agent 模式（免费，限频，≤10MB，≤20 页）。
**有 token**：完整精准解析 — 表格、公式、≤200MB、≤200 页。超大 PDF 自动分割。

---

## MCP 服务器使用

MCP 服务器让 AI Agent（尤其是 **Claude Code**）能够搜索和查询你的知识库。

### 配置

打开桌面应用 → 设置 → 点击**"一键配置 Claude Code MCP"**自动生成配置。

或使用**"复制 MCP 配置"**将 JSON 复制到剪贴板。配置会自动检测开发模式还是打包版本。

**开发模式**（自动检测）：
```json
{
  "mcpServers": {
    "local-knowledge-base": {
      "command": "uv",
      "args": ["run", "--directory", "/path/to/apps/mcp-server", "local-kb-mcp"],
      "env": { "KNOWLEDGE_BASE_DATA_DIR": "~/.local-knowledge-base" }
    }
  }
}
```

**生产模式**（自动检测）：
```json
{
  "mcpServers": {
    "local-knowledge-base": {
      "command": "C:\\Program Files\\Local Knowledge Base\\local-kb-mcp.exe",
      "env": { "KNOWLEDGE_BASE_DATA_DIR": "C:\\Users\\...\\.local-knowledge-base" }
    }
  }
}
```

> 💡 API 密钥从 `settings.json` 读取，无需在 MCP 配置中重复填写。

### 可用 MCP 工具

| 工具 | 说明 |
|------|------|
| `search_knowledge_base` | 混合搜索（向量 + BM25），可选重排序 |
| `list_knowledge_bases` | 列出所有 KB，检测孤立数据 |
| `get_document` | 获取文档全文，可选分块详情 |
| `create_knowledge_base` | 创建新知识库 |
| `delete_knowledge_base` | 删除知识库及全部数据 |
| `rename_knowledge_base` | 重命名 KB 并可选更新描述 |
| `add_document` | 导入文本或解析文件（PDF/DOCX/PPTX/XLSX/图片/HTML） |
| `delete_document` | 删除文档及其所有块 |

---

## 开发

### 项目结构

```
local-knowledge-base/
├── apps/
│   ├── desktop/                    # Tauri v2 + React 应用
│   │   ├── src-tauri/              # Rust 后端
│   │   └── src/                    # React 前端
│   └── mcp-server/                 # Python MCP 服务器
├── services/
│   └── python-backend/             # Python FastAPI 服务
└── scripts/                        # 构建与发布脚本
```

### 常用命令

```bash
# 桌面应用（完整 Tauri）
npm run tauri dev

# 仅 Python 后端
cd services/python-backend && uv run knowledge-backend

# 仅 MCP 服务器
cd apps/mcp-server && uv run local-kb-mcp

# TypeScript 类型检查
npx tsc --noEmit --project apps/desktop/tsconfig.json
```

### 发布构建

```powershell
.\scripts\release.ps1 1.0.0
```

构建流程：PyInstaller 将 Python 后端和 MCP 服务器打包为独立 exe，然后 Tauri 将所有内容打包为单个安装包。

---

## 数据存储

所有数据默认存储在 `~/.local-knowledge-base/`（可在设置中修改）。

```
~/.local-knowledge-base/
├── settings.json              # 应用配置
├── knowledge_bases.json       # KB 元数据注册表
├── kb_{uuid}/                 # 知识库
│   └── docs/
│       └── {doc_id}/           # 文档（metadata.json + full.md）
└── lancedb_data/              # 向量索引
```

---

## 常见问题

### 可以使用本地模型（Ollama）吗？

可以。Embedding API 设置为 `http://localhost:11434/api`，模型名 `nomic-embed-text`。

### 更换 embedding 模型怎么办？

使用**一键重新索引**按钮——会自动创建 LanceDB 表备份，然后用新模型重新索引。

### 需要 MinerU token 吗？

不必须。Agent 模式无需 token（≤10MB，≤20 页）。处理大文件建议获取免费 token。

### MCP 服务器可以不启动桌面应用独立运行吗？

可以。MCP 服务器直接读写 LanceDB，只需设置 `KNOWLEDGE_BASE_DATA_DIR` 环境变量。也可通过 `add_document` + `file_path` 直接导入文档——支持所有 MinerU 格式（PDF/DOCX/PPTX/XLSX/图片/HTML）。

---

## 许可证

MIT © 2026 Local Knowledge Base Contributors

## 致谢

- [MinerU](https://mineru.net/) — 文档解析 API
- [Tauri](https://tauri.app/) — 桌面应用框架
- [LanceDB](https://lancedb.com/) — 嵌入式向量数据库
- [FastMCP](https://github.com/jlowin/fastmcp) — MCP 服务器框架
- [FastAPI](https://fastapi.tiangolo.com/) — Python Web 框架
