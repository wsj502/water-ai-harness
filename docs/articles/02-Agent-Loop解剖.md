# 02 · Agent Loop 解剖：模型和工具如何跳双人舞

> 阶段：P1 起步，M1/M2 深化 ｜ 代码：`packages/core/src/loop.ts`
> 本篇回答一个问题：**从用户敲下一句话，到模型改完代码，中间到底发生了什么？**
> v0.2 版按「深挖六要素」重写：补真实帧 dump、失败模式、与 OpenCode 的对照。

## 全景时序（M2 后的最新形态）

```mermaid
sequenceDiagram
    participant U as 用户
    participant L as Agent Loop (loop.ts)
    participant A as Provider 适配器
    participant M as 大模型 (GLM/DeepSeek)
    participant P as 权限引擎
    participant T as 工具 (tools/)

    U->>L: "重构鉴权中间件"
    loop 每一轮 turn（上限 maxTurns 防失控）
        L->>L: 上下文预算检查（M2）<br/>超窗 → 确定性压缩 → compacted 事件
        L->>A: chat(WMessage[], ToolSpec[], signal)
        A->>A: WMessage → 厂商线协议
        A->>M: POST /v1/messages (SSE, 带重试网关)
        M-->>A: SSE 事件流
        A-->>L: StreamEvent（text/thinking/tool_use/usage/done）
        L-->>U: LoopEvent 流（UI 实时渲染）
        alt 模型请求工具（stopReason=tool_use）
            L->>P: check(工具名, 风险级, 参数摘要)
            alt 需审批
                L->>U: 审批卡（once/session/deny）
                U-->>L: 决定
            end
            L->>T: run(input, {cwd})
            T-->>L: 结果文本
            L->>L: 结果回填为 tool 消息，进入下一轮
        else 纯文本回复（stopReason=end）
            L-->>U: finish(end)，循环结束
        end
    end
```

## 一段真实的智谱 SSE 流（2026-10-30 GLM-4.6 实测，节选）

```
event: turn_start
data: {"type":"turn_start","turn":1,"model":"glm-4.6"}      ← M1：模型标识进协议

event: thinking_delta                                     ← 思考通道（英文思考是模型行为）
data: {"type":"thinking_delta","text":"The"}
data: {"type":"thinking_delta","text":" user"}

event: text_delta                                         ← 正文
data: {"type":"text_delta","text":"pong"}

event: usage                                              ← 真实计量（见下文智谱兼容坑）
data: {"type":"usage","inputTokens":67,"outputTokens":136}

event: finish
data: {"type":"finish","reason":"end"}
```

完整一次工具调用回合约 312 帧。**注意 usage 的位置**：智谱端点在
`message_start` 里恒报 0，真实值在 `message_delta`——适配器两处都读
（`anthropic.ts`，这是联调实测踩出来的厂商差异，golden 测试已锁定）。

## 核心设计一：Water 消息模型（types.ts）

内核不认识任何厂商协议，只认自己的消息模型。**一条消息 = role + parts[]**：

```mermaid
classDiagram
    class WMessage { +Role role; +Part[] parts }
    class TextPart { +text }
    class ThinkingPart { +text }
    class ToolUsePart { +id; +name; +input }
    class ToolResultPart { +toolUseId; +content; +isError }
    WMessage --> TextPart
    WMessage --> ThinkingPart
    WMessage --> ToolUsePart
    WMessage --> ToolResultPart
```

为什么用 parts 而不是 `content: string`？Anthropic 的 content block 和
OpenAI 的 tool_calls 在结构上都是「一条消息里有多个异构块」，parts 数组
是两者的**最小公倍数**，翻译无损（帧级证据见 golden 测试
`tests/providers.golden.test.ts`）。

一次完整工具调用的历史结构：

```
[0] system(text)                      ← 系统提示（含 AGENTS.md，M2）
[1] user(text)                        ← 用户输入
[2] assistant(thinking,text,tool_use) ← 模型：思考 + 正文 + 请求工具
[3] tool(tool_result)                 ← 内核：执行结果回填
[4] assistant(text)                   ← 模型：基于结果给结论
```

## 核心设计二：协议差异全部收敛在适配器

| 差异点 | Anthropic Messages | OpenAI 兼容 | 适配器做法 |
|---|---|---|---|
| system 位置 | 顶层 `system` 字段 | `messages[0]` | anthropic.ts 抽出；openai.ts 内嵌 |
| 工具结果角色 | `user` 消息包 `tool_result` 块 | 独立 `role:'tool'` | 双向各自转换 |
| 工具调用格式 | `tool_use` content block | `tool_calls[].function` | 双向各自转换 |
| 鉴权头 | `x-api-key` + `anthropic-version` | `Authorization: Bearer` | 构造时写死各自风格 |
| 思考通道 | `thinking_delta` 事件 | `delta.reasoning_content`（DeepSeek 约定） | 都映射为 `ThinkingPart` |
| 参数流式 | `input_json_delta` 碎片 | `function.arguments` 碎片 | 各自按 index 聚合后再发 `tool_use` |
| usage 上报 | `message_start`+`message_delta` 两处（智谱差异） | 尾部 `usage` 帧 | 各自兼容 |

