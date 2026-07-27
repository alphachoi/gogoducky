// E2E:存档页——ref 透传不断链,锁价状态签客户端判定。
import { expect, test } from '@playwright/test';

test('存档页:ref 透传到每期链接,状态签按锁价日期判定', async ({ page }) => {
  await page.goto('/archive/?ref=demo01');

  // 两期都在列表里,链接都带 ref
  const item999 = page.locator('a.archive-item[data-lock-until="2099-12-31"]');
  const item998 = page.locator('a.archive-item[data-lock-until="2026-01-17"]');
  await expect(item999).toHaveAttribute('href', /\/issues\/999\/\?ref=demo01/);
  await expect(item998).toHaveAttribute('href', /\/issues\/998\/\?ref=demo01/);

  // 锁价状态:999(2099年截止)锁价中,998(已过)已归档
  await expect(item999.locator('[data-state]')).toHaveText('锁价中');
  await expect(item998.locator('[data-state]')).toHaveText('已归档');

  // 点进 999,ref 跟着走,open 事件带 ref 落库
  const eventResponse = page.waitForResponse(
    (resp) =>
      resp.url().includes('/api/event') &&
      resp.request().postDataJSON()?.type === 'open'
  );
  await item999.click();
  await expect(page).toHaveURL(/\/issues\/999\/\?ref=demo01/);
  const resp = await eventResponse;
  expect(resp.status()).toBe(204);
  expect(resp.request().postDataJSON().ref).toBe('demo01');
});
