# SKB Vue 全面重构设计文档

> 日期: 2026-07-08 | 状态: 设计完成，待审核

---

## 一、背景与目标

将 Super Knowledge Base 桌面应用从 React 全面重构为 Vue 3，同时集成 pdf-reader 项目，实现 PDF+Markdown+Chunk 多向导航。

### 核心目标

1. **框架迁移**：React 18 → Vue 3.4+，零功能损失
2. **去除 AI 味**：macOS 风格视觉设计、专业桌面交互、流畅动画
3. **PDF 集成**：完整融合 pdf-reader（已有 Vue 3 项目），实现多向跳转
4. **性能不降级**：流式渲染、大文档、PDF 缩放性能不低于现有方案

### 技术决策

| 维度 | 决策 |
|------|------|
| 框架 | Vue 3.4+ |
| 构建 | Vite 5 |
| UI 组件库 | Element Plus 2.x |
| CSS | Tailwind CSS 3.x + Element Plus 主题 |
| 状态管理 | Pinia（4 个 Store 对应现有 Zustand） |
| 路由 | Vue Router 4 |
| 图标 | lucide-vue-next |
| 工具库 | @vueuse/core, @vueuse/motion |
| 虚拟滚动 | @tanstack/vue-virtual |
| Markdown（静态） | markdown-it + 插件 |
| Markdown（流式） | markdown-it + token 哈希缓存 + v-memo |
| PDF 渲染 | pdfjs-dist 6.x |
| 迁移策略 | 全面重构，一次性完成 |

---

## 二、项目结构

```
apps/desktop/src/
├── main.ts                    # createApp + Pinia + Router + Element Plus
├── App.vue                    # 根组件，路由出口
│
├── components/
│   ├── layout/
│   │   ├── AppLayout.vue      # 外壳：TitleBar + TabBar + Sidebar + <router-view>
│   │   ├── TitleBar.vue       # Windows 风格标题栏
│   │   ├── Sidebar.vue        # 半透明毛玻璃侧边栏，KB列表 + 对话历史
│   │   └── TabBar.vue         # 文档/对话标签页，拖拽排序
│   │
│   ├── chat/
│   │   ├── ChatPage.vue       # 聊天主页（核心）
│   │   ├── ChatInput.vue      # 输入框 + 发送/停止
│   │   ├── ChatMessageList.vue # 虚拟滚动消息列表
│   │   ├── MessageRow.vue     # 单条消息行
│   │   ├── ChatMarkdown.vue   # 流式 markdown 渲染（自研）
│   │   ├── ToolCallCards.vue  # 工具调用卡片
│   │   ├── SourcesPanel.vue   # 来源引用面板
│   │   └── KBSelector.vue     # 知识库多选下拉
│   │
│   ├── documents/
│   │   ├── DocumentPreview.vue # 文档阅读器（最大组件，含多视图切换）
│   │   ├── DocumentManager.vue # 文档列表/上传/管理
│   │   └── ImageDialog.vue    # 图片查看器
│   │
│   ├── reader/                # 来自 pdf-reader 的组件
│   │   ├── PdfViewport.vue    # PDF 渲染核心（Canvas + GPU 缩放）
│   │   ├── AnnotationLayer.vue # PDF 标注渲染
│   │   ├── SelectionToolbar.vue # 文本选中工具栏
│   │   └── ContextMenu.vue    # 右键菜单
│   │
│   ├── panels/                # 来自 pdf-reader 的面板
│   │   ├── SlidePanel.vue     # 侧滑面板容器
│   │   ├── OutlinePanel.vue   # 目录（合并 Markdown TOC + PDF 目录）
│   │   ├── ThumbnailPanel.vue # 页面缩略图
│   │   ├── BookmarkPanel.vue  # 书签
│   │   └── SearchPanel.vue    # 文档内搜索
│   │
│   ├── knowledge-base/
│   │   ├── KBDashboard.vue    # KB 仪表盘
│   │   ├── KBSettings.vue     # KB 设置
│   │   ├── ImportExport.vue   # 导入导出
│   │   └── MoveCopyDialog.vue # 移动/复制对话框
│   │
│   ├── search/
│   │   ├── SearchInterface.vue # KB 内搜索
│   │   └── GlobalSearchDialog.vue # 全局搜索
│   │
│   ├── settings/
│   │   └── SettingsPanel.vue  # 设置面板
│   │
│   └── common/
│       ├── MarkdownRenderer.vue # 静态 markdown 渲染
│       ├── ChunkDetailDialog.vue # 分块详情
│       ├── ConfirmDialog.vue   # 确认对话框
│       ├── ErrorDialog.vue     # 错误对话框
│       └── UserGuideDialog.vue # 用户引导
│
├── composables/
│   ├── useChat.ts             # 聊天逻辑
│   ├── useDocument.ts         # 文档加载/缓存/分页
│   ├── usePageNavigation.ts   # 页面锚点定位 + 多向跳转协调
│   ├── useScrollSpy.ts        # IntersectionObserver 监听当前章节
│   ├── useTheme.ts            # 主题切换
│   ├── useKeyboard.ts         # 全局快捷键
│   └── useUI.ts               # UI 面板状态
│
├── stores/
│   ├── chatStore.ts           # 对话 CRUD、流式状态、落盘控制
│   ├── kbStore.ts             # KB CRUD、文档解析+索引管道、PDF 文档状态
│   ├── settingsStore.ts       # 设置、Python 后端状态
│   ├── tabStore.ts            # 标签管理、LRU 驱逐、缓存
│   └── annotations.ts         # PDF 标注（来自 pdf-reader）
│
├── services/                  # 零改动复用
│   ├── tauriBridge.ts         # ← 不变
│   ├── pythonClient.ts        # ← 不变
│   ├── toolExecutor.ts        # ← 小改（useSettingsStore → pinia）
│   ├── toolDefinitions.ts     # ← 不变
│   ├── webSearch.ts           # ← 不变
│   └── memoryStore.ts         # ← 不变
│
├── i18n/
│   ├── index.ts               # vue-i18n 配置
│   └── translations.ts        # ← 不变
│
├── types/
│   └── index.ts               # ← 不变
│
└── styles/
    ├── globals.css            # Tailwind + Element Plus 主题
    └── variables.css          # macOS 风格 CSS 变量
```

