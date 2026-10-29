# Water — AI Agent Harness（学习研究版）

> 仿写 OpenCode 类 AI Agent 运行框架：内核对接大模型，CLI / Web / 桌面三端，插件系统可扩展。
> 本项目仅用于个人学习研究，全程配套学习指引文章（见 `docs/articles/`）。

## 项目定位

```
不是「又一个聊天框」，而是理解 Agent Harness 的四层本质：

  接入层   CLI / Web / Desktop        —— 三端壳，复用同一份会话协议
  协议层   HTTP + SSE（JSON 事件流）   —— 内核与前端之间的唯一契约
  内核层   Agent Loop + Provider + Tool —— 模型↔工具往返调度的心脏
  扩展层   Plugin System（+MCP 桥接）  —— 第三方能力的入口
```

## 技术选型

| 层 | 选型 | 理由 |
|---|---|---|
| 全栈语言 | TypeScript + Node 22 | 三端代码复用最大化 |
| 模型协议 | **双协议**：OpenAI 兼容 + Anthropic Messages | 智谱 GLM coding plan 走 Anthropic 端点；DeepSeek/通义/vLLM 走 OpenAI 兼容 |
| CLI | commander + 自研 TUI 渲染 | npm 分发顺滑 |
| Server | Hono（轻量 HTTP + SSE） | 少依赖、易讲清原理 |
| Web | React + Vite | P0 原型即视觉基准 |
| Desktop | Tauri | 复用 Web UI，包体 ~10MB |
| 插件 | 进程内 ESM 插件 + MCP client 逃生舱 | 学习性价比最高的隔离方案 |

## 路线图

| 阶段 | 内容 | 状态 | 配套文章 |
|---|---|---|---|
| P0 | 高保真 UI 原型（HTML+CSS） | ✅ 完成 | [01-界面设计](docs/articles/01-界面设计.md) |
| P1 | 内核：Agent Loop + Provider + 内置工具 | ✅ 完成（GLM 联调通过） | [02-Agent Loop](docs/articles/02-Agent-Loop解剖.md) |
| P2 | CLI 与 npm 分发 | ✅ 完成 | [04-CLI工程化](docs/articles/04-CLI工程化与npm发布.md) |
| P3 | Server + Web UI | ✅ 完成（mock 联调通过，GLM 待联调） | [03](docs/articles/03-SSE流式协议设计.md) / [05](docs/articles/05-三端共用一套会话协议.md) |
| P4 | Tauri 桌面端 | 🚧 骨架完成，编译验证中 | [06-Tauri桌面端](docs/articles/06-Tauri桌面端.md) |
| P5 | 插件系统 | ✅ 完成（含 MCP 桥接） | [07-插件系统设计](docs/articles/07-插件系统设计.md) |
| P6 | Docker 镜像 + 运维部署文档 | ✅ 完成（docker build 待有 Docker 的机器验证） | [08-从源码到生产](docs/articles/08-从源码到生产.md) |

详见 [docs/articles/00-导读.md](docs/articles/00-导读.md)。

## 目录结构（随阶段演进）

```
06-water-ai-harness/
├── prototype/          # P0：高保真 HTML+CSS 原型
├── docs/
│   └── articles/       # 学习指引系列文章（含 mermaid 架构图）
├── packages/           # P1+：core / plugins-sdk 等内核包
└── apps/               # P2+：cli / server / web / desktop
```

## 红线

- 凭据一律走环境变量 / DPAPI 加密存储（见 `~/.ai-secrets/`），**明文 token 永不入库**
- 每阶段必须「能跑起来 + 写完文章」才进入下一阶段
