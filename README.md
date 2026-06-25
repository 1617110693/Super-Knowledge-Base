# Local Agent Knowledge Base

面向 AI Agent 的本地优先桌面知识库。基于 **Tauri v2 + React + Python** 构建，支持 **OpenAI 兼容的嵌入与重排序模型**、**MinerU 文档解析**，内置 **MCP 服务器** 用于 Claude Code 集成，侧边栏集成 **LLM 对话（RAG）** 模块。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-v2-orange)](https://tauri.app/)
[![Python](https://img.shields.io/badge/Python-3.11+-green)](https://python.org)
[![README](https://img.shields.io/badge/README-English-blue)](README_EN.md)

## 功能特性

### 文档管理
- **多格式支持**：PDF、DOCX、PPTX、XLSX、图片、HTML、Markdown、纯文本
- **自动流水线**：上传 → MinerU 精准解析 → 分块 → 向量嵌入 → 索引 — 全自动
- **文件管理器**：类资源管理器风格，支持文件夹树、重命名、移动、删除
- **Markdown 预览**：完整渲染，支持 LaTeX 数学公式（KaTeX），大文件懒加载
- **文档编辑**：支持编辑解析后的 Markdown 文档，保存后自动重新索引

### 知识库管理
- **多知识库**：独立索引与嵌入模型绑定
- **显示模式**：卡片、网格、紧凑视图 — 支持排序与置顶
- **混合搜索**：稠密向量 + 中文二元组关键词（FTS）+ 重排序，关键词优先策略
- **全局搜索**：Dashboard 中一键搜索所有知识库
- **导出/导入**：ZIP 备份，支持多选

### AI 模型集成（OpenAI 兼容）
- **嵌入模型**：OpenAI、Ollama、vLLM、LiteLLM — 任意 `/v1/embeddings` 端点
- **重排序**：Jina AI、Cohere、百炼（Qwen3-rerank）— 任意兼容端点
- **LLM 对话**：支持任意 OpenAI 兼容的大模型，可选用知识库 RAG 检索增强
- **连接测试**：设置中一键测试各类 API 连接

### LLM 对话（RAG）
- 侧边栏内置对话模块，支持多轮会话管理
- **流式传输（SSE）**：实时逐字显示回复
- **知识库选择**：可选择单个知识库作为 RAG 上下文
- **引用标注**：LLM 回复中带 `[N]` 上标引用，点击可查看原文分块
- **会话管理**：重命名、删除对话（悬停显示按钮）
- **Markdown + 数学**：回复支持完整 Markdown 渲染与 KaTeX 数学公式
- 对话记录持久化存储（localStorage）

### MCP 服务器
12 个工具供 AI Agent 使用 — 与后端合并运行，需应用正在运行（或最小化至托盘）：

| 工具 | 说明 |
|------|------|
| `search_knowledge_base` | 混合搜索（向量 + 关键词 + 重排序） |
| `list_knowledge_bases` | 列出所有知识库及统计，检测孤立数据 |
| `get_document` | 获取完整文档内容及可选分块详情 |
| `get_document_chunks` | 获取文档所有分块 |
| `create_knowledge_base` | 创建新知识库 |
| `delete_knowledge_base` | 删除知识库及所有数据 |
| `rename_knowledge_base` | 重命名知识库并更新描述 |
| `add_document` | 导入文本或解析文件（PDF/DOCX/PPTX/XLSX/图片/HTML） |
| `delete_document` | 删除文档及其分块 |
| `rename_document` | 重命名文档 |
| `move_document` | 移动文档到指定文件夹路径 |
| `list_folders` | 列出知识库中所有文件夹路径 |

### 桌面 UI
- 自定义无边框窗口，支持深色/浅色/跟随系统主题
- 中英文国际化
- **系统托盘** — 关闭窗口最小化至托盘，后端保持运行供 MCP 使用
- **可折叠侧边栏**：知识库列表 + 对话记录分区，概览页居中图标
- 设置面板：API Key、模型参数、分块策略一站式配置
- **后端强力重启**：设置中一键强制终止旧进程并启动新后端

## 快速开始

### 环境要求
- **Node.js** ≥ 18、**Rust** ≥ 1.75、**Python** ≥ 3.11、**uv**（Python 包管理器）

### 安装运行

```bash
git clone https://github.com/1617110693/Local-Agent-Knowledge-Base.git
cd local-knowledge-base
npm install
cd services/python-backend && uv sync && cd ../..
npm run tauri dev
```

### 首次使用
1. 进入 **设置** → 配置嵌入 API（必填）和重排序 API（可选）
2. 创建 **知识库** → 上传文档
3. 在界面中搜索，或通过 MCP 连接 **Claude Code** 使用
4. 在 **设置** 中配置 LLM API → 侧边栏打开对话模块即可问答

## MCP 服务器配置

打开应用 → 设置 → 点击 **"配置 Claude Code MCP"** 自动生成配置。或使用 **"复制 MCP 配置"** 一键复制。

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

> 应用必须正在运行（或最小化至托盘），MCP 才能正常工作。API 密钥从 `settings.json` 读取，无需重复配置。

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面框架 | Tauri v2 (Rust) |
| 前端 | React 18 + TypeScript + Vite + Tailwind CSS |
| 后端 | FastAPI + FastMCP (Python) |
| 向量数据库 | LanceDB（嵌入式） |
| 文档解析 | MinerU API（精准解析） |
| 数学渲染 | KaTeX + remark-math |

## 项目结构

```
local-knowledge-base/
├── apps/desktop/              # Tauri v2 + React 应用
│   ├── src-tauri/             # Rust 后端
│   └── src/                   # React 前端
├── services/python-backend/   # Python 后端（FastAPI REST + MCP stdio 服务器，共享代码）
└── scripts/                   # 构建与发布脚本
```

## 数据存储

所有数据本地存储在 `~/.local-knowledge-base/`：

```
~/.local-knowledge-base/
├── settings.json              # 应用配置（API 密钥等）
├── knowledge_bases.json       # 知识库注册表
├── kb_{uuid}/                 # 知识库
│   └── docs/{doc_id}/         # 文档（metadata.json + full.md）
└── lancedb_data/              # 向量索引
```

## 许可证

MIT © 2026 Local Knowledge Base Contributors
