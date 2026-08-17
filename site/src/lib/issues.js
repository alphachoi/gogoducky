// 期刊加载:只纳入 published=true 的期;构建时三道机械校验(防线:
// 手改 JSON 绕过 publish.py check 时构建直接失败,绝不静默上线):
// 1. 合规检查单布尔位全过;
// 2. 全部公开文本重过药品黑名单——检查单盖章后再改文案,这里会拦下
//    (与 Python 入池层共用同一份关键词清单,永不漂移);
// 3. 日期真实存在(2026-02-31 这类会被 JS 悄悄归一化成三月的假日期拦下)。
import blacklistData from '../data/blacklist-keywords.json';

const modules = import.meta.glob('../data/issues/issue-*.json', { eager: true });

// 与 homarket_scraper/blacklist.py 相同的归一化 + 子串匹配
const STRIP_RE = /[\s.\-_·•'']+/g;
const normalize = (text) => String(text ?? '').toLowerCase().replace(STRIP_RE, '');
const NORMALIZED_KEYWORDS = blacklistData.keywords.map((k) => [normalize(k), k]);

export function blacklistHit(text) {
  const normalized = normalize(text);
  if (!normalized) return null;
  for (const [norm, original] of NORMALIZED_KEYWORDS) {
    if (normalized.includes(norm)) return original;
  }
  return null;
}

export function isRealDate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso ?? '')) return false;
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export function loadIssues() {
  const issues = Object.values(modules)
    .map((m) => m.default ?? m)
    .filter((issue) => issue.published);

  for (const issue of issues) {
    const unconfirmed = (issue.items || []).filter((i) => !i.compliance_confirmed);
    if (unconfirmed.length > 0) {
      throw new Error(
        `第${issue.issue}期 published=true 但有 ${unconfirmed.length} 个商品未过合规检查单:` +
        unconfirmed.map((i) => i.name).join('、') +
        '。请运行 publish.py check 重新过检查单。'
      );
    }
    // 公开文本重筛:检查单盖章后再改文案,这里拦下(勾选章不等于当前内容合规)
    const textFields = [
      ['title', issue.title], ['greeting', issue.greeting],
      ...(issue.items || []).flatMap((item) =>
        ['name', 'spec', 'eta', 'note', 'deal'].map((f) => [`「${item.name}」${f}`, item[f]])),
    ];
    for (const [where, text] of textFields) {
      const hit = blacklistHit(text);
      if (hit) {
        throw new Error(
          `第${issue.issue}期 ${where} 命中药品黑名单关键词「${hit}」:${text}。` +
          '改掉文案后重新运行 publish.py check。'
        );
      }
    }
    // 坏日期在客户端会让锁价判断失真——构建时就拦下,不让它上线
    for (const field of ['published_at', 'lock_until']) {
      if (!isRealDate(issue[field])) {
        throw new Error(`第${issue.issue}期 ${field} 不是真实存在的日期(YYYY-MM-DD):${issue[field]}`);
      }
    }
  }
  return issues.sort((a, b) => b.issue - a.issue);
}

export function latestIssue() {
  return loadIssues()[0] ?? null;
}
