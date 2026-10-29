# 03 · SSE 流式协议设计：三端共用一份事件流

> 阶段：P3 ｜ 代码：`apps/server/src/index.ts`
> 本篇回答：**内核的事件流怎么越过 HTTP 到达浏览器，审批这种「反向操作」又怎么回来？**

## 协议全貌

```mermaid
sequenceDiagram
    participant W as Web (React)
    participant S as water-server (Hono)
    participant L as Agent Loop

    W->>S: POST /api/sessions/:id/messages {text}
    S->>L: agentLoop(...)
    L-->>S: LoopEvent 流
    S-->>W: SSE: event: text_delta / data: {...}
    Note over L: 模型请求高危工具
    L->>S: approve 回调被调用
    S-->>W: SSE: event: approval_required {callId, call}
    Note over W: 用户点击「允许一次」
    W->>S: POST /api/sessions/:id/approve {callId, decision}
    S->>L: resolve('once')（Promise 放行）
    L-->>S: tool_result … finish
    S-->>W: SSE 继续流，直到 finish 关闭
```

## 关键决策

### 1. 为什么 SSE 而不是 WebSocket

| 维度 | SSE | WebSocket |
|---|---|---|
| 方向 | 服务端→客户端单向 | 双向 |
| 实现成本 | HTTP POST 响应即流，零协议升级 | 需要升级握手、心跳、重连协议 |
| 审批回传 | 走独立 POST（幂等、可鉴权） | 同连接回传 |
| 断线语义 | 天然断开即终止（AbortSignal） | 需自建超时 |

Agent 会话是**「请求-长响应」**模式：一次提问触发一条事件流。双向通信的需求只有审批回传，
而审批用普通 POST 表达更清晰（一次审批 = 一个幂等动作，有明确的状态码语义）。
SSE + 反向 POST 的组合比 WebSocket 简单一个数量级。

### 2. 审批桥：Loop 的 Promise 世界 ↔ HTTP 的请求世界

```mermaid
flowchart LR
    subgraph 内核世界
        L[Agent Loop] -->|"await approve(call)"| P["挂起的 Promise"]
    end
    subgraph HTTP世界
        P --> SE["stream.writeSSE(approval_required)"]
        EP["POST /approve"] -->|"pending.resolve(decision)"| P
    end
```

桥的核心是 Session 里的 `pending: Map<callId, resolver>`：

- Loop 调用 approve → 回调先往 SSE 流里**补发** `approval_required` 事件，再挂起 Promise
- 用户在前端点按钮 → POST /approve → resolver 放行 → Loop 继续 → 后续事件接着流

**兜底语义**：SSE 连接中断（关页面/断网）→ 所有悬挂审批一律 resolve('deny')。
「联系不上用户的审批」等价于「拒绝」，这是保守安全的默认。

### 3. 事件即状态：前端不做轮询

服务端事件流就是真相源（single source of truth）。
前端的 `applyEvent(blocks, event)` 是纯函数折叠器——
**UI 状态 = fold(事件序列)**，这正是 Redux/Event Sourcing 的思想：

```ts
// apps/web/src/state/blocks.ts
text_delta   → 追加到最后一个 text 块（或新建）
tool_pending → 新增 tool 块（status: running）
approval_required → 对应 tool 块转 waiting（渲染审批按钮）
tool_result  → tool 块转 done/error，附上结果
```

切换会话时走 `GET /api/sessions/:id/messages` 拉历史 WMessage[]，
用 `hydrateBlocks` 折叠成同样的块序列——**实时流和历史回放共用一套渲染**。

### 4. MVP 约束：单会话串行

`session.busy` 互斥锁：同一会话同时只允许一条消息在处理。
并发的历史交错（用户消息插进工具结果中间）会破坏 Anthropic 协议对
tool_use/tool_result 严格配对的要求——先串行，排队/中断抢占留给后续阶段。

## 端点速查

| 方法 | 路径 | 语义 |
|---|---|---|
| GET | /api/config | 协议/模型/工作区（无凭据） |
| GET | /api/sessions | 会话列表（title/turns/busy） |
| POST | /api/sessions | 新建会话 |
| GET | /api/sessions/:id/messages | 历史水合 |
| POST | /api/sessions/:id/messages | 发消息 → SSE LoopEvent 流 |
| POST | /api/sessions/:id/approve | 审批 {callId, decision} |

## 踩坑记录

1. **Hono `c.req.json()` 遇坏 JSON 抛异常变 500** → 已修：catch 后返回 400，附中文提示
2. **PowerShell 里 `curl -d '{"text":"中文"}'` 引号被 PS 吞掉** → 测试脚本用 `--data-binary @file` 绕开
3. **`tool_pending` 不等于「等待审批」**：低风险工具自动放行时也会发 pending。
   需要一个额外事件 `approval_required` 精确表达「Loop 正在等用户」——
   这就是为什么它不是内核 LoopEvent，而是 server 层补发的协议事件

## P3-Server 验收

- [x] curl 实测完整 SSE 周期：turn_start → thinking → tool → result → turn2 → finish
- [x] 会话列表 title 自动生成（首条消息前 30 字）
- [x] 断连兜底：悬挂审批自动拒绝
- [x] mock 模式全程可开发，无需真实 key
