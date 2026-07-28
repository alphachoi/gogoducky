// GET /api/admin/stats — 归因报表(直读 D1,一次 batch 三条查询)。
// 口径与 docs/metrics-baseline.md 一致:打开/复制是行为代理指标,
// 成交与新客身份以微信对账为准;direct 含裸链接 + 未知/退役码降级。
import { json, requireAccess } from './_lib.js';

const WINDOWS = [
  { key: 'by_ref_7d', group: 'ref, type', days: 7 },
  { key: 'by_ref_28d', group: 'ref, type', days: 28 },
  { key: 'by_issue_28d', group: 'issue, type', days: 28 },
];

export async function onRequestGet({ request, env }) {
  const denied = await requireAccess(request, env);
  if (denied) return denied;
  if (!env.DB) return json({ error: 'D1 未绑定' }, 502);

  try {
    const results = await env.DB.batch(
      WINDOWS.map(({ group, days }) =>
        env.DB.prepare(
          `SELECT ${group}, COUNT(*) AS n FROM events
           WHERE ts > datetime('now', ?)
           GROUP BY ${group} ORDER BY ${group}`
        ).bind(`-${days} days`))
    );
    const payload = {};
    WINDOWS.forEach(({ key }, i) => { payload[key] = results[i].results; });
    return json(payload);
  } catch (e) {
    console.error('admin stats failed:', e);
    return json({ error: '统计查询失败' }, 502);
  }
}
