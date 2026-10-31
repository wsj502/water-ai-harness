# 更新日志（Changelog）

本项目的所有显著变更都记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本管理遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

类型约定：`新增` / `变更` / `修复` / `移除` / `安全` / `文档` / `工程`

## [Unreleased]

## [0.10.0] - 2026-10-31

v0.10.0 主题：**接流从轮询到推送——live 长连接**。M25 自适应退避治标（250ms 延迟仍在、空转轰炸只是缓和），M29 治本：服务端有事件就推，客户端零延迟收到。

### 新增（M29 · live 长连接端点 + Web 切换，#80）

- **`GET /api/sessions/:id/stream?since=N`**（SSE，帧格式与 POST 流逐帧一致）：存量补帧 → 非 busy 补完即关（刷新补帧语义不变）/ **busy 保持连接实时推送到 finish**；15s keepalive 注释帧防代理空闲断开
- **观察者与写者分离**：订阅挂在 `recordEvent`（事件进回放缓冲的唯一入口），POST 流发送逻辑一行未动；**宽限触发权只在写者**——live 建立 = 重连信号（取消宽限倒计时），live 断开不触发宽限（多观察者合法：多标签页关一个页面不杀运行）
- **Web 接流切换**：busy 接流与断线补帧改 live 优先（事件零延迟）；**失败/提前 EOF 回退 M25 轮询**（`/events` 端点原样保留为兜底层——代理/防火墙可能杀长连接，双层结构让上限提高而下限不变）；live 独立 AbortController，streamGen（#73）切换时一并作废
- **修掉一个真竞态**：首版收到 finish 同步关连接，E2E 抓到「9 帧缺 finish」——SSE 帧写入是异步的，关闭先于尾帧写入完成。修复：finish 帧写入完成的 Promise 才收尾（「发完了」≠「写完了」）
- E2E 第 19 节 6 断言（非 busy 补完即关 + 与回放逐帧等量 / busy 实时收 turn_start→finish / 宽限协同：POST 断开→live 接续、运行完整入史）

### 文档（M30 · 03 文章补遗，#81）

- 「从轮询到推送」：轮询曾是合理最小实现→何时成为天花板；三个关键选择（观察者分发 / 双模式 / 宽限权责分离）；尾帧写入竞态的翻车课；回退链的诚实

## [0.9.0] - 2026-10-31

v0.9.0 主题：**单主题架构版——同轮工具并发执行**。Loop 的最后一根串行假设（「工具串行执行，无并发竞争」曾是 M12 事件泵的实现前提）拆除，执行模型演进史收官。

### 新增（M27 · 同轮工具并发执行，#76）

- 模型一轮发起的多个 tool_use **并发执行**（`Promise.allSettled` + 外层事件泵——与 M12 子代理泵同构，审批卡/子代理直播照常实时到达）；`WATER_PARALLEL_TOOLS=0` 可整体回退串行
- **execCtx 每工具克隆**：替换原「临时改共享 spawnTask + finally 恢复」——并发下的共享可变状态陷阱（互相覆盖），克隆后 restore 逻辑整个删除
- 语义定案（issue #76 定稿）：
  - **失败不中断同伴**（allSettled）：一个工具 throw，其余照常完成，失败结果照常回填——与串行时代的 per-call try/catch 语义零漂移
  - **tool 消息按完成序回填**：Anthropic/OpenAI 协议只要求 `tool_use_id` 匹配不要求顺序
  - **同文件并发写后写覆盖**（无锁，文档化）：与主流 harness 一致，上锁会把「写同一文件」变死锁源
- 并发下自然成立（当初设计红利）：M15 审批命名空间（子级审批 callId 前缀隔离）/ M19 审批桥（按 callId 寻址对并发到达无感）/ 权限引擎（同步 Set 操作无竞争）
- mock 剧本 `[[mock:parallel]]`（一轮两个 write，离线确定性复现）
- vitest 96→**102**（并发时序 / 失败不中断 / 并发审批双卡 / env 回退 / 并发子代理命名空间）；E2E 第 18 节 5 断言；**96 个旧用例零改动全绿**

### 文档（M28 · 02 文章补遗，#77）

- 「并行化：串行假设的最后一根支柱」——三次演进共享同一个泵（M12 发明、M27 复用）/ 三个设计决策的为什么 / 并发下自然成立的机制 / 诚实的已知语义清单

### 为什么单主题成版

