import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // 慢路径显式标注：retry 测试带真实退避（1s/2s）
    testTimeout: 30_000,
  },
});