---

## 三、设计系统

### 3.1 配色方案

```
浅色模式：
  --bg-primary:     #f5f5f7 (macOS 经典淡灰)
  --bg-secondary:   #ffffff (卡片/内容区)
  --bg-sidebar:     rgba(245,245,247,0.72) (半透明侧边栏)
  --text-primary:   #1d1d1f
  --text-secondary: #6e6e73
  --accent:         #0071e3 (macOS 蓝)
  --accent-muted:   rgba(0,113,227,0.08)
  --border:         rgba(0,0,0,0.08)
  --surface:        #ffffff
  --surface-raised: #f5f5f7
  --surface-elevated:#ffffff

深色模式：
  --bg-primary:     #1c1c1e
  --bg-secondary:   #2c2c2e
  --bg-sidebar:     rgba(28,28,30,0.72)
  --text-primary:   #f5f5f7
  --text-secondary: #98989d
  --accent:         #2997ff
  --accent-muted:   rgba(41,151,255,0.12)
  --border:         rgba(255,255,255,0.08)
  --surface:        #2c2c2e
  --surface-raised: #3a3a3c
  --surface-elevated:#48484a
```

### 3.2 毛玻璃效果

```css
.sidebar-glass {
  background: var(--bg-sidebar);
  backdrop-filter: saturate(180%) blur(20px);
  -webkit-backdrop-filter: saturate(180%) blur(20px);
  border-right: 1px solid var(--border);
}
```

### 3.3 字体

```
font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display",
             "SF Pro Text", "Helvetica Neue", "Microsoft YaHei", sans-serif;
```

### 3.4 动效规范

| 类型 | 时长 | 缓动 |
|------|------|------|
| 页面切换 | 200ms | cubic-bezier(0.4, 0, 0.2, 1) |
| 面板展开 | 250ms | cubic-bezier(0.4, 0, 0.2, 1) |
| 悬停反馈 | 150ms | ease-out |
| 模态弹出 | 200ms | cubic-bezier(0.0, 0, 0.2, 1) + scale(0.95→1) |
| 列表项 | 300ms stagger | 每项延迟 30ms |

### 3.5 关键视觉特征

