# 贡献指南（Contributing）

感谢你关注 Water —— 一个用于学习研究的 AI Agent Harness。
本文是参与本项目的完整流程说明，也是维护者自己遵守的工作纪律。

## 开发环境

| 依赖 | 版本要求 | 说明 |
|---|---|---|
| Node.js | ≥ 22 | 需要 `node:sqlite` 内置模块；推荐 22 LTS |
| npm | ≥ 10 | workspaces 管理，无需 pnpm/yarn |
| Rust + Tauri CLI | 可选 | 仅改桌面端（`apps/desktop`）时需要 |
| Docker | 可选 | 仅验证镜像构建/部署时需要 |

```powershell
# 1. 克隆并安装依赖
git clone https://github.com/wsj502/water-ai-harness.git
cd water-ai-harness
npm ci

# 2. 本地验证（不需要任何 API key）
npm run typecheck                 # 类型检查
npx tsx scripts/loop-mock-test.ts # Agent Loop 离线闭环测试
npm run build                     # 全量构建（core/server/cli/web）

# 3. 离线跑起来（mock 模式）
$env:WATER_MOCK='1'; npm run dev:server   # http://127.0.0.1:3210
```

涉及真实大模型联调时才需要凭据，见下文「凭据红线」。

## 分支模型

```
main            受保护分支，永远可构建、可发布
feature/*       短命功能分支，从 main 切出，合入即删
fix/*           缺陷修复分支
docs/*          纯文档变更
```

- 分支从 `main` 切出：`git checkout -b feature/m1-provider-registry`
- 合并方式：**squash merge**（一个 PR = 一条 main 上的提交，历史干净可回溯）
- PR 标题即 squash 后的提交标题，务必写规范（见下）

## 提交规范（Conventional Commits）

```
<type>(<scope>): <中文一句话摘要>

[可选正文：动机、方案、影响面]
[可选尾注：Closes #123]
```

| type | 用途 |
|---|---|
| `feat` | 新功能 |
| `fix` | 缺陷修复 |
| `docs` | 仅文档 |
| `refactor` | 重构（不改行为） |
| `test` | 测试 |
| `chore` | 构建/工具/依赖 |
| `perf` | 性能 |

scope 惯例：`core` / `server` / `web` / `cli` / `desktop` / `plugins` / `ci`，或阶段号 `P7`、里程碑号 `M1`。

## 工作流：issue → 分支 → PR → review → merge

1. **先开 issue**：任何变更都先有 issue（bug 用 bug 模板、新功能用 feature 模板），描述清楚动机与预期
2. **认领**：在 issue 下留言认领，维护者打上 `in-progress` 标签并关联 milestone
3. **分支开发**：一个 issue 一个分支，提交可以随意粒度（squash 合并不怕碎）
4. **自测清单**（PR 前必过）：
   - [ ] `npm run typecheck` 通过
   - [ ] `npx tsx scripts/loop-mock-test.ts` 通过
   - [ ] 改了内核则补充/更新对应测试
   - [ ] 改了用户可见行为则更新 `docs/articles/` 对应文章与 `CHANGELOG.md` Unreleased 段
5. **发 PR**：使用 PR 模板，关联 `Closes #<issue>`，等待 CI 全绿
6. **review**：至少一人批准（维护者自己的 PR 也走自审 + CI，绝不直推 main）
7. **squash merge → 删分支 → 关 issue**，CHANGELOG 在 PR 内一并更新

## 版本与发布

- 遵循 [语义化版本](https://semver.org/lang/zh-CN/)：破坏性变更升主版本，新功能升次版本，修复升补丁版本
- 发布流程：更新 `CHANGELOG.md`（把 Unreleased 段落定稿为版本号）→ 合入 main → 打 tag `vX.Y.Z` → GitHub Release（附重大变更说明）
- milestone 对应版本号，PR/issue 关联到对应 milestone

## 凭据红线（安全纪律，违反即拒收）

- **明文 API key / token 永不入库**：不写进代码、配置、测试、截图、issue、日志
- 凭据只走两条路：
  1. `import-secrets.ps1` 导入 DPAPI 加密存储（`~/.ai-secrets/`），`start-secure.ps1` 启动时注入进程内存
  2. 环境变量直接注入（CI/容器场景用 GitHub Secrets）
- `~/.water/config.json` 与项目内任何 config 文件禁止出现 key 字段（内核读取时会主动扫描拒绝）
- 发现疑似凭据泄漏：立即 issue 报告，维护者撤销 key 并清理历史

## 代码约定

- TypeScript strict 模式；内核（`packages/core`）保持**零运行时外部依赖**（node:* + fetch 即全部）
- 注释回答「为什么」，代码回答「怎么做」；关键模块的文件头注释是项目文档体系的一部分
- 用户可见的文案用中文；代码标识符用英文
- 每个内核模块的深度讲解文章放 `docs/articles/`，重大设计决策变更需同步文章并说明动机

## 行为准则

- 这是学习研究项目：提问不嫌基础，但请先搜索现有 issue 与 `docs/PITFALLS.md`
- 讨论对事不对人；维护者对 issue/PR 的响应优先级：安全问题 > 缺陷 > 功能 > 文档