**关键决策：思考块不回传。** 历史里的 thinking 对后续推理没有价值，还浪费 token
（Anthropic 官方甚至要求带 signature 才能回传）。适配器在翻译历史时直接丢弃。

## 核心设计三：权限在 Loop 内、执行前

```mermaid
flowchart LR
    TC[tool_use 请求] --> CHK{权限引擎 check}
    CHK -->|低风险+开关开| RUN[直接执行]
    CHK -->|会话已授权| RUN
    CHK -->|需审批| ASK[approve 回调<br/>CLI/Web 各自实现交互]
    ASK -->|once| RUN
    ASK -->|session| G[记忆会话授权] --> RUN
    ASK -->|deny| DENY[回填拒绝消息<br/>告知模型勿重试]
```

两个细节：

1. **拒绝也是结果**：deny 不是静默丢弃，而是把「用户拒绝了，请说明如何继续」
   回填为 tool_result——模型需要这个信号调整策略，否则会卡在同一调用上重试。
2. **无交互渠道时保守拒绝**：`approve` 回调缺省时 ask 直接降级为 deny
   （tests/loop.test.ts 有专门用例）。后台任务、批处理场景下宁可不做，不可乱做。

## 失败模式分析（踩过并修掉的坑）

| 失败模式 | 0.1 行为 | 现行为 | 发现方式 |
|---|---|---|---|
| 用户中断（Esc） | **半截 assistant 消息仍入历史**，下一轮模型看到自己"话说一半" | 中断即丢弃半截消息，直接 finish(aborted) | M2 代码审查 |
| 工具抛异常 | try/catch 回填错误文本 ✅ 一直是对的 | 不变 | — |
| 429/网络抖动 | 一次失败 = 会话死亡 | 重试网关（首帧前退避重试，M2） | 真实联调偶发 |
| 上下文超窗 | provider 400，会话死亡 | 确定性压缩 + compacted 事件（M2） | 设计推演 + 强制预算测试 |
| 死循环 | maxTurns=20 硬上限 ✅ | 不变；清理了未实现的死分支 | M2 清理 |

## 与 OpenCode 的 Loop 对照（读源码笔记）

| 维度 | OpenCode | Water | 差异本质 |
|---|---|---|---|
| 审批位置 | Loop 内、执行前，permission ask | 相同 | 殊途同归——这是正确解，不是巧合 |
| 上下文管理 | compaction（LLM 摘要任务） | 确定性压缩（裁剪优先） | Water 先做可解释版本，摘要留接口 |
| 重试 | Provider 层 | 请求建立层（首帧前） | 同一纪律：不重复已产出的 token |
| 子代理 | Task 工具派生子会话 | 无（路线图） | Water 的下一步方向 |
| 中断语义 | abort signal 贯穿 | 相同 + 半截消息丢弃 | OpenCode 修复过同类 bug |

## 验证

- `tests/loop.test.ts`：两轮闭环 + 历史结构断言 + 无审批渠道保守拒绝
- `tests/providers.golden.test.ts`：翻译层帧级锁定（含智谱 usage 兼容）
- `tests/context.test.ts`：压缩三级策略 + Loop 集成（compacted 事件 + 模型视角合法性）
- 真实联调：GLM-4.6 / 4.5-air 双模型切换全程 SSE 正常（文章 09）

**下一篇**：03 讲这条事件流如何穿过 HTTP 到达三个前端。

## v0.6 深化补遗：子代理的四次演进（M8 → M12 → M15 → M21）

正文写的是 P1 时代「单层 Loop」的解剖。此后子代理把 Loop 变成了递归结构，四次演进每一步都是「上一个机制的隐含假设被打破」：

| 版本 | 机制 | 打破的假设 | 教训 |
|---|---|---|---|
| M8 | 只读研究子代理：工具集过滤 + 嵌套 ctx 不注入 spawnTask（防递归双保险） | 「Loop 只有一层」 | 递归防护要结构性（不注入能力）而非规则性（约定不调用） |
| M12 | 流式透传（事件泵：队列 + wake promise）+ write 模式（riskFor 动态风险） | 「工具执行是原子的」——工具内部还有一整个 Loop 在产事件 | 工具的边界≠事件的边界；事件泵让「黑盒工具」变「直播工具」 |
| M15 | 审批透传：撤销 M12 的会话级预授权，子级写操作逐次经 `${父callId}:${子id}` 命名空间路由到父审批桥 | M12 的授权推理「父级批准派生=子级写已授权」——**审批粒度错位**：高风险动作（改文件）在子级，审批却停在派生那一刻 | 派生≠写入。授权的粒度必须对齐风险发生的粒度 |
| M21 | 授权继承：子级 session 决策按文件粒度上浮父引擎，后续子代理继承 | M15 的「子级授权生命周期=单个子代理」——保守但重复打扰 | 便利性可以让步粒度，但不能让步红线（见下） |

