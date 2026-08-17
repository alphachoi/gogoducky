// E2E:剪贴板失败降级、连点去重、转发按钮——客户可见的异常/降级路径。
import { expect, test } from '@playwright/test';

test('剪贴板失败 → 降级长按框 + copy_fallback 事件', async ({ page }) => {
  // 模拟微信部分版本:clipboard API 拒绝 + execCommand 失败
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.reject(new Error('denied')) },
    });
    document.execCommand = () => false;
  });
  await page.goto('/issues/999/?ref=demo01');

  const cardA = page.locator('.product-card[data-id="p1"]');
  await cardA.getByRole('button', { name: '增加数量' }).click();

  const eventResponse = page.waitForResponse(
    (resp) =>
      resp.url().includes('/api/event') &&
      resp.request().postDataJSON()?.type === 'copy_fallback'
  );
  await page.locator('#copy-order').click();
  const resp = await eventResponse;
  expect(resp.status()).toBe(204);
  expect(resp.request().postDataJSON().ref).toBe('demo01');

  // 降级弹层:警示标题 + 可长按全选的订单文本
  await expect(page.locator('#sheet')).toBeVisible();
  await expect(page.locator('#sheet-title')).toHaveText('自动复制没成功');
  const fallbackText = await page.locator('#sheet-text').inputValue();
  expect(fallbackText).toContain('【gogoducky 第999期】(ref:demo01)');
  expect(fallbackText).toContain('- 测试商品A x1 @ ¥180');
});

test('连点复制不产生重复归因事件', async ({ page }) => {
  const copyEvents = [];
  page.on('request', (req) => {
    if (req.url().includes('/api/event')) {
      const body = req.postDataJSON();
      if (body?.type?.startsWith('copy')) copyEvents.push(body);
    }
  });

  await page.goto('/issues/999/?ref=demo01');
  const cardA = page.locator('.product-card[data-id="p1"]');
  await cardA.getByRole('button', { name: '增加数量' }).click();

  await page.locator('#copy-order').click();
  await expect(page.locator('#sheet')).toBeVisible();
  await page.locator('#sheet-close').click();   // 关掉弹层才能再点
  await page.locator('#copy-order').click();
  // 去重是同步的(sentTypes):第二次点击的 UI 后果(弹层再现)出现时,
  // 若有重复事件早已发出——以确定性信号替代固定 sleep
  await expect(page.locator('#sheet')).toBeVisible();
  await page.locator('#sheet-close').click();

  expect(copyEvents.length).toBe(1);
});

test('转发按钮复制带 ref 的本期链接', async ({ page }) => {
  await page.goto('/issues/999/?ref=demo01');
  await page.locator('#share-btn').click();
  await expect(page.locator('#share-btn')).toHaveText('链接已复制,去微信粘贴');
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toContain('/issues/999/');
  expect(clipboard).toContain('ref=demo01');
});
