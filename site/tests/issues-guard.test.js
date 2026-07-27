// 合规构建防线:published=true 但商品未过检查单 → loadIssues 抛错,构建失败。
// (手改 JSON 绕过 publish.py check 时的最后一道机械防线,绝不静默上线。)
// 夹具须在 import issues.js 之前写入——import.meta.glob 在模块转换期解析文件列表。
import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const issuesDir = join(
  dirname(dirname(fileURLToPath(import.meta.url))), 'src', 'data', 'issues');
const fixturePath = join(issuesDir, 'issue-899.json');

mkdirSync(issuesDir, { recursive: true });
writeFileSync(fixturePath, JSON.stringify({
  issue: 899,
  title: '第899期',
  published: true,
  published_at: '2026-07-01',
  lock_until: '2026-07-08',
  items: [
    { id: 'p1', name: '手改绕过检查单的商品', price_cny: 1, compliance_confirmed: false },
  ],
}));

afterAll(() => rmSync(fixturePath, { force: true }));

describe('loadIssues 合规防线', () => {
  it('published=true 但有未确认商品 → 构建抛错', async () => {
    const { loadIssues } = await import('../src/lib/issues.js');
    expect(() => loadIssues()).toThrow(/未过合规检查单/);
  });
});

describe('构建层文本重筛(检查单盖章后再改文案,这里拦)', () => {
  it('公开文本命中药品关键词(含变体拼写)', async () => {
    const { blacklistHit } = await import('../src/lib/issues.js');
    expect(blacklistHit('宝宝退烧神器,一贴见效')).toBeTruthy();
    expect(blacklistHit('IBU-PROFEN tablets')).toBeTruthy();
    expect(blacklistHit('婴儿电子体温计')).toBeTruthy();
    expect(blacklistHit('Kirkland 坚果混合装')).toBeNull();
    expect(blacklistHit('')).toBeNull();
  });
});

describe('构建层日期校验', () => {
  it('假日期(2026-02-31)拒绝——JS 会悄悄归一化成三月,锁价被静默拉长', async () => {
    const { isRealDate } = await import('../src/lib/issues.js');
    expect(isRealDate('2026-02-31')).toBe(false);
    expect(isRealDate('2026-13-01')).toBe(false);
    expect(isRealDate('2026-07-26')).toBe(true);
    expect(isRealDate('not-a-date')).toBe(false);
  });
});
