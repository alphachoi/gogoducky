// GET /api/admin/stats — 归因报表(直读 D1)。
// 口径与 docs/metrics-baseline.md 一致:打开/复制是行为代理指标,
// 成交与新客身份以微信对账为准;direct 含裸链接 + 未知/退役码降级。
import { json, requireAccess } from './_lib.js';

export async function onRequestGet({ request, env }) {
  const denied = requireAccess(request, env);
  if (denied) return denied;
  if (!env.DB) return json({ error: 'D1 未绑定' }, 502);

  try {
    const byRef7d = await env.DB.prepare(`
      SELECT ref, type, COUNT(*) AS n FROM events
      WHERE ts > datetime('now', '-7 days')
      GROUP BY ref, type ORDER BY ref, type
    `).all();
    const byRef28d = await env.DB.prepare(`
      SELECT ref, type, COUNT(*) AS n FROM events
      WHERE ts > datetime('now', '-28 days')
      GROUP BY ref, type ORDER BY ref, type
    `).all();
    const byIssue = await env.DB.prepare(`
      SELECT issue, type, COUNT(*) AS n FROM events
      WHERE ts > datetime('now', '-28 days')
      GROUP BY issue, type ORDER BY issue DESC
    `).all();
    const daily = await env.DB.prepare(`
      SELECT date(ts) AS day, type, COUNT(*) AS n FROM events
      WHERE ts > datetime('now', '-14 days')
      GROUP BY day, type ORDER BY day
    `).all();
    return json({
      by_ref_7d: byRef7d.results,
      by_ref_28d: byRef28d.results,
      by_issue_28d: byIssue.results,
      daily_14d: daily.results,
    });
  } catch (e) {
    console.error('admin stats failed:', e);
    return json({ error: '统计查询失败' }, 502);
  }
}
