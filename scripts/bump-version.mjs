#!/usr/bin/env node
// 发版版本号统一同步 / 一致性校验（#86）
//
// 背景：bump 清单曾是口头记忆的「9 处」，docker-compose.yml 的镜像标签漏在清单外，
// 导致 v0.8→v0.10 三轮发版都把最新代码打进 water:0.7.0 旧标签（标签说谎）。
// 本脚本把清单显式化：以根 package.json 为唯一事实源，下列 10 处向它对齐。
//
// 用法：
//   npm run bump -- --check        校验 10 处与根版本一致（发版自检，不一致 exit 1）
//   npm run bump -- --set 0.11.0   设定新版本，并同步其余各处
//
// 已知不在清单内：package-lock.json 的 workspace 版本字段（npm 从 v0.1.0 起就不回写它，
// 属化妆性漂移，npm ci 也不校验；如需刷新跑一次 npm install 即可）。
import { readFileSync, writeFileSync } from 'node:fs';

// 10 处清单：[文件, 定位版本号的正则（捕获组即版本号本身，零宽环视锚定上下文）]
const TARGETS = [
  ['packages/core/package.json', /(?<="version":\s*")(\d+\.\d+\.\d+)(?=")/],
  ['apps/server/package.json', /(?<="version":\s*")(\d+\.\d+\.\d+)(?=")/],
  ['apps/web/package.json', /(?<="version":\s*")(\d+\.\d+\.\d+)(?=")/],
  ['apps/cli/package.json', /(?<="version":\s*")(\d+\.\d+\.\d+)(?=")/],
  ['apps/desktop/package.json', /(?<="version":\s*")(\d+\.\d+\.\d+)(?=")/],
  ['apps/desktop/src-tauri/tauri.conf.json', /(?<="version":\s*")(\d+\.\d+\.\d+)(?=")/],
  ['apps/desktop/src-tauri/Cargo.toml', /(?<=^version\s*=\s*")(\d+\.\d+\.\d+)(?=")/m],
  // /api/config 端点回显的版本号
  ['apps/server/src/index.ts', /(?<=version:\s*')(\d+\.\d+\.\d+)(?=')/],
  // 容器镜像标签——#86 漂移三个版本的正是这一处
  ['docker-compose.yml', /(?<=image:\s*water:)(\d+\.\d+\.\d+)/],
];

const ROOT = 'package.json';
const jsonRe = /(?<="version":\s*")(\d+\.\d+\.\d+)(?=")/;
const arg = process.argv[2];
const newVer = process.argv[3];

if (arg === '--set') {
  if (!/^\d+\.\d+\.\d+$/.test(newVer ?? '')) {
    console.error('用法: npm run bump -- --set X.Y.Z');
    process.exit(2);
  }
  writeFileSync(ROOT, readFileSync(ROOT, 'utf8').replace(jsonRe, newVer));
  for (const [file, re] of TARGETS) {
    writeFileSync(file, readFileSync(file, 'utf8').replace(re, newVer));
  }
  console.log(`已同步 ${TARGETS.length + 1} 处 → ${newVer}`);
} else if (arg === '--check') {
  const expect = readFileSync(ROOT, 'utf8').match(jsonRe)[1];
  const bad = [];
  for (const [file, re] of TARGETS) {
    const got = readFileSync(file, 'utf8').match(re)?.[1];
    if (got !== expect) bad.push(`  ${file}: ${got ?? '未找到'} (期望 ${expect})`);
  }
  if (bad.length) {
    console.error(`版本号不一致（根 = ${expect}）：\n${bad.join('\n')}`);
    process.exit(1);
  }
  console.log(`版本号一致：${TARGETS.length + 1} 处均为 ${expect}`);
} else {
  console.error('用法: npm run bump -- --check | --set X.Y.Z');
  process.exit(2);
}