### M21 的三条红线（继承不等于放开）

继承的实现只有两处：`PermissionEngine.inheritableGrants(['write:', 'edit:'])` 导出**带前缀的** key，子引擎 `initialGrants` 预置；session 决策在 `subApprove` 包装里上浮。真正的设计在**不继承什么**：

1. **once 不上浮**——「批一次」的语义就是一次；
2. **task(write) 的 session 授权不隐含子级写**——派生授权与写授权是两个粒度（M15 的核心结论）；
3. **主循环裸 write 会话授权不外溢**——`inheritableGrants` 只导出 `write:<路径>` 形态的 key，裸 `write`（无路径限定）被前缀过滤结构性排除。用户在主循环里「本会话总是允许 write」的信任，不该自动变成「任何子代理都能写任何文件」。

第三条最有意思：它不是运行时检查，而是**数据形状**保证——只有带参数的 key 才可能被继承。安全性质由结构而非逻辑分支承载，这是权限引擎一以贯之的做法（对照 07 篇的白名单复用）。

### 无审批渠道时的兜底从未变过

M8/M12/M15/M21 四次演进里有一条不变的底线：`opts.approve` 缺失时，子级 write/edit 走「引擎 ask → 无路可问 → 保守拒绝 → 零落盘」。每次给审批加新路（透传、继承），vitest 都重新锁一遍这条兜底——能力越复杂，兜底越要钉死。

## v0.9 补遗：并行化——串行假设的最后一根支柱（#76）

loop.ts 里有一行注释自白了很久：「工具串行执行，无并发竞争」（M12 事件泵的实现前提）。
M27 把这根假设拆了：**同一轮的多个 tool_use 并发执行**。这不是加功能，是还债——模型一轮发起
3 个 read，串行跑完才回填，对 I/O 型工具是纯粹的延迟浪费。

### 三次演进共享同一个泵

M12 为子代理直播发明了事件泵（channel + wake 排水）；M27 发现它恰好是并发化的答案：
把「单工具执行流」抽成 `runOne(call, push)`（yield 换成 push），同轮多工具各跑一个 `runOne`，
外层套一个**同构的泵**实时排水——审批卡、子代理直播、工具结果的到达序原样保留。
两个泵只差一层：M12 泵在工具内部（sub_event 包装），M27 泵在工具之间。

### 三个设计决策的「为什么」

1. **allSettled（失败不中断同伴）**：一个工具 throw，其余照常完成，失败结果照常回填。
   串行时代的 `try/catch per call` 本来就是这个语义——并发化只是把它从「顺序容忍」升级成
   「同时容忍」，语义零漂移；
2. **tool 消息按完成序回填**：Anthropic Messages 与 OpenAI Chat 都只要求 tool_result 的
   `tool_use_id` 匹配，不要求顺序——协议层早已为并发准备好了；
3. **execCtx 每工具克隆**：原实现「临时替换共享 `execCtx.spawnTask`、finally 恢复」在串行下
   无害，并发下是经典的共享可变状态陷阱（互相覆盖 + 恢复错乱）。克隆让每个工具拿到自己的
   包装（注入自己的 callId），restore 逻辑整个删除——**并发问题的最优解常常是消灭共享，
   而不是加锁**。

### 并发下自然成立的东西（当初设计的红利）

- **审批命名空间（M15）**：子级审批 callId 带 `${父调用id}:${子id}` 前缀——并发子代理的
  审批卡天然隔离，vitest 并发用例直接验证；
- **审批桥（M19）**：按 callId 寻址的 POST 端点对并发到达无感；
- **权限引擎**：`check`/`grantSession` 是同步 Set 操作，单线程 JS 无竞争——不需要改一行。

### 诚实的已知语义

- **同文件并发写：后写覆盖**（无锁）。与主流 harness 一致，靠模型自律避免（system prompt
  层面引导）；上锁会把「写同一文件」变成死锁源（两个工具互相等待），代价大于收益；
- **事件到达序 ≠ 声明序**：tool_result 按完成序到达，seq 照常单调——回放一致性不受影响，
  但「断言工具结果按声明序到达」的旧测试写法在并发下不成立（本项目测试没有这种假设，
  96 个旧用例零改动全绿）。

`WATER_PARALLEL_TOOLS=0` 可整体回退串行——并发是默认，但逃生门永远留着。