1. **侧边栏**：半透明毛玻璃，图标 + 文字的紧凑列表
2. **标题栏**：Windows 风格——右侧最小化/最大化/关闭，左侧图标 + 标题
3. **卡片**：微妙 1px 边框 + 极小阴影，圆角 8px
4. **按钮**：圆角 6px，主按钮填充色，次按钮透明边框
5. **输入框**：圆角 8px，聚焦时蓝色光环
6. **滚动条**：细窄半透明，hover 时加深
7. **标签栏**：Safari 风格，激活标签有浅色背景

---

## 四、桌面端交互

### 4.1 全局快捷键（Windows）

| 快捷键 | 功能 |
|--------|------|
| Ctrl+K | 全局搜索 |
| Ctrl+N | 新建对话 |
| Ctrl+, | 打开设置 |
| Ctrl+W | 关闭当前标签 |
| Ctrl+Shift+T | 重新打开已关闭标签 |
| Ctrl+1~9 | 切换标签页 |
| Ctrl+Shift+N | 新建知识库 |
| Ctrl+J | 切换侧边栏 |
| Ctrl+B | 切换标签栏 |
| Ctrl+E | 聚焦搜索框 |
| Ctrl+O | 打开 PDF 文件 |
| Ctrl+F | 文档内搜索 |
| Ctrl+D | 添加书签 |
| Ctrl+S | 保存标注 |
| Esc | 关闭弹窗/对话框 |
| Enter | 确认/发送 |
| PageUp/PageDown | 翻页 |
| Home/End | 跳转到首/末页 |

### 4.2 右键菜单

| 场景 | 菜单项 |
|------|--------|
| 侧边栏 KB | 打开、重命名、导出、复制、删除 |
| 侧边栏对话 | 打开、重命名、删除 |
| 标签页 | 关闭、关闭其他、关闭右侧、重新打开已关闭 |
| 文档列表 | 预览、下载、重命名、移动、删除、重新索引 |
| 聊天消息 | 复制、复制为 Markdown、重新生成 |
| PDF 页面 | 添加书签、查看对应 Markdown 章节、搜索相关分块 |
| PDF 标注 | 切换颜色、删除 |

### 4.3 拖拽

| 场景 | 实现 |
|------|------|
| 标签页排序 | @vueuse/core useDraggable |
| KB 卡片排序 | sortablejs |
| 文件上传 | Tauri dialog + drop zone |
| 侧边栏宽度 | 拖拽分隔线 |
| 分屏视图比例 | 拖拽中间分隔线 |

### 4.4 通知系统

右下角弹出，Element Plus ElNotification 封装。

---

## 五、核心渲染性能

### 5.1 ChatMarkdown — 流式 Markdown 渲染

```
流式 token 到达
    ↓ (80ms 节流)
markdown-it 解析完整文本 → Token 数组
    ↓
Token 数组哈希比对 → 相同则跳过
    ↓ 不同
递归组件 walk token tree
    ├─ heading → <h1>...<h6>
    ├─ code_block → <CodeBlock> (带复制按钮)
    ├─ math → <KaTeX> (katex.renderToString)
    ├─ image → <InlineImg> (懒加载+预览)
    ├─ link → <a> (系统浏览器打开)
    └─ text → <span> (含 source badge 处理)
    ↓
v-memo="[contentHash]" 阻止未变化区域重渲染
```

**性能保证：**
- Token 哈希缓存：内容没变就不重新遍历
- v-memo：Vue 编译时优化，只 diff 变化部分
- katex.renderToString：比浏览器端 KaTeX 快 3-5 倍
- 事件委托：source badge 点击用事件委托，不创建 Vue 组件实例

### 5.2 DocumentPreview — 大文档分段渲染

```
DocumentPreview.vue (~600行)
  ├─ composables/useDocument.ts     — 文档加载、缓存、分页
  ├─ composables/usePageNavigation.ts — 页面锚点定位、TOC 联动、多向跳转
  ├─ composables/useScrollSpy.ts    — IntersectionObserver 监听当前章节
  ├─ composables/useUI.ts           — 面板状态、视图模式
  └─ MarkdownRenderer.vue           — 共用静态渲染
```

**渲染优化：**
- `shallowRef` 存大文本，不触发深度响应
- 虚拟滚动区域（只渲染可视 ± 3 页）
- `requestAnimationFrame` 批量 DOM 操作
- `IntersectionObserver` 替代 scroll 事件监听

