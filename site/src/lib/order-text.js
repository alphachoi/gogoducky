// 订单文本生成(设计定稿模板):
// 【gogoducky 第12期】(ref:yuxing01)
// - 商品A x2 @ ¥180
// - 商品B x1 @ ¥95
// 合计参考价:¥455(锁价至8月1日)
//
// URL 无 ref(裸链接二次转发丢参)时省略 ref 段,归因记为 direct。

import { formatCnDate } from './dates.js';

export function buildOrderText({ issueNo, ref, selections, lockUntil }) {
  const refPart = ref && ref !== 'direct' ? `(ref:${ref})` : '';
  const lines = [`【gogoducky 第${issueNo}期】${refPart}`];
  let total = 0;
  for (const { name, qty, price_cny } of selections) {
    if (qty <= 0) continue;
    lines.push(`- ${name} x${qty} @ ¥${price_cny}`);
    total += qty * price_cny;
  }
  lines.push(`合计参考价:¥${total}(锁价至${formatCnDate(lockUntil)})`);
  return lines.join('\n');
}
