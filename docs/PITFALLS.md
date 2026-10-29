# 踩坑与注意事项总表（Water 项目）

> 汇总各阶段实测踩过的坑。新会话/新人接手前先读这个，再看 `docs/articles/00-导读.md`。
> 最后更新：2026-10-29

## 一、本机环境坑（Windows，最重要）

| 坑 | 现象 | 解法 |
|---|---|---|
| **PowerShell 5.1 写中文文件** | `Set-Content`/`>` 重定向把 UTF-8 中文写成 GBK 乱码 | 一律用专用 write/edit 工具；验证：`[IO.File]::ReadAllText($p,[Text.Encoding]::UTF8)` 查 U+FFFD |
| **PS 吞 curl 的 JSON 引号** | `curl -d '{"text":"中文"}'` 服务端收到坏 JSON | 写临时文件 + `curl.exe --data-binary @file` |
| **Python subprocess 找不到 npm 全局命令** | `FileNotFoundError: WinError 2` | CreateProcess 不查 PATHEXT；`shutil.which()` 解析 + `.cmd/.bat` 包 `cmd /c`（已在 tools/envload.py 修复） |
| **我的 shell 会话 PATH 不刷新** | 装了 Rust 后 cargo 仍 not found | 每次会话手动 `$env:PATH += ";$env:USERPROFILE\.cargo\bin"` |
| **.ps1 中文必须带 BOM** | PS 5.1 把无 BOM 的 .ps1 按 ANSI 读 | ps1/bat 模板保持纯 ASCII（dpapi-secrets 技能规则） |
| **`~/.ai-secrets/` 禁读** | 那是排障工作区的只读凭据目录 | Water 用自己的 `~/.water/secrets.dpapi`（water 作用域） |

## 二、Node / TypeScript 工程坑

| 坑 | 解法 |
|---|---|
| `TS2591 Cannot find name 'node:fs'` | tsconfig 加 `"types": ["node"]` |
| `findLast` 等 ES2023 API 报不存在 | `lib: ["ES2023"]` |
| npm 的 allow-scripts 拦 esbuild postinstall | 不影响 tsx 运行；真要装就 `npm approve-scripts` |
| workspace 依赖发包陷阱 | `@water/core:"*"` 要求同 registry 发布；或 esbuild 内联打包 |
| npm pack 前防发旧货 | `prepublishOnly: npm run build` |

## 三、内核/协议坑

| 坑 | 解法 |
|---|---|
| 智谱 GLM `message_start` 的 usage 恒为 0 | 真实 usage 在 `message_delta`，适配器两处都读（providers/anthropic.ts） |
| `tool_pending` ≠ 等待审批 | 低风险自动放行也发 pending；server 补发 `approval_required` 事件 |
| 思考块回传历史 | 不回传（浪费 token，Anthropic 还要求 signature） |
| 用户拒绝工具调用 | 必须回填 tool_result 告知模型，否则模型卡着重试 |
| glob 不支持 `{a,b}` | 已在 globToRegExp 加交替支持 |
| 会话并发会打乱 tool_use/tool_result 配对 | MVP 用 session.busy 串行锁 |

## 四、桌面端（Tauri/Rust）坑

| 坑 | 解法 |
|---|---|
| `app.manage`/`window.state` 报 E0599 | `use tauri::Manager;`（trait 要进作用域） |
| frontendDist 路径基准 | 相对 `src-tauri/` 目录 |
| 两个 tauri dev 并行 | app.exe 文件锁（os error 5），单实例开发 |
| sidecar EADDRINUSE :3210 | 杀残留测试 server；生产应随机端口+端口文件 |
| **Node 24 SEA 保险丝换了** | 旧文档 `...b19903b2` → 实际 `...df1996b2`；且第三方 node 发行版（如 D:\env\nodejs）会剥掉保险丝，必须用官方 node.exe 做基座 |
| SEA 打包 CJS 不支持顶层 await | server 入口包 `main()` |
| postject「signature seems corrupted」 | 预期警告：注入改了已签名二进制；对外分发需重签 |

## 五、流程纪律（本项目约定）

1. **每阶段 = 能跑 + 文章写完**，缺一不进下一阶段
2. **一个功能点一个提交**（Conventional Commits + 阶段前缀，如 `feat(P3):`）
3. 凭据永不入库、永不打印值、永不向 AI 索要（DPAPI 注入）
4. 原型原则：**所见即承诺**，不放永远不实现的 UI
5. 文章里的「已知待验证项」必须诚实标注（如 docker build 未实测）