### 5.3 PdfViewport — GPU 加速 PDF 缩放

沿用 pdf-reader 的高性能方案：
- Instant zoom：CSS transform（GPU composited，零 reflow）
- Commit zoom：200ms 防抖后重新渲染可见页 Canvas
- IntersectionObserver：只渲染可视页面
- Page cache：Map<pageNum, {canvas, cssW, cssH}>
- 文本层：透明 text layer 实现原生文本选择

---

## 六、PDF + Markdown + Chunk 多向跳转

### 6.1 跳转路径

```
            ┌──────────────┐
            │   PDF 页面    │
            │  (第 N 页)    │
            └──┬────────┬──┘
      page_map  │        │  chunk.page_number
      .cache   │        │
               ▼        ▼
      ┌──────────────┐  ┌──────────────┐
      │  Markdown     │  │  Chunk 块     │
      │  (对应章节)    │◄─┤  (语义分块)   │
      └──────────────┘  └──────────────┘
              ▲                  ▲
              │ source badge     │
              └──────────────────┘
```

### 6.2 跳转路径详情

| 方向 | 触发方式 | 实现 |
|------|---------|------|
| **PDF → Markdown** | 右键菜单"查看对应章节" | page_map.cache 找到 markdown 位置，滚动到对应章节 |
| **Markdown → PDF** | 页面锚点旁的 PDF 图标 | `<!-- page-N -->` 锚点渲染为可点击按钮，跳转 PDF 第 N 页 |
| **Chunk → PDF** | 分块详情中页码链接 | chunk.page_number 跳转 PDF 对应页面 |
| **PDF → Chunk** | 选中文本右键"搜索相关分块" | 选中文本调用 searchDocument，显示相关 chunk 列表 |
| **Chunk → Markdown** | 分块详情"查看原文" | chunk.start_char 定位 markdown 对应位置 |
| **Markdown → Chunk** | source badge 点击 | 已有功能，点击 `[N]` 查看来源 chunk |

### 6.3 视图模式

DocumentPreview 支持三种视图：
1. **Markdown 视图**：纯文本渲染（现有功能）
2. **PDF 视图**：完整 PDF 渲染（集成 PdfViewport）
3. **分屏视图**：左右并排，拖拽调整比例，双向联动滚动

### 6.4 集成数据流

```
MinerU 解析 PDF
  ↓ 生成
full.md (markdown 全文)
images/  (图片目录)
page_map.cache (页面→markdown 位置映射)
content_list.json (分块列表)
  ↓ 索引到
LanceDB (chunk 向量库，含 page_number 字段)
  ↓ 查询时返回
SearchResult { chunk_id, page_number, content, ... }
```

---

## 七、组件迁移映射

### 7.1 布局层

| React | Vue | 关键变化 |
|-------|-----|---------|
| AppLayout.tsx | AppLayout.vue | `<router-view>` 替代 `<Outlet>`，provide/inject 替代 Context |
| TitleBar.tsx | TitleBar.vue | Windows 风格按钮，useTheme composable |
| Sidebar.tsx | Sidebar.vue | 毛玻璃背景，TransitionGroup 列表动画 |
| TabBar.tsx | TabBar.vue | useDraggable 替代手动拖拽 |

### 7.2 聊天层

| React | Vue | 关键变化 |
|-------|-----|---------|
| ChatPage.tsx (654行) | ChatPage.vue + useChat.ts | 流式循环逻辑提取到 composable，UI 纯展示 |
| ChatMessageList.tsx | ChatMessageList.vue | @tanstack/vue-virtual 替代 react-virtual |
| MessageRow.tsx | MessageRow.vue | defineProps + computed 替代 memo |
| ChatMarkdown.tsx | ChatMarkdown.vue | 自研：markdown-it + token 哈希缓存 |
| ToolCallCards.tsx | ToolCallCards.vue | Transition 展开折叠动画 |
| ChatInput.tsx | ChatInput.vue | Element Plus el-input |
| SourcesPanel.tsx | SourcesPanel.vue | Transition 滑入 |
| KBSelector.tsx | KBSelector.vue | Element Plus el-select multiple |

### 7.3 文档层

