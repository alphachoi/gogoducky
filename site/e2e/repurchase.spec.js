// E2E (a) 老客复购:带 ref 链接打开 → 浏览 → 选数量 → 复制订单 → 事件落库(204)。
import { expect, test } from '@playwright/test';

test('老客复购:选商品 → 复制订单 → copy 事件落库', async ({ page }) => {
  await page.goto('/issues/999/?ref=demo01');

  await expect(page.getByRole('heading', { name: /第999期/ })).toBeVisible();
  await expect(page.getByText('测试商品A')).toBeVisible();

  // 商品A x2,商品B x1
  const cardA = page.locator('.product-card[data-id="p1"]');
  await cardA.getByRole('button', { name: '增加数量' }).click();
  await cardA.getByRole('button', { name: '增加数量' }).click();
  const cardB = page.locator('.product-card[data-id="p2"]');
  await cardB.getByRole('button', { name: '增加数量' }).click();

  await expect(page.locator('#order-summary')).toHaveText('已选 3 件 · 合计 ¥455');

  const eventResponse = page.waitForResponse(
    (resp) =>
      resp.url().includes('/api/event') &&
      ['copy', 'copy_fallback'].includes(resp.request().postDataJSON()?.type)
  );
  await page.locator('#copy-order').click();
  const resp = await eventResponse;

  expect(resp.status()).toBe(204);
  const body = resp.request().postDataJSON();
  // 剪贴板权限已授予,复制必须走成功路径——降级路径有专门用例(edge-cases)
  expect(body.type).toBe('copy');
  expect(body.ref).toBe('demo01');
  expect(body.issue).toBe(999);

  // 剪贴板内容与订单模板一致
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toContain('【gogoducky 第999期】(ref:demo01)');
  expect(clipboard).toContain('- 测试商品A x2 @ ¥180');
  expect(clipboard).toContain('- 测试商品B x1 @ ¥95');
  expect(clipboard).toContain('合计参考价:¥455');
});
