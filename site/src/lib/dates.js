// 锁价/过期判断——纯前端日期逻辑,无定时任务。

// '2026-08-01' → '8月1日'
export function formatCnDate(isoDate) {
  const [, m, d] = String(isoDate).split('-').map(Number);
  if (!m || !d) return String(isoDate);
  return `${m}月${d}日`;
}

// 锁价截止日已过(截止日当天仍有效,次日起过期)。
// 日期非法时 fail-closed:按已过期处理——价格承诺的守卫不能坏日期就永远有效。
// 过期判断按浏览者本地时区(设计已明示:锁价日历以客户侧为准,publish 用中国日历生成)。
export function isExpired(lockUntil, now = new Date()) {
  const end = new Date(`${lockUntil}T23:59:59`);
  if (Number.isNaN(end.getTime())) return true;
  return now.getTime() > end.getTime();
}

// 本期发布超过 staleDays 天 → 页首提示条引导存档页
export function isStale(publishedAt, now = new Date(), staleDays = 14) {
  const start = new Date(`${publishedAt}T00:00:00`);
  return now.getTime() - start.getTime() > staleDays * 24 * 3600 * 1000;
}
