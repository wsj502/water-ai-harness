import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // 单测一律解析到内核源码（而非 dist）：冷 checkout 无构建产物也能跑，
      // 也避免了"测试跑在过期产物上"的整类问题（CI 曾因此红过两次）
      '@water/core': path.resolve(__dirname, 'packages/core/src/index.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // 慢路径显式标注：retry 测试带真实退避（1s/2s）
    testTimeout: 30_000,
  },
});
