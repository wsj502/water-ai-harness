# Pull Request

## 关联

Closes #<issue 编号>

<!-- 无对应 issue 的纯笔误/文档修正可写 N/A，其余情况必须有 issue 先行 -->

## 变更内容

<!-- 一句话讲清这个 PR 做了什么；复杂变更分点列出 -->

## 动机与方案

<!-- 为什么这么做？有没有考虑过的替代方案？涉及内核设计决策的，说明文章是否需要同步更新 -->

## 自测清单

- [ ] `npm run typecheck` 通过
- [ ] `npx tsx scripts/loop-mock-test.ts` 通过
- [ ] 新增/变更了内核行为 → 有对应测试或离线验证脚本覆盖
- [ ] 用户可见行为变更 → 已更新 `CHANGELOG.md` Unreleased 段
- [ ] 涉及设计决策 → 已同步 `docs/articles/` 对应文章
- [ ] 提交信息符合 Conventional Commits（squash 后的标题 = PR 标题）

## 凭据检查

- [ ] 本 PR 不含任何明文 key / token / 密码（代码、配置、测试、截图、日志均已检查）

## 截图 / 录屏

<!-- UI 变更必附；接口变更可附 SSE 事件流片段（脱敏后） -->
