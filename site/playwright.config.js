import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  globalTeardown: './scripts/e2e-teardown.mjs',
  use: {
    baseURL: 'http://127.0.0.1:8788',
    // 微信场景为移动端;E2E 用移动视口 + 剪贴板权限
    ...devices['iPhone 13'],
    // iPhone 设备预设默认 webkit,剪贴板权限授权走 chromium 更稳
    defaultBrowserType: 'chromium',
    permissions: ['clipboard-read', 'clipboard-write'],
  },
  webServer: {
    command: 'npm run e2e:server',
    url: 'http://127.0.0.1:8788/issues/999/',
    timeout: 180_000,
    // 一律冷启动:复用遗留服务器 = 测的是旧构建旧库,假绿比慢更贵
    reuseExistingServer: false,
  },
});
