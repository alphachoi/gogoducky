import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    // stub 泄漏会让后续测试沉默地跑在陈旧 mock 上(假绿)
    unstubGlobals: true,
    mockReset: true,
  },
});
