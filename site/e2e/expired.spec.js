// E2E:存档期行为——锁价截止后禁用下单,商品仍可浏览(设计"存档期行为"条款)。
import { expect, test } from '@playwright/test';

test('锁价过期:提示条显示,复制与数量按钮禁用,价格标注失效', async ({ page }) => {
  await page.goto('/issues/998/?ref=demo01');

  await expect(page.locator('#expired-banner')).toBeVisible();
  await expect(page.locator('#expired-banner')).toContainText('本期价格已失效');

  // 复制订单禁用,吸底栏文案切换
  await expect(page.locator('#copy-order')).toBeDisabled();
  await expect(page.locator('#order-summary')).toHaveText('本期已过锁价期,看最新一期下单');

  // 数量按钮禁用,商品仍可浏览
  const card = page.locator('.product-card[data-id="x1"]');
  await expect(card.getByText('过期测试商品')).toBeVisible();
  await expect(card.getByRole('button', { name: '增加数量' })).toBeDisabled();
  await expect(card.locator('[data-price-note]')).toHaveText('价格已失效');

  // 提示条链接透传 ref
  await expect(page.locator('#expired-banner a')).toHaveAttribute('href', /ref=demo01/);
});

test('过期期刊仍上报 open 事件(浏览数据不丢)', async ({ page }) => {
  const eventResponse = page.waitForResponse(
    (resp) =>
      resp.url().includes('/api/event') &&
      resp.request().postDataJSON()?.type === 'open'
  );
  await page.goto('/issues/998/');
  const resp = await eventResponse;
  expect(resp.status()).toBe(204);
  expect(resp.request().postDataJSON()).toMatchObject({ type: 'open', issue: 998, ref: 'direct' });
});
