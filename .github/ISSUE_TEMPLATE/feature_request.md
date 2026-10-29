name: 功能建议（Feature）
description: 新能力、增强、体验改进
labels: ["feature"]
body:
  - type: textarea
    id: problem
    attributes:
      label: 要解决的问题
      description: 先讲痛点，再讲方案——功能是为问题服务的。这个功能缺失时你不得不怎么做？
      placeholder: |
        现在模型/协议在 server 启动时一次定死（全局单例 Provider），
        想换个模型必须改环境变量并重启进程；Web 设置页只能看不能改。
    validations:
      required: true

  - type: textarea
    id: solution
    attributes:
      label: 期望的方案
      description: 你期望它怎么工作？有参考对象（OpenCode / ZCode / Cursor 的对应行为）请附上。
    validations:
      required: true

  - type: dropdown
    id: area
    attributes:
      label: 影响层面
      options:
        内核（Loop / Provider / 工具 / 权限 / 上下文管理）
        协议（HTTP / SSE 事件）
        三端之一（web / cli / desktop）
        插件系统 / MCP
        工程化（构建 / CI / 发布 / 文档）
        全栈贯通
      default: 0
    validations:
      required: true

  - type: checkboxes
    id: learning-note
    attributes:
      label: 学习价值自评（本项目定位是学习研究）
      options:
        - label: 该功能涉及 Agent Harness 的核心机制（非纯 UI/便利性），值得写配套文章深挖
          required: false

  - type: textarea
    id: alternatives
    attributes:
      label: 考虑过的替代方案
      description: 有没有更简单的做法？为什么不够？