执行模型是 Agent Harness 的心脏，此前五次演进（M8 派生/M12 可写/M15 审批透传/M18 时间线/M21 继承）都在串行地基上加层；这次动地基，独立成版让评审面与回退面都最小。

## [0.8.0] - 2026-10-31

v0.8.0 主题：**容器交付落地与 BYOK——从「本地学习项目」到「可部署的自用工具」**。五个 issue 全部来自真实部署/使用反馈（Docker 容器化实测、真实模型接入、连续两批 UI 体验反馈）。

### 新增（#67 · BYOK：Web 端安全录入 API Key）

- 容器/远程部署想补 key 不再需要 SSH 改 `.env` 重启——Web 设置页「API 密钥」区按模型注册表分组录入（来源徽章 env/byok/未配置 + 尾 4 位提示 + 清除）
- **收 key 不收 baseUrl（M1 定案不回退）**：凭据入口（可开放）与凭据目的地（白名单封死）分离设计；key 只存服务端内存（永不落盘/进日志，重启即清并 UI 明示），任何响应只回显尾 4 位（E2E 有全响应体 includes 检查）
- 解析优先级 BYOK > 进程 env；`/api/models` 的 `hasKey` 动态化（录入即翻转，模型菜单立即可用）；`ProviderRegistry.invalidate()` 处理运行期换 key 的缓存实例（vitest 对象身份级用例）
- **行为变更**：服务端无凭据启动从拒绝改为警告 + BYOK 指引（容器可裸起等录入）
- vitest 96 用例（+2）；E2E 第 17 节 15 项断言（独立无凭据非 mock server：动态翻转/不串扰/永不回显/非法名拒绝/清除回落）
- 09 号文章补遗「BYOK：收 key 不收 baseUrl」；`tools/__pycache__` 误跟踪顺手清理

### 修复（#65 · Docker 交付）

- 补缺失的 `.dockerignore`（node_modules/Rust target/SEA 产物/.git 全排除）——构建上下文从 GB 级降到 **961.5kB**；Dockerfile/compose 标签追平
- 部署验证：镜像构建 → 容器 healthy → 冒烟 8/8；翻车实录（dockerignore 的 `*` 不跨目录 + TS 「见新 tsbuildinfo 跳过构建不查 dist」叠加曾致构建失败）沉淀于 PR #66

### 修复（#69 · Web UI 五项，含两个 P0 时代隐性 bug）

- **滚动条缺失/内容被裁（根因×2）**：grid 中间行改 `minmax(0,1fr)` + 相关容器补 `min-height:0`；**考古发现 `:root` 布局变量块从 P0 起丢失选择器头**（孤儿声明被浏览器丢弃，`--sidebar-w/--topbar-h` 等从未生效过；esbuild 的 css warning 一直在报此事）
- 侧栏右缘拖拽调宽（180~480px，双击复位，localStorage 记忆）
- 智能吸底：接近底部才跟随新内容（上翻阅读不拽回）；切换会话直达底部
- 归档入口重做：分段切换「会话 | 📦 归档」替代隐形图标
- vite 关闭 esbuild css 压缩（其 parser 对 custom property 带引号值解析断裂）——**构建首次零警告**

### 新增（#71 · 导航闭环）

- 跨页点击会话自动切回会话视图（此前在任务/插件/设置页点会话"看似无效"）
- 任务页详情新增「查看会话」跳转——任务源自提问，看完执行步骤一键回到当时完整对话

### 修复（#73 · 跨会话流污染）

- 会话 A 流式中切到 B，A 的旧流事件不再灌进 B 的视图：`streamGen` 归属代际作废三条事件泵（SSE handle / M19 busy 接流轮询 / 断线补帧循环）+ `finally setBusy` 守卫（旧泵不清新会话 busy）
- 本地作废不违背 M19 宽限语义：服务端运行照常受保护，回到原会话由 busy 回放/历史水合接上（`WATER_MOCK_RTT_MS` 慢剧本双场景行为验证）

### 为什么是这个版本

用户把 Water 当自用工具部署（Docker + 真实智谱模型）后连续提出两批共 7 项体验反馈——本版五个 issue 全部来自真实使用；BYOK 是其中唯一的协议层新能力（升 minor 的依据），其余为修复与体验收敛。

## [0.7.0] - 2026-10-30

