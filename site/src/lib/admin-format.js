// 后台 UI 的纯函数层(可单测):HTML 转义与报表聚合。

// 值会插进双引号 HTML 属性(value="…"),必须连引号一起转义——
// textContent/innerHTML 方案不转义引号,复用到不可信数据就是注入口
export function esc(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// 事件行 → 按码聚合。用 Map:码是用户可控字符串,普通对象会被
// __proto__ 这类键污染原型(isValidRef 已拦,这里是第二层)。
export function aggregateByRef(rows) {
  const byRef = new Map();
  for (const row of rows) {
    if (!byRef.has(row.ref)) byRef.set(row.ref, { open: 0, copy: 0, copy_fallback: 0 });
    const bucket = byRef.get(row.ref);
    if (row.type in bucket) bucket[row.type] = row.n;
  }
  return [...byRef.entries()].sort(
    (a, b) => (b[1].copy + b[1].copy_fallback) - (a[1].copy + a[1].copy_fallback));
}
