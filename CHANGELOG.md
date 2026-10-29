# 更新日志（Changelog）

本项目的所有显著变更都记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本管理遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

类型约定：`新增` / `变更` / `修复` / `移除` / `安全` / `文档` / `工程`

## [Unreleased]

### 新增（M1 · 模型注册表与会话级切换）

- 内核新增模型注册表：`ModelInfo` 元数据（协议/厂商/上下文窗口/思考标记）+ 内置模型表（GLM-4.6、GLM-4.5-Air、DeepSeek Chat/Reasoner）+ `~/.water/config.json` `models[]` 自定义模型（id 冲突时自定义优先；`apiKeyEnv` 只存环境变量名，值校验防误贴真实 key）
- 内核新增 `ProviderRegistry`：模型 → Provider 实例的缓存工厂（按 protocol/baseUrl/apiKeyEnv 复用实例）
- Server 新增 `GET /api/models`（含各模型凭据就绪标记，不含任何 key）、`PATCH /api/sessions/:id/config`（运行时切换，busy 中 409，支持 `reset:true`）
- `POST /api/sessions` 支持初始 `{protocol, model}`；协议随所选模型自动推断，杜绝「openai 协议配 glm 模型」错配
- 会话级覆盖持久化（sessions 表新增 protocol/model 列，老库自动迁移）
- `turn_start` 事件携带 `model` 字段——SSE 流上模型可辨识
- Web 顶栏模型切换器上线（P0 原型期票兑付）：纯 CSS 下拉、按协议分组、缺 key 模型置灰提示、未建会话时作为下一个新会话的初始配置
- 新增离线 E2E `npm run test:e2e`（16 项断言：注册表/初始模型/运行时切换/reset/双会话隔离/非法模型 400），进 CI

### 修复（M0 · 开源工程地基）

- 新增 `LICENSE`（MIT）——此前 README 声称 MIT 但文件缺失，GitHub 无法识别许可
- 新增 GitHub Actions CI（`.github/workflows/ci.yml`）：typecheck + build + 离线闭环测试，
  ubuntu / windows 双平台矩阵，Node 22
- 新增 issue 模板（bug / feature）与 PR 模板，规范贡献入口
- 新增 `CONTRIBUTING.md`：分支模型、提交规范、PR 流程、开发环境说明
- 确立分支模型：`main` 受保护 + `feature/*` 短命分支 + squash merge
- 本起所有变更走 issue → 分支 → PR → review → merge 完整链路

## [0.1.0] - 2026-10-29

首个可用版本：P0→P6 六个阶段一天冲刺完成（30+ 提交），完整演进记录见 `docs/articles/`。

### 内核（packages/core · P1）

- 新增统一消息模型 `WMessage`（role + parts[]），双协议翻译无损
- 新增 Agent Loop：模型↔工具往返调度、审批桥、失控防护（maxTurns / AbortSignal）
- 新增双协议 Provider 适配器：Anthropic Messages（智谱 GLM）+ OpenAI 兼容（DeepSeek 等）
- 新增六个内置工具：read / write / edit / grep / glob / shell（零外部依赖）
- 新增权限引擎：低/中/高三级风险 + 会话级授权记忆
- 新增智谱 GLM 真实联调通过（usage 上报差异修复：`message_delta` 读真实 input_tokens）

### CLI（apps/cli · P2）

- 新增 `water chat`（交互会话）/ `water run`（单次执行）/ `water doctor`（环境自检）
- 新增 npm 打包发布配置（bin 入口、files 白名单、tgz 产物验证）

### Server + Web（apps/server, apps/web · P3）

- 新增 HTTP + SSE 会话协议：POST 消息 → LoopEvent 流式返回
- 新增审批桥：SSE 广播 `approval_required` + POST 端点 resolve
- 新增会话持久化（node:sqlite 零依赖驱动，重启恢复）与任务记录（tasks 表）
- 新增 Web 五页视图（会话/任务/插件/设置/工作区），mock 联调通过

### 桌面端（apps/desktop · P4）

- 新增 Tauri 骨架：sidecar 拉起 server + 窗口关闭清理
- 新增 Node SEA 单文件 sidecar（esbuild bundle → sea blob → postject 注入）
- 新增 MSI 安装包构建（24~36MB 实测）

### 插件系统（plugins/ · P5）

- 新增进程内 ESM 插件加载器：manifest 校验、失败隔离、权限风险提升治理
- 新增示例插件：echo / web-fetch / mcp-bridge（MCP client 逃生舱）
- 新增斜杠命令：插件模板 + `$ARGUMENTS` 替换

### 交付（· P6）

- 新增 Dockerfile 多阶段镜像 + docker-compose + `.env.example`
- 新增 server 静态托管 Web 产物（单进程交付形态，SPA fallback）
- 新增运维部署文档 `docs/ops/deployment.md`

### 安全

- 凭据全程 DPAPI 加密存储 + 进程内存注入，明文永不落盘/入库
- `config.json` 禁止出现任何凭据字段（读取时主动扫描拒绝）

[Unreleased]: https://github.com/wsj502/water-ai-harness/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/wsj502/water-ai-harness/releases/tag/v0.1.0
