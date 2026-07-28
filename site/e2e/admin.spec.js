// E2E:后台 fail-closed——本地环境不配 DEV_MODE/Access 时,
// 页面能开(静态资源无秘密),但所有管理端点必须 403。
import { expect, test } from '@playwright/test';

test('后台端点未认证一律 403(fail-closed 实测)', async ({ page, request }) => {
  for (const path of [
    '/api/admin/stats', '/api/admin/issues', '/api/admin/refs', '/api/admin/issue?n=1',
  ]) {
    const resp = await request.get(path);
    expect(resp.status(), path).toBe(403);
  }
  const put = await request.put('/api/admin/issue', {
    data: { issue: 999, sha: 'x', changes: { published: false } },
  });
  expect(put.status()).toBe(403);
  const refsPut = await request.put('/api/admin/refs', { data: { refs: ['x'], sha: 'y' } });
  expect(refsPut.status()).toBe(403);

  // 页面本身可渲染(无秘密),三个区块都显示未认证错误而不是数据
  await page.goto('/admin/');
  await expect(page.getByRole('heading', { name: '管理后台' })).toBeVisible();
  await expect(page.locator('#stats-body .error-box')).toBeVisible();

  await page.getByRole('button', { name: '期刊' }).click();
  await expect(page.locator('#issues-list .error-box')).toBeVisible();
  await page.getByRole('button', { name: '邀请码' }).click();
  await expect(page.locator('#refs-body .error-box')).toBeVisible();

  // 本地/预览域走的是主机白名单这条防线(自定义域之外一律拒)
  await expect(page.locator('#refs-body .error-box')).toContainText('此域名不提供后台');
});
