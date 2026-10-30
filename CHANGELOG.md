# 更新日志（Changelog）

本项目的所有显著变更都记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本管理遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

类型约定：`新增` / `变更` / `修复` / `移除` / `安全` / `文档` / `工程`

## [Unreleased]

### 新增（M12 · 子代理流式透传 + 可写模式）

- 新 LoopEvent `sub_event {callId, ev}`（自引用联合）：子代理事件实时透传——工具执行期**事件泵**（队列+wake）把子代理的轮次/思考/文本/工具调用实时 yield，task 工具卡从黑盒变直播
- `task` 新增 `mode: 'read' | 'write'`（默认 read）；`Tool.riskFor?(input)` **动态风险**——write 模式提升为 high 逐次审批，read 保持 medium
- write 模式工具集 read/grep/glob/write/edit（无 shell 无递归）；子级 write/edit 授权推理：父级已对 task(write)=high 把过关，子级以会话级授权放行（引擎既有 API，零核心改动）
- Web task 工具卡新增「🤖 子代理过程」折叠区：子工具时间线 chips（成功/失败/被拒）+ 文本预览 + 轮次计数
- vitest 3 用例（透传顺序与 callId/write 真实落盘+工具集断言/无审批保守拒绝且零落盘）

## [0.3.0] - 2026-10-30

v0.3.0 主题：**会话与工作区的管理权 + 内核能力补全（子代理/摘要压缩）+ 三端体验对齐**。

### 文档（M11 · 文章深挖第二批）

- 六篇旧文各追加「v0.3 深化补遗」：01（P0 期票兑现台账——"所见即承诺"的反噬复盘）、04（readline 管道丢行坑 + 双形态交付）、05（41 断言 E2E 如何守护三端协议一致性 + 反面教训）、06（SEA 实测体积/启动数据 + 杀软误报等已知坑）、07（**白名单安全模型三次复用**对照表 + MCP 现实局限 + OpenCode 配置式插件对照）、08（CI 实测耗时数据 + 发布实录交叉引用 + npm pack 审计纪律）

### 新增（M10 · CLI 内置命令）

- `water chat` 命令对齐 Web：`/help` / `/model`（注册表清单，含凭据就绪与当前项）/ `/model <id>`（协议随模型切换，下一条消息生效，缺凭据拒绝切换）/ `/compact`（预算=模型窗口×0.8，报告压缩结果）/ `/system`（生效 SYSTEM，含工作区 AGENTS.md）
- 未知 `/xxx` 显式拦截（不静默发给模型）
- **修复 readline 管道丢行**：`rl.question` 在两次提问之间到达的 line 事件会丢失（交互正常、脚本化 stdin 全毁）——改为事件驱动 + 行缓存的 ask
- SYSTEM 描述同步 M8（task 工具）；AGENTS.md 拼接与 server 行为一致
- 离线实测全命令（管道驱动 7 条输入逐一验证）

### 新增（M8 · 只读研究子代理）

- 新内置工具 `task`：派生子代理处理「先调研再回答」类子任务——`{prompt, description?}`，自包含研究问题
- 内核实现（依赖注入，零新顶层概念）：`ToolContext.spawnTask` 可选注入；`loop.ts` 构造**嵌套 agentLoop**——工具集 = 低风险只读（read/grep/glob）且**过滤 task 自身**；嵌套 ctx 不注入 spawnTask（双重防递归）；共享父级 AbortSignal（中断传播）；maxTurns 10
- 风险级 `medium`：不碰文件但每次派生是一整段子对话的 token 成本（审批放行 / 本会话总是允许）
- Web 工具卡 🤖 图标 + description/prompt 摘要
- vitest 4 用例（派生→真跑 glob→结论回填 / 防递归断言 / 无 spawnTask 明确报错 / 中断传播）；E2E 41 断言（task 在权限清单）
- 测试彩蛋：内核的保守拒绝（无审批渠道 medium→deny）先让测试红了——**行为正确，测试需要提供审批**

### 新增（M7B · 工作区注册表）

- **多根管理**：`~/.water/workspaces.json`（用户级注册表，红线扫描拒绝凭据字段）+ `WATER_WORKSPACES` 环境变量（开发/CI）+ 启动目录 `default`（永在、不可删、不可伪装）；id 归一化小写（Windows 路径大小写不敏感）
- `GET /api/workspaces` 白名单端点；**前端只能传注册表内 id，任意路径 400**（与模型端点同构的防目录逃逸安全模型）
- **会话绑定工作区**：`workspaceId` 创建时定死（DB 迁移加列），存续期不可换根；AGENT 工具执行根（`toolCtx.cwd`）、文件树/内容端点、SYSTEM（含各工作区自己的 `AGENTS.md`）全部按会话工作区解析
- Web：侧栏工作区选择器（多工作区时显示，决定下一个新会话的绑定）；会话条目展示非默认工作区徽标；工作区页随会话工作区切换
- E2E 扩至 40 断言（注册表/绑定/文件树按根/白名单拒绝/换根拒绝）

### 新增（M7A · 会话管理）

- **删除接线**：Web 侧栏会话项 hover 操作（🗑 删除带确认；busy 中服务端 409）——后端 `DELETE` 端点自 P3 存在，本次补上前端入口
- **归档语义**（前后端全新）：`archived` 字段（SQLite 迁移加列，重启保持）；归档会话从「最近会话」收起（`?archived=1` 独立列表）、**历史可查看但不可再发消息**（400 + 明确提示）；侧栏「最近会话 ↔ 📦 归档」过滤切换；composer 归档禁用态
- E2E 扩至 34 断言（归档→默认列表消失→归档列表可见→发消息 400→历史可看→取消归档→删除→404）