v0.7.0 主题：**兑现三端承诺——桌面端回归 + 体验调优**。立项全部来自已记录的债务（v0.6.0 Release notes 已知限制 + README「三端 ✅」的宣称缺口），延续 v0.6「立项不是想新点子，是兑现承诺」。

### 新增（M24 · 桌面端回归）

- 桌面端自 P5 后首次回归：SEA sidecar 重建（esbuild → sea blob → 官方 node v24.18.0 基座 → postject 注入，92.85MB 单文件），Tauri externalBin 槽位同步刷新——README「三端 ✅」从宣称变事实（#58）
- 壳凭据判定与 server 侧 `config.ts` 链路对齐：`WATER_MOCK` 显式设置永远优先（原实现无条件覆盖，用户设 `=0` 也被改回 1）；否则按 `WATER_API_KEY_ENV` 指向变量 → `ZHIPU_API_KEY` / `DEEPSEEK_API_KEY` 顺序找凭据，全无则保守 mock——桌面端不因缺 key 黑屏
- `tauri.conf.json` / `Cargo.toml` 版本号从 0.1.0 追平（此后随发版流程统一 bump）
- SEA 冒烟 11 断言全过（探活 / 版本 / mock / 会话创建 / SSE 剧本到 finish / 帧 id 单调 / 事件回放 / 持久化）；06 文章新增「v0.7 回归记录」

### 新增（M25 · 体验调优）

