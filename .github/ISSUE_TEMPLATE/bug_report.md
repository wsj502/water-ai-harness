name: 缺陷报告（Bug）
description: 什么东西坏了、和预期不符
labels: ["bug"]
body:
  - type: textarea
    id: what-happened
    attributes:
      label: 现象描述
      description: 发生了什么？预期是什么？附上报错原文（控制台/SSE error 事件/页面提示）。
      placeholder: |
        现象：Web 会话里发送消息后一直转圈，最终 SSE 返回 finish:error…
        预期：模型流式回复
        报错：Anthropic 401: unauthorized
    validations:
      required: true

  - type: dropdown
    id: component
    attributes:
      label: 影响组件
      options:
        core（Agent Loop / Provider / 工具 / 权限）
        server（HTTP / SSE / 持久化）
        web
        cli
        desktop（Tauri / SEA sidecar）
        plugins（插件系统 / MCP）
        文档
        构建 / CI / 发布
      default: 0
    validations:
      required: true

  - type: textarea
    id: reproduce
    attributes:
      label: 复现步骤
      description: 从干净状态开始的完整步骤；能附 mock 模式复现最好（WATER_MOCK=1，无需 key）。
      placeholder: |
        1. WATER_MOCK=1 npm run dev:server
        2. 打开 http://127.0.0.1:3210 新建会话
        3. 输入 "..."
    validations:
      required: true

  - type: textarea
    id: env
    attributes:
      label: 环境信息
      placeholder: |
        OS: Windows 11 / Node 22.x / 浏览器 Chrome xxx
        water 版本：main@<commit 短哈希> 或 tag
        provider/模型：anthropic + glm-4.6（或 mock / openai + deepseek-chat）
    validations:
      required: true

  - type: textarea
    id: logs
    attributes:
      label: 相关日志
      description: 服务端控制台输出、SSE 事件流片段。注意先脱敏，任何 key/token 不能出现。
      render: shell
  - type: markdown
    attributes:
      value: |
        > 🔒 提醒：日志与截图里的 key/token 一律打码。凭据泄漏请直接联系维护者，不要开公开 issue。