## [0.2.0] - 2026-10-30

v0.2.0 主题：**从「学习骨架」到「按公开标准运营的开源项目」**。
一天冲刺 P0-P6 之后，用 M0-M6 六个里程碑补齐工程化、内核深度与文档深度。

### 文档（M5 · 文章深化第一批）

- 新增《12-开源工程实践实录》：M0-M4 全部 GitHub 工作流归档——issue 先行/PR 模板/CI 抓 tsbuildinfo 真 bug 复盘/分支保护付费墙（403 实录）/tag 与 Release 语义/备忘 issue 分类学/变异验证/翻车实录（PAT scope、PS `--` 解析、coverage 误入库）/可复现命令速查
- 重写《02-Agent Loop 解剖》：补智谱真实 SSE 帧 dump（含 usage 双位置兼容）、失败模式分析表（中断半截消息 bug 等 5 项）、与 OpenCode Loop 的逐维对照、M2 压缩时序
- 深化《03-SSE 流式协议设计》：三方案选型表（含 EventSource 只支持 GET 的排除理由）、帧 id/seq 协议演进、断线状态机（用户中断≠网络断开）、刷新接流路径、v0.2 端点速查
- 导读索引补全 09-12

### 工程（M4 · 质量基建：vitest + 协议 golden 测试）

- 引入 vitest + @vitest/coverage-v8；`npm test` 一键全量（37 用例 / 5 文件），`npm run test:coverage` 出覆盖率
- 四套脚本测试迁移为标准用例（loop 闭环 / 上下文与重试 / markdown 与 diff），断言语义零损失；迁移后删除原脚本
- **新增 Provider 翻译层 golden 测试**：双协议「请求侧翻译 + 响应侧 SSE 解析」帧级锁定——system 抽取/thinking 丢弃/tool_result 角色/tool_calls 聚合/usage 读取/stopReason 映射/缺失 finish_reason 语义修正；变异演示确认能抓人为回归
- 新增 ProviderRegistry 单测（查找/凭据缺失指引/实例缓存复用/自定义模型优先）
- 覆盖率现状：context 100%、openai 95%、anthropic 92%（协议层咽喉被锁定）
- CI 收敛：三条脚本步骤合并为 `npm test`（E2E 独立保留）；CONTRIBUTING 命令同步

### 新增（M3 · Web 体验：渲染/回放/diff）

- 零依赖 markdown 渲染（`apps/web/src/markdown.ts` + `Md.tsx`）：手写子集解析器（围栏代码/标题/列表/引用/行内 code、粗斜体/链接），**返回 React 元素而非 HTML 字符串——不碰 innerHTML，XSS 免疫是架构保证**；链接协议白名单（http/https），`javascript:` 等降级纯文本
- SSE 事件回放：每会话维护事件环形缓冲（每条消息运行开始重置，容量 300），SSE 帧携带 `id: <seq>`；新端点 `GET /api/sessions/:id/events?since=<seq>` 增量拉取
- Web 断线补帧：流异常断开（非用户中断）自动轮询 events 端点直至 finish（10 分钟上限）；**刷新页面时 busy 会话可接上正在运行的事件流**
- edit 审批卡升级为行级 diff（`diff.ts` 朴素 LCS）：ctx 灰 / del 红 / add 绿 + `+N −M` 统计条，替换原"全删全增"渲染
- 新增 `test:web`（markdown 块级/行内/未闭合容错/**XSS 契约**/diff 三态，进 CI）；E2E 扩至 27 断言（帧 id 递增、回放完整性、增量游标语义）

### 新增（M2 · 内核深化：上下文管理与容错）

- 内核新增上下文管理器（`context.ts`，00-导读架构图「CTX」模块落地）：中英混合 token 估算启发式 + 确定性压缩（先裁旧 tool_result 带占位标记 → 再丢最旧轮次，保证首条非 system 消息为 user 的协议合法性）
- Agent Loop 每轮检查预算（模型注册表窗口 × 0.8，`WATER_MAX_CONTEXT_TOKENS` 可强制），超窗发新事件 `compacted`，Web 渲染压缩提示条
- 内核新增容错网关 `fetchWithRetry`：429/500/502/503/529 与网络错误指数退避重试（1s/2s/4s，尊重 Retry-After，上限 3 次）；**只在流首帧前重试**；用户中断不重试；fetch 超时 120s；双适配器全接入
- SYSTEM prompt 三级可配：`WATER_SYSTEM` env > `config.json systemPrompt` > 内置默认；工作区 `AGENTS.md` 存在则自动拼接为项目上下文
- 内置斜杠命令：`/model`（列模型）/`/model <id>`（切换）/`/compact`（立即压缩并报告）/`/system`（查看生效 prompt）——本地处理不进模型
- 修复：中断时半截 assistant 消息不再入历史（避免污染下一轮）；删除 `loop.ts` 中未实现的死分支
- 新增离线测试 `npm run test:context`（估算器/压缩三级策略/Loop 集成/重试与中断语义，进 CI）；E2E 扩至 21 断言（内置命令四条）

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

[Unreleased]: https://github.com/wsj502/water-ai-harness/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/wsj502/water-ai-harness/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/wsj502/water-ai-harness/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/wsj502/water-ai-harness/releases/tag/v0.1.0
