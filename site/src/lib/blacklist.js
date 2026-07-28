// 药品/器械关键词筛查 + 日期校验:构建层与后台端点共用的唯一实现。
// (关键词数据源:src/data/blacklist-keywords.json,Python 入池层读同一份。)
// 本模块必须保持运行时中立——不碰 import.meta.glob / DOM / node API,
// 否则 Pages Functions 打包会炸。
import blacklistData from '../data/blacklist-keywords.json';

// 与 homarket_scraper/blacklist.py 相同的归一化(小写、去空格点横线)
const STRIP_RE = /[\s.\-_·•'']+/g;
export const normalize = (text) => String(text ?? '').toLowerCase().replace(STRIP_RE, '');

const NORMALIZED_KEYWORDS = blacklistData.keywords.map((k) => [normalize(k), k]);

export function blacklistHit(text) {
  const normalized = normalize(text);
  if (!normalized) return null;
  for (const [norm, original] of NORMALIZED_KEYWORDS) {
    if (normalized.includes(norm)) return original;
  }
  return null;
}

// 真实存在的日历日期(2026-02-31 这类会被 JS 悄悄归一化成三月,必须拦)
export function isRealDate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso ?? '')) return false;
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

// 邀请码语法:客户端归因闸、后台发码校验共用一处
// __proto__ 等保留名会污染以码为键的聚合对象,一并拒掉
const RESERVED_REFS = new Set(['__proto__', 'constructor', 'prototype']);
export function isValidRef(ref) {
  return typeof ref === 'string' && /^[a-zA-Z0-9_-]{1,24}$/.test(ref) && !RESERVED_REFS.has(ref);
}
