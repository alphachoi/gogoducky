// E2E:超14天提示条——冻结时钟测两个方向(夹具日期固定,真实时钟会漂移)。
import { expect, test } from '@playwright/test';

// 夹具 issue-999:published_at 2026-07-20,是最新一期(999 > 998)

test('最新一期发布超14天 → 显示存档引导提示条', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-08-10T12:00:00') }); // 第 21 天
  await page.goto('/issues/999/?ref=demo01');
  await expect(page.locator('#stale-banner')).toBeVisible();
  await expect(page.locator('#stale-banner a')).toHaveAttribute('href', /ref=demo01/);
});

test('发布14天内 → 提示条不出现', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-07-26T12:00:00') }); // 第 6 天
  await page.goto('/issues/999/');
  await expect(page.locator('#stale-banner')).toBeHidden();
});
