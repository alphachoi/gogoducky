// E2E (b) 新客归因:分享链接打开 → open 事件带 ref 落库;裸链接记 direct。
import { execSync } from 'node:child_process';
import { expect, test } from '@playwright/test';

test('分享链接打开 → open 事件带 ref 落库(D1 回读验证)', async ({ page }) => {
  const eventResponse = page.waitForResponse(
    (resp) =>
      resp.url().includes('/api/event') &&
      resp.request().postDataJSON()?.type === 'open'
  );
  await page.goto('/issues/999/?ref=demo01');
  const resp = await eventResponse;

  expect(resp.status()).toBe(204);
  const body = resp.request().postDataJSON();
  expect(body).toMatchObject({ type: 'open', issue: 999, ref: 'demo01' });

  // 端点写失败也返回 204(静默降级是设计),所以 204 ≠ 落库——
  // 必须回读本地 D1 确认这条 open 真的写进去了
  const out = execSync(
    `npx wrangler d1 execute gogoducky-events --local --json --command "SELECT COUNT(*) AS n FROM events WHERE type='open' AND issue=999 AND ref='demo01'"`,
    { cwd: import.meta.dirname + '/..', encoding: 'utf8' }
  );
  const rows = JSON.parse(out)[0].results;
  expect(rows[0].n).toBeGreaterThanOrEqual(1);
});

test('裸链接(无 ref)→ open 事件记 direct', async ({ page }) => {
  const eventResponse = page.waitForResponse(
    (resp) =>
      resp.url().includes('/api/event') &&
      resp.request().postDataJSON()?.type === 'open'
  );
  await page.goto('/issues/999/');
  const resp = await eventResponse;

  expect(resp.status()).toBe(204);
  expect(resp.request().postDataJSON().ref).toBe('direct');
});
