# Local Agent Knowledge Base · 本地知识库

一款面向 AI Agent 的本地优先桌面知识库应用。基于 **Tauri v2 + React + Python** 构建，支持 **OpenAI 兼容的 embedding 和 rerank 模型**、**MinerU 文档解析**，并附带 **MCP 服务器**，可直接接入 Claude Code 等 AI 助手。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-v2-orange)](https://tauri.app/)
[![Python](https://img.shields.io/badge/Python-3.11+-green)](https://python.org)
[![README](https://img.shields.io/badge/README-English-blue)](README.md)

## 功能特性

### 文档管理
- **多格式支持**：PDF、DOCX、PPTX、XLSX、图片、HTML、Markdown、纯文本
- **全自动流程**：上传 → MinerU 解析 → 分块 → 向量化 → 索引，一步到位
- **文件管理器**：类资源管理器风格，支持文件夹树、重命名、移动、删除
- **Markdown 预览**：支持 LaTeX 数学公式渲染，大文件懒加载

### 知识管理
- **多知识库**，独立索引，可绑定不同 embedding 模型
- **显示模式**：卡片、网格、紧凑列表，支持排序和置顶
- **混合搜索**：稠密向量 + BM25 关键词 + 重排序
- **导入/导出**：多选 ZIP 备份

### AI 模型集成（OpenAI 兼容）
- **Embedding**：OpenAI、Ollama、vLLM、LiteLLM 等任何 `/v1/embeddings` 接口
- **Rerank**：Jina AI、Cohere、DashScope (Qwen3-rerank) 等
- **测试连接** 按钮，即时验证配置

### MCP 服务器
12 个工具供 AI Agent 调用 — 作为后端的一部分运行，需要应用在前台或托盘运行：

| 工具 | 说明 |
|------|------|
| `search_knowledge_base` | 混合搜索 + 重排序 |
| `list_knowledge_bases` | 列出所有 KB 及统计 |
| `get_document` | 获取文档全文，可选分块详情 |
| `get_document_chunks` | 获取文档的所有分块 |
| `create_knowledge_base` | 创建新知识库 |
| `delete_knowledge_base` | 删除知识库及全部数据 |
| `rename_knowledge_base` | 重命名知识库并更新描述 |
| `add_document` | 导入文本或解析文件 |
| `delete_document` | 删除文档及其分块 |
| `rename_document` | 重命名文档 |
| `move_document` | 移动文档到指定文件夹 |
| `list_folders` | 列出知识库中的所有文件夹 |

### 桌面界面
- 无边框窗口，暗色/亮色/系统主题切换
- 中/英文界面
- 系统托盘 — 关闭窗口最小化到托盘，后端持续运行供 MCP 使用
- 侧边栏知识库列表 + 设置面板

## 快速开始

### 环境要求
- **Node.js** ≥ 18、**Rust** ≥ 1.75、**Python** ≥ 3.11、**uv**（Python 包管理器）

### 安装

```bash
git clone https://github.com/1617110693/Local-Agent-Knowledge-Base.git
cd local-knowledge-base
npm install
cd services/python-backend && uv sync && cd ../..
npm run tauri dev
```

### 首次使用
1. 进入**设置** → 配置 Embedding API 和可选的 Rerank API
2. 创建**知识库** → 上传文档
3. 通过界面搜索，或连接 **Claude Code** 通过 MCP

## MCP 服务器配置

打开应用 → 设置 → 点击**"一键配置 Claude Code MCP"**自动生成配置。

**开发模式**（自动检测）：
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

> 应用必须正在运行（或最小化到托盘）MCP 才能工作。API 密钥从 `settings.json` 读取，无需重复配置。

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面框架 | Tauri v2 (Rust) |
| 前端 | React 18 + TypeScript + Vite + Tailwind CSS |
| 后端 | FastAPI + FastMCP (Python) |
| 向量数据库 | LanceDB (嵌入式) |
| 文档解析 | MinerU API |

## 项目结构

```
local-knowledge-base/
├── apps/desktop/          # Tauri v2 + React 应用
│   ├── src-tauri/          # Rust 后端
│   └── src/                # React 前端
├── services/python-backend/ # Python 后端 (FastAPI + MCP)
└── scripts/                # 构建与发布脚本
```

## 数据存储

所有数据默认存储在 `~/.local-knowledge-base/`：

```
~/.local-knowledge-base/
├── settings.json           # 应用配置
├── knowledge_bases.json    # KB 注册表
├── kb_{uuid}/              # 知识库
│   └── docs/{doc_id}/      # 文档 (metadata.json + full.md)
└── lancedb_data/           # 向量索引
```

## 许可证

MIT © 2026 Local Knowledge Base Contributors
