// 订单文本生成:有 ref / 无 ref / 多商品 / 数量(P1 站点必测)
import { describe, expect, it } from 'vitest';
import { buildOrderText } from '../src/lib/order-text.js';

const selections = [
  { name: '商品A', qty: 2, price_cny: 180 },
  { name: '商品B', qty: 1, price_cny: 95 },
];

describe('buildOrderText', () => {
  it('带 ref:与设计定稿模板逐字一致', () => {
    const text = buildOrderText({
      issueNo: 12, ref: 'yuxing01', selections, lockUntil: '2026-08-01',
    });
    expect(text).toBe(
      '【gogoducky 第12期】(ref:yuxing01)\n' +
      '- 商品A x2 @ ¥180\n' +
      '- 商品B x1 @ ¥95\n' +
      '合计参考价:¥455(锁价至8月1日)'
    );
  });

  it('无 ref(裸链接):省略 ref 段', () => {
    const text = buildOrderText({ issueNo: 12, ref: '', selections, lockUntil: '2026-08-01' });
    expect(text.startsWith('【gogoducky 第12期】\n')).toBe(true);
    expect(text).not.toContain('ref:');
  });

  it('direct 视同无 ref', () => {
    const text = buildOrderText({ issueNo: 1, ref: 'direct', selections, lockUntil: '2026-08-01' });
    expect(text).not.toContain('ref:');
  });

  it('数量为 0 的商品不出现在订单里', () => {
    const text = buildOrderText({
      issueNo: 1,
      ref: 'a',
      selections: [...selections, { name: '商品C', qty: 0, price_cny: 999 }],
      lockUntil: '2026-08-01',
    });
    expect(text).not.toContain('商品C');
    expect(text).toContain('¥455');
  });

  it('单商品多数量合计正确', () => {
    const text = buildOrderText({
      issueNo: 1, ref: 'a',
      selections: [{ name: '商品A', qty: 3, price_cny: 100 }],
      lockUntil: '2026-12-15',
    });
    expect(text).toContain('- 商品A x3 @ ¥100');
    expect(text).toContain('合计参考价:¥300(锁价至12月15日)');
  });
});