- **Web 接流轮询自适应退避**：有新事件间隔重置 250ms（跟手），空转逐级退避封顶 1200ms（不轰炸）——busy 会话接流与断线补帧两处同改，替代原固定 1000/1500ms（#59）
- **CLI `--quiet` 显式 flag**（`water chat` / `water run`）：TTY 下强制静默子代理时间线，只要结论——脚本化录制/演示可用；非 TTY 自动判定不变
- **授权 key 路径归一化**：read/write/edit 的 `argSummary` 归一（去 `./` 前缀、`\`→`/`）——`./a.txt` 与 `a.txt` 不再是两个 session grant key，M21 文件粒度继承不被模型写法差异绕过；保守边界：相对段（`./sub/../a.txt`）不做全量规范化——权限 key 宁可少合并（多问一次），不可误合并（漏问是安全缺口）
- README「开发」一节断言数漂移修正（去数字方案防复发，#57）
- vitest 90 → 94 用例（路径归一化矩阵 + 跨写法继承集成 + 显式 quiet 双向契约）

### 文档（M26 · 文章补遗）

- **12 开源实录** v0.7 补遗：回归债成本核算（29 行壳改动 vs 四代协议零回归的复利）/「测试期望错了修期望」现场课（`/api/config` mock 字段乌龙）/ 授权 key 唯一性原则（与缓存键、幂等键同构）/ 翻车三条（isTTY spy 挂载失败、Actions API 缓存延迟下钻 step、模板串手滑）
- **00 导读**：版本演进补 v0.7；06 索引标注「含 v0.7 回归记录」

### 为什么是这三个里程碑

桌面端是当前最大的「宣称与现实缺口」（README 公开承诺三端，desktop 却四代协议零回归）；体验三项全部来自 v0.6.0 Release notes 白纸黑字的已知限制。HTTP 工具重试/缓存涉及幂等性与缓存键的语义定案，独立留给 v0.8——不赶余量。

## [0.6.0] - 2026-10-30

v0.6.0 主题：**一致性与承诺兑现——审批回放统一 / CLI 时间线对齐 / 子级授权继承 / HTTP 型配置工具 / 文章第三批**（五个里程碑全部对应 v0.5.0 已知限制或 M17 定案承诺）。

### 文档（M23 · 文章深化第三批）

- 四篇追补 + 导读更新，沉淀 v0.4/v0.5/v0.6 共十一个里程碑的决策过程（写「为什么」而非流水账）：
  - **02 Loop 解剖**：子代理四次演进（M8→M12→M15→M21）——每一步都是「上一个机制的隐含假设被打破」；M21 三条继承红线（数据形状承载安全性质）
  - **03 SSE 协议**：两级闸门（会话内串行/会话间并行）与审批桥完整状态机（命名空间→入缓冲→断开宽限）；E2E「用确定性事件证明并行」的测试元经验；两个被宽限期暴露的旧隐患
  - **07 插件系统**：白名单安全模型第四次复用（M17 prompt 型 / M22 http 型三件套）；分层信任与单遍插值的注入防御；五次复用对照表
  - **12 开源实录**：v0.5→v0.6 发版节奏；五条翻车实录（PS5.1 重定向吞 gh、wall-clock flaky、E2E 到达序竞态、并行化次生 bug、迁移丢语义）；「issue 是决策的可寻址存档」
  - **00 导读**：新增「版本演进（M 系列）」小节；索引表标注补遗；修正过时红线（私仓→已公开）
- 防漂移：动笔前核对代码现状（07 实际标题、render.ts 现状、私仓红线均已按事实修正）

### 新增（M22 · HTTP 型配置工具）

- config 工具条目新增 `kind: 'prompt' | 'http'`（缺省 prompt，向后兼容）——M17 定案时暂缓的出网能力落地，「配置即插件」补全另一半
- http 形状 `{ url, method?, headers?, body? }`：`$参数` 与 `$env:变量名` **单遍插值**（正则合一，替换结果不二次解释）；凭据值只来自进程环境（DPAPI 注入链路天然兼容），**永不入 config、不 echo 进错误信息**
- **域名白名单（防 SSRF）**：顶层 `allowedHttpHosts: string[]`；http 工具 url host 不在白名单（或未配置白名单）启动即拒——绝不裸放行
- 边界：method 白名单（GET/POST/PUT/DELETE/PATCH）、超时 10s（参数化）、响应截断 64KB、url 必须是合法绝对 http(s)
- **风险级 high + riskFor 恒 high**：出网是可观测副作用，逐次审批
- vitest 7 用例（解析 4：合法/白名单红线/形状矩阵/缺省契约；执行 3：双插值+header 透传+响应回填 / $env 未设报错+截断 / 超时——本地 node:http fixture）；E2E 第 16 节：mock HTTP server 全链路（high 审批经审批桥 → $text 出网 → 响应回填 → $env 凭据到达服务端）

### 新增（M21 · 子级授权继承）

- 子级 write/edit 的「session」授权按文件粒度**上浮**父会话引擎（`write:<路径>`），后续子代理构造时**继承**——同会话重复派生写同一文件不再二次打扰（v0.5.0 已知限制③收口）
- 粒度红线（M15 语义不回退）：「once」不上浮；`task(write)` 的 session 授权不隐含子级写授权（派生≠写入）；**主循环裸 write 会话授权不继承**（`inheritableGrants` 只导出带参前缀 key——主循环的信任不外溢为子代理写权限）
- PermissionEngine 新增 `initialGrants`（构造预置）与 `inheritableGrants(prefixes)`（可继承导出）；上浮在 `subApprove` 包装内完成（session 决策 → 父引擎 `grantSession`）
- vitest 5 用例锁定语义矩阵（同文件跨子代理免问 / 跨文件仍问 / once 不上浮 / task session 不隐含 / 裸授权不继承）

### 新增（M20 · CLI 子代理时间线）

- `TermRenderer` 增加 `sub_event` 折叠渲染：缩进时间线（轮次分隔行 / 工具行 + 状态符 / 文本流 / 审批结果行），与 Web M18 时间线**同语义、终端表达**——子代理过程在 CLI 从完全不可见变为结构化呈现（此前 render.ts 对 sub_event 没有任何 case，静默丢弃）
- quiet 模式（非 TTY / 管道 / 重定向自动判定，可显式覆盖）下子代理过程静默：不打爆脚本化输出，主循环 `tool_result` 已有结论；`--json` NDJSON 模式天然透传（零改动）
- 渲染细节由 vitest 直测渲染器锁定（spy stdout：非 quiet 结构 / quiet 静默 / 文本流收尾）；另做真实管道实测（`water run --yes` + mock 剧本重定向）

### 新增（M19 · 审批回放统一）

- 主循环 `approval_required` 帧进回放缓冲（与 M15 的子级审批帧对称）——此前它是瞬时事件，刷新即丢；回放出的审批卡由后续 `tool_approved` / `tool_denied` 帧收拢到终态，复用 M18 的折叠语义
- **断开宽限期**：SSE 断开不再立即中断运行——期内重连（读取 `events` 回放端点即视为重连信号）可继续；超时（`WATER_APPROVAL_GRACE_MS`，默认 60s，设 0 回到旧语义）才中断 Loop + 悬挂审批全拒，安全兜底不放松
- **为什么**：回放能力与悬挂审批安全存在张力——「断开即全拒」把刷新页面这种正常操作也当成放弃；宽限期把「断开」与「放弃」区分开，代价是客户端真正离开后运行会多活至多一个宽限期（Esc 中断仍是显式取消路径）
- 服务端 SSE 写全部改经安全发送（`send`）：宽限期内向已断开流写帧失败不中断运行——事件始终先进回放缓冲，断开只损失实时性不损失正确性
- Web busy 会话接流修复：历史只水合到本次运行的最后一条 user 消息（其后由回放渲染，消除与运行内已入史消息的重复）；轮询改用递增游标逐段补帧（此前每轮重放 since=0，多轮会重复累积文本——旧语义下断开即死所以从未暴露）
- vitest 宽限状态机 2 用例（超时触发/重连取消/幂等）；E2E 第 15 节：断开→宽限存活→重连审批（主+子）→完整结束→busy 解除

## [0.5.0] - 2026-10-30

v0.5.0 主题：**子代理闭环（审批透传 + 嵌套时间线 UI）、跨会话并行调度、配置式声明工具**。

### 新增（M15 · 子代理审批透传）

- write 模式子代理的 write/edit 不再「父级批准一次、子级全程放行」（撤销 M12 的会话级预授权）：每次写入经事件泵路由到父级审批桥，callId 加 `${task调用id}:${子id}` 命名空间——pending 挂起、审批端点、断开全拒语义与主循环完全复用
- 服务端把子级审批包成 `sub_event` 嵌套帧广播并进回放缓冲（刷新接流后审批卡可重现，后续 tool_approved/tool_denied 帧收拢状态）；Web task 工具卡新增子级审批条（允许一次/拒绝，直接 POST 命名空间 callId）
- CLI 零改动复用：approve 是进程内回调，子级审批以 `[子代理]` 前缀提示
- 兜底不放松：无审批渠道时子级 write/edit 保守拒绝、零落盘（vitest 锁定）；「session」授权记在子级引擎、key=write:<路径>——同文件免重复审批，跨文件/跨子代理不扩散
- MockProvider 新增标记驱动剧本（`[[mock:m15-task]]` / `[[mock:m15-sub]]`，默认行为不变）——离线 E2E 确定性复现子级审批批准/拒绝双路径

### 新增（M16 · 跨会话并行调度）

- 全局并行闸门 `ParallelGate`（`apps/server/src/gate.ts`）：**会话间并行、会话内串行**（M14 语义不变）；上限 `WATER_MAX_PARALLEL_SESSIONS`（默认 3），超限跨会话 FIFO 排队——持有者释放时槽位直接转交队首（不经历空窗）；排队中放弃只撤回自己的号（不误伤队首）；release 幂等（单测逐项锁定）
- `queued` 事件新增 `scope: 'session' | 'global'`（向后兼容，缺省即 session）；全局排队期间断开/会话被删除 → 跳过执行、释放两级闸门（沿 M14 语义 + 并发下的悬挂引用防护）
- `/api/config` 暴露 `maxParallelSessions`；Web 全局排队提示（🌐 跨会话排队，前面 N 个）
- **并发正确性结论（为什么）**：审批桥 pending、SSE 回放缓冲、任务记录本就按会话实例隔离（本次补单测锁定）；SQLite 落库用 node:sqlite `DatabaseSync` **同步 API——事务在单线程事件循环上天然串行，不存在交错窗口**，无需额外锁；Provider 实例按 (protocol, baseUrl, apiKeyEnv) 缓存共享，per-request 无会话态
- E2E 并行实证：两会话挂起审批占满 2 槽（busy×2 轮询确认）→ 第三会话收到 `scope=global` 排队帧（**该帧本身就是前两者并行的证据**）→ 放行后三会话全部完成、历史互不污染

### 新增（M18 · 子代理事件嵌套 UI——时间线视图）

- 子代理过程从扁平 chips 升级为**时间线**：按轮次分组、缩进嵌套（文本 / 工具 / 审批节点对齐主消息流的表达）、状态着色（运行中 / 成功 / 失败 / 被拒），工具节点带结果预览
- M15 子级审批卡移入时间线成为一等节点：审批到来时折叠区自动展开（仅展开、绝不强制收起）+ summary 徽标提示待审批数，批准/拒绝后就地收拢状态
- 折叠器数据结构 `subTimeline`（轮次分组节点树）取代 subText/subTools/subApprovals 扁平累积；`argSummary` 下沉到 blocks.ts（主工具卡与时间线共用）
- **直播与回放同构**：时间线由 sub_event 帧序列确定性折叠——vitest 锁定「同一帧序列两次折叠结果完全一致」，回放（`?since=`）天然重建同一视图
- 零新前端依赖（React 元素渲染纪律不变）；water.css 新增时间线样式（轮次竖线缩进）

### 新增（M17 · 配置式声明工具——配置即插件进阶）

- `~/.water/config.json` 新增 `tools: [{ name, description, template, parameters? }]`：声明 JSON Schema 的工具启动时直接进注册表，模型可见可自主调用——「零代码扩展」从命令层（M13）推进到工具层
- **执行语义 = prompt 型（issue #39 定案）**：工具调用 → 模板中 `$参数名` 替换为入参 → 渲染文本作为 tool_result 返回；零副作用（不碰文件/网络/命令）→ 风险级 low；与 M13 命令同源的安全模型，HTTP 型（凭据红线 + 防 SSRF 面大）明确暂缓
- 安全底线：字段白名单（仅 name/description/template/parameters，无任何执行体字段——夹带 command 即拒）；description 必填（模型靠它决策）；与内置/其他声明重名启动即拒
- `configToolToTool` 包装器在内核（tools/index.ts，可单测）；`/api/plugins` 暴露 `configTools` 清单，插件页新增「🔧 配置式工具」卡
- MockProvider 新增 `[[mock:m17tool:<名>]]` 剧本；E2E 第 14 节实证「声明 → permissions 可见 → mock 调用 → 模板 `$text` 展开回填」
- **修复两处并行化/注册表问题**：① 插件加载后 `allTools` 被重置导致配置式工具在插件存在时丢失（合并三源：内置 + 配置式 + 插件）；② 并发会话同毫秒完成时任务 id `t_<毫秒>` 撞 tasks 主键——id 追加随机后缀（与 Session id 同模式，#43）

## [0.4.0] - 2026-10-30

v0.4.0 主题：**子代理全能力（流式+可写）、配置式扩展、会话消息排队**。

### 新增（M14 · 会话消息排队）

- busy 不再 409：新消息**自动排队**——Session 维护 promise 链闸门（`enqueueTurn`），按到达顺序串行执行；排队请求先收 `queued` 事件（含位置，瞬时事件不进回放缓冲）
- 深度上限 5（含执行中），超出 **429**；排队期间客户端断开 → 跳过执行直接放行（不占位、不留悬挂历史）
- 中断监听移入获得执行权之后（修复隐患：排队请求断开误杀正在运行者的悬挂审批）
- 会话列表暴露 `queued` 数，Web 侧栏显示「排队 N」、消息流显示「⏳ 已排队（第 N 位）」
- MockProvider 每轮加 ~150ms 网络节奏（`WATER_MOCK_RTT_MS` 可调）——离线体验贴近真实，且让排队行为可被 E2E 确定性触发（无延迟时执行快于请求到达抖动）
- vitest 2 用例（闸门顺序/计数、中途放弃不阻塞）；E2E 47 断言（并发按序入史、429 上限）

### 新增（M13 · 配置式命令 + MCP 多 server）

- **配置式命令（零代码插件）**：`~/.water/config.json` 新增 `commands: [{name, template, description?}]`——纯 prompt 模板（`$ARGUMENTS` 替换），无执行逻辑；字段白名单校验（防夹带 command 等危险字段）；分发优先级 内置 > ESM 插件 > 配置式；`/api/plugins` 返回 `configCommands`，插件页新增「📄 配置式命令」卡
- `WATER_CONFIG_FILE` 环境变量：配置路径覆盖（测试/多环境注入）
- **MCP 多 server**：`.water/mcp.json` 支持业界通行形状 `{"mcpServers": {"name": {"command","args","env"}}}`（Claude/OpenCode 同构）；server 级 `env` 注入随子进程隔离；旧版 `servers[]` 兼容读取并告警迁移
- vitest 5 用例（解析/非法 name/字段白名单/凭据红线/exactOptionalPropertyTypes 契约）；E2E 44 断言（清单可见 + **$ARGUMENTS 展开以历史消息实证**）

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

[Unreleased]: https://github.com/wsj502/water-ai-harness/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/wsj502/water-ai-harness/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/wsj502/water-ai-harness/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/wsj502/water-ai-harness/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/wsj502/water-ai-harness/releases/tag/v0.1.0
