# SKB — Super Knowledge Base

面向 AI Agent 的本地优先桌面知识库。基于 **Tauri v2 + React + Python** 构建，支持 **OpenAI 兼容及本地 (llama.cpp) 嵌入/重排序模型**、**MinerU 文档解析**，内置 **MCP 服务器** 用于 Claude Code 集成，侧边栏集成 **LLM 对话（RAG）** 模块。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-v2-orange)](https://tauri.app/)
[![Python](https://img.shields.io/badge/Python-3.11+-green)](https://python.org)
[![README](https://img.shields.io/badge/README-English-blue)](README.md)

## 功能特性

### 文档管理
- **多格式支持**：PDF、DOCX、PPTX、XLSX、图片、HTML、Markdown、纯文本
- **自动流水线**：上传 → MinerU 精准解析 → 分块 → 向量嵌入 → 索引 — 全自动
- **文档拆分**：大 PDF（>200 页）自动拆分为可管理分片，文件树中归类到父文档下
- **文件管理器**：类资源管理器风格，支持文件夹树、重命名、移动、删除、打开原文件
- **Markdown 预览**：完整渲染，支持 LaTeX 数学公式（KaTeX）、HTML 表格内数学、Section 懒加载、按分块滚动定位（含前后翻页）
- **文档编辑**：支持编辑解析后的 Markdown 文档，保存后自动重新索引

### 知识库管理
- **多知识库**：独立索引与嵌入模型绑定，概览页统计栏
- **显示模式**：卡片、网格、紧凑视图 — 支持排序与置顶
- **混合搜索**：稠密向量 + 中文二元组关键词（FTS）+ 重排序，关键词优先策略
- **文档内搜索**：在文档预览页直接搜索当前文档
- **全局搜索**：一键搜索所有知识库

### AI 模型集成
- **云端 API（OpenAI 兼容）**：OpenAI、Ollama、vLLM、LiteLLM、百炼 — 任意兼容端点
- **本地模型（llama.cpp）**：内置 CPU 推理，预置 Qwen3-Embedding 与 Qwen3-Reranker GGUF 模型，支持用户自行导入任意 GGUF 文件
- **独立开关**：Embedding 和 Rerank 可分别选择本地或云端
- 设置中一键测试连接

### LLM 对话（RAG）
- 侧边栏内置对话模块，支持多轮会话管理，对话记录持久化到数据目录
- **工具调用**：LLM 自动调用搜索、文档列表、文档阅读、按序号取分块等工具
- **流式传输（SSE）**：实时逐字显示回复，50ms 节流渲染
- **知识库多选**：支持同时检索多个知识库，访问隔离
- **引用标注**：回复带 `[N]` 上标标记与 `[M-N]` 范围标记，点击预览原文分块（支持前后翻页 + "查看完整文档"按钮定位到原文）
- **会话管理**：重命名、删除、重新生成、复制消息
- 代码块复制、数学公式渲染、自动滚动开关

### MCP 服务器
20 个工具供 AI Agent 使用 — 打包为单一可执行文件，需应用正在运行（或最小化至托盘）。
搜索结果和分块均包含 `content_type`（`text`、`image`、`table`、`equation`），方便按内容类型渲染。

| 工具 | 说明 |
|------|------|
| `search_knowledge_base` | 混合搜索（向量 + 关键词 + 重排序），结果含 `content_type`，图片结果用 `read_document_image` 展示 |
| `search_all_knowledge_bases` | 跨所有知识库全局搜索，无需事先知道目标知识库 |
| `search_document` | 在单个文档内搜索，锁定目标文档后使用，更精准 |
| `list_knowledge_bases` | 列出所有知识库及统计，检测孤立数据 |
| `list_documents` | 列出知识库中所有文档及元数据 |
| `get_document` | 获取文档内容，支持 `max_chars` 截断保护 |
| `get_document_summary` | 获取文档摘要（元数据 + 标题大纲 + 首尾 chunk 预览），不加载正文 |
| `get_document_chunks` | 获取文档分块，支持 `limit` 参数（正数取前N，负数取倒数N，0取全部），含 `content_type` |
| `get_chunk_by_index` | 按 doc_id + chunk_index 获取单个分块，含 `content_type` |
| `get_chunks_by_page` | 获取文档指定页面的所有分块 |
| `read_document_image` | 读取文档提取的图片，返回绝对路径可直接用 `file://` 协议展示 |
| `create_knowledge_base` | 创建新知识库 |
| `delete_knowledge_base` | 删除知识库及所有数据 |
| `rename_knowledge_base` | 重命名知识库并更新描述 |
| `add_document` | 导入文本或解析文件（PDF/DOCX/PPTX/XLSX/图片/HTML） |
| `delete_document` | 删除文档及其分块 |
| `rename_document` | 重命名文档 |
| `move_document` | 移动文档到指定文件夹路径 |
| `list_folders` | 列出知识库中所有文件夹路径 |
| `clean_orphans` | 清理孤立数据，返回详细的成功/跳过报告 |

### 桌面 UI
- 自定义无边框窗口，支持深色/浅色/跟随系统主题
- 中英文国际化，内置使用指南
- **系统托盘** — 关闭窗口最小化至托盘，后端保持运行供 MCP 使用
- **单实例运行** — 重复启动时唤出已有窗口而非打开新窗口
- **可折叠侧边栏**：知识库 + 对话记录分区，独立滚动
- 设置面板：导航标签页分类（通用/模型/对话/数据）
- **数据管理**：知识库 ZIP 导入导出、settings.json 配置导入导出、一键孤儿数据清理

## 快速开始

### 环境要求
- **Node.js** ≥ 18、**Rust** ≥ 1.75、**Python** ≥ 3.11、**uv**（Python 包管理器）

### 安装运行

```bash
git clone https://github.com/1617110693/Local-Agent-Knowledge-Base.git
cd super-knowledge-base
npm install
cd services/python-backend && uv sync && cd ../..
npm run tauri dev
```

### 首次使用
首次启动会自动弹出使用指南。核心步骤：
1. **设置** → 配置嵌入模型 API 和 MinerU 令牌（必填），可选配置重排序和 LLM API
2. 创建**知识库** → 上传文档
3. 搜索或通过 MCP 连接 Claude Code 使用
4. 配置 LLM API → 侧边栏对话模块进行智能问答
5. （可选）开启**本地模型**使用 llama.cpp 离线推理

## MCP 服务器配置

打开应用 → 设置 → 点击 **"配置 Claude Code MCP"** 自动生成配置。

**开发模式**（自动检测）：
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

> 应用必须正在运行（或最小化至托盘），MCP 才能正常工作。API 密钥从 `settings.json` 读取。

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面框架 | Tauri v2 (Rust) |
| 前端 | React 18 + TypeScript + Vite + Tailwind CSS |
| 后端 | FastAPI + FastMCP (Python) |
| 本地模型 | llama.cpp（CPU 推理） |
| 向量数据库 | LanceDB（嵌入式） |
| 文档解析 | MinerU API（精准解析） |
| 数学渲染 | KaTeX + remark-math |

## 项目结构

```
super-knowledge-base/
├── apps/desktop/                  # Tauri v2 + React 应用
│   ├── src-tauri/                 # Rust 后端 + llama.cpp 二进制
│   └── src/                       # React 前端
├── services/python-backend/       # Python 后端（REST API + MCP 共用一个可执行文件）
├── models/                        # GGUF 模型文件
└── scripts/                       # 构建与发布脚本
```

## 数据存储

所有数据本地存储在 `~/.super-knowledge-base/`：

```
~/.super-knowledge-base/
├── settings.json                  # 应用配置
├── knowledge_bases.json           # 知识库注册表
├── chat_conversations.json        # LLM 对话记录
├── kb_{uuid}/                     # 知识库
│   └── docs/{doc_id}/             # 文档（metadata.json + full.md）
└── lancedb_data/                  # 向量索引
```

## 许可证

MIT © 2026 SKB Contributors
