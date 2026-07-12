# SKB — Super Knowledge Base

面向 AI Agent 的本地优先桌面知识库。基于 **Tauri v2 + Vue 3 + Python** 构建，支持 **OpenAI 兼容及本地 (llama.cpp) 嵌入/重排序模型**、**MinerU 文档解析**，内置 **MCP 服务器** 用于 Claude Code 集成，侧边栏集成 **LLM 对话（RAG）** 模块。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-v2-orange)](https://tauri.app/)
[![Python](https://img.shields.io/badge/Python-3.11+-green)](https://python.org)
[![README](https://img.shields.io/badge/README-English-blue)](README.md)

## 快速开始

### 环境要求
- **Node.js** ≥ 18、**Rust** ≥ 1.75、**Python** ≥ 3.11、**uv**（Python 包管理器）

### 安装运行

```bash
git clone https://github.com/1617110693/Local-Agent-Knowledge-Base.git
cd super-knowledge-base
npm install
cd services/python-backend && uv sync --extra build && cd ../..
npm run tauri dev
```

### 首次使用
1. **设置** → 配置嵌入模型 API 和 MinerU 令牌（必填），可选配置重排序和 LLM API
2. 创建**知识库** → 上传文档（PDF、DOCX、图片、Markdown 等）
3. 搜索或通过 MCP 连接 Claude Code
4. 侧边栏**对话**模块进行 RAG 智能问答

## 功能特性

**文档管理** — 全自动流水线：上传 → MinerU 解析 → 分块 → 嵌入 → 索引。多格式支持（PDF/DOCX/PPTX/图片/Markdown）。完整 Markdown 预览（KaTeX 数学公式）、Section 懒加载、文档编辑。

**知识库管理** — 多知识库独立索引。混合搜索（向量 + 关键词 + 重排序）。跨库全局搜索。

**AI 模型** — OpenAI 兼容云端 API（Embedding/Rerank/LLM/VLM），或 llama.cpp 本地模型（CPU 推理）。一键测试连接。

**LLM 对话 (RAG)** — 工具调用循环：LLM 自动搜索知识库、阅读文档、取分块。联网搜索（Bing/DuckDuckGo/Tavily/SearXNG）。SSE 流式增量渲染。`[N]` 内联引用 + 来源预览。

**MCP 服务器** — 20 个工具供 AI Agent 使用。单个可执行文件（与应用打包）。一键配置 Claude Code 连接。

**桌面 UI** — 自定义无边框窗口，深色/浅色/系统主题，中英文国际化，系统托盘，多标签页，可折叠侧边栏，数据管理（ZIP 导入导出知识库）。

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面框架 | Tauri v2 (Rust) |
| 前端 | Vue 3 + TypeScript + Vite + Tailwind CSS + Element Plus |
| 后端 | FastAPI + FastMCP (Python) |
| 本地模型 | llama.cpp（CPU 推理） |
| 向量数据库 | LanceDB（嵌入式） |
| 文档解析 | MinerU API（精准解析） |
| 数学渲染 | KaTeX |

## MCP 服务器配置

打开应用 → 设置 → 点击 **"配置 Claude Code MCP"** 自动生成配置。

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

> 应用必须正在运行（或最小化至托盘），MCP 才能正常工作。

## 项目结构

```
super-knowledge-base/
├── apps/desktop/                   # Tauri v2 + Vue 3 应用
│   ├── src-tauri/                  # Rust 后端 + sidecar
│   └── src/                        # Vue 3 前端
├── services/python-backend/        # Python 后端（REST API + MCP）
├── scripts/                        # 构建与发布脚本
```

## 许可证

MIT © 2026 SKB Contributors