| React | Vue | 关键变化 |
|-------|-----|---------|
| DocumentPreview.tsx (1908行) | DocumentPreview.vue + 3 composables | 逻辑拆分，watch 替代 useEffect |
| DocumentManager.tsx | DocumentManager.vue | Element Plus el-table, el-upload |
| ImageDialog.tsx | ImageDialog.vue | Teleport to="body" + Transition |

### 7.4 状态管理层

| Zustand | Pinia | 说明 |
|---------|-------|------|
| useChatStore.ts | chatStore.ts | 对话 CRUD、流式状态、落盘控制 |
| useKBStore.ts | kbStore.ts | KB CRUD、文档解析+索引管道、PDF 状态 |
| useSettingsStore.ts | settingsStore.ts | 设置、Python 后端状态 |
| useTabStore.ts | tabStore.ts | 标签管理、LRU 驱逐、缓存 |

Pinia 用 Setup Store 语法，和 Zustand 的函数式风格最接近：

```ts
// Zustand (旧)
const store = create<State>((set, get) => ({
  count: 0,
  increment: () => set(s => ({ count: s.count + 1 })),
}))

// Pinia (新) — 几乎一样
const store = defineStore('counter', () => {
  const count = ref(0)
  const increment = () => count.value++
  return { count, increment }
})
```

### 7.5 零改动复用的模块

- `services/tauriBridge.ts` — 纯 TS，无 React 依赖
- `services/pythonClient.ts` — 纯 TS，无 React 依赖
- `services/memoryStore.ts` — 纯 TS，无 React 依赖
- `services/toolDefinitions.ts` — 纯 TS，无 React 依赖
- `services/toolExecutor.ts` — 小改（useSettingsStore → pinia）
- `services/webSearch.ts` — 纯 TS，无 React 依赖
- `types/index.ts` — 纯 TS 类型
- `i18n/translations.ts` — 纯数据
- 所有 Rust 源码（src-tauri/）— 不变
- 所有 Tauri 配置 — 不变

---

## 八、功能扩展

### 8.1 高优先级

| 扩展 | 说明 |
|------|------|
| 全局命令面板 | Ctrl+K 唤起，类似 VS Code，搜索命令/文档/对话 |
| PDF 阅读器集成 | 完整融合 pdf-reader，支持 PDF 渲染、标注、搜索 |
| 多向跳转 | PDF ↔ Markdown ↔ Chunk 三向联动导航 |

### 8.2 中优先级

| 扩展 | 说明 |
|------|------|
| 对话导出 | 导出为 Markdown/PDF |
| 文档批量操作 | 多选后批量删除/移动/重新索引 |

### 8.3 低优先级

| 扩展 | 说明 |
|------|------|
| 主题市场 | 预设几套配色方案 |
| 统计面板 | KB 使用统计、存储占用 |

---

## 九、技术风险与缓解

| 风险 | 缓解措施 |
|------|---------|
| streamdown 无 Vue 等价库 | markdown-it + token 哈希缓存，性能不低于 streamdown |
| DocumentPreview 1900 行复杂 | 拆分为 3-4 个 composables + 主组件 |
| Tailwind 4→3 适配 | pdf-reader 的 Tailwind 4 语法需逐文件检查 |
| 设计 token 冲突 | 统一使用 SKB macOS 风格变量，合并 pdf-reader 的 tokens.css |
| PDF 标注数据迁移 | 标注存储格式不变，直接复用 annotations store |
| 大量组件同时迁移 | 按模块分批：layout → chat → documents → reader → settings |

---

## 十、验证计划

1. `cd apps/desktop && npm install` 安装新依赖
2. `npm run build` 通过（vue-tsc + vite build）
3. 手动测试：
   - 流式输出时实时显示 markdown 格式（标题/列表/代码块/公式）
   - 长对话（50+ 条）滚动流畅
   - 大文档（100+ 页）渲染、滚动、TOC 导航正常
   - PDF 打开、缩放、翻页、标注功能正常
   - PDF ↔ Markdown ↔ Chunk 跳转正确
   - 所有快捷键正常工作
   - 右键菜单所有场景可用
   - 拖拽排序正常
   - 主题切换正常
   - KB 创建、删除、导入导出正常
   - 文档上传、解析、索引正常
   - 聊天工具调用正常
   - 联网搜索正常
   - 设置保存/加载正常
   - 标签页管理正常
   - 侧边栏折叠/展开正常