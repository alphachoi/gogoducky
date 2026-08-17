// 单期页客户端逻辑:ref 透传、数量选择、复制订单(含剪贴板降级)、
// 锁价过期/超14天判断、归因埋点(静默降级,绝不阻塞前端)。
import { buildOrderText } from '../lib/order-text.js';
import { isExpired, isStale } from '../lib/dates.js';
import { applyRefPassthrough, currentRef } from '../lib/ref.js';

const data = JSON.parse(document.getElementById('issue-data').textContent);

// --- ref 透传:码只来自 URL,多层转发靠链接自带 ---
const ref = currentRef();
const refOrDirect = ref || 'direct';
applyRefPassthrough(ref);

// --- 归因埋点:同类事件每次页面加载只报一次(连点不产生重复事件) ---
const sentTypes = new Set();
function sendEvent(type) {
  if (sentTypes.has(type)) return;
  sentTypes.add(type);
  try {
    fetch('/api/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, issue: data.issue, ref: refOrDirect }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* 静默降级 */
  }
}
sendEvent('open');

// --- 锁价过期 / 超14天提示(纯前端日期判断) ---
const expired = isExpired(data.lock_until);
if (expired) {
  const banner = document.getElementById('expired-banner');
  banner.hidden = false;
  if (data.is_latest) {
    // 最新一期也过期(断更间隙):不能让「看最新一期」指回本页自己
    banner.innerHTML = '本期锁价已过,新一期制作中 → <a href="/archive/" data-ref-link>先看往期存档</a>';
    applyRefPassthrough(ref);
  }
  document.body.classList.add('expired');
  document.querySelectorAll('.qty-btn').forEach((btn) => (btn.disabled = true));
  document.querySelectorAll('[data-price-note]').forEach((el) => {
    el.textContent = '价格已失效';
  });
}
if (data.is_latest && isStale(data.published_at, new Date(), data.stale_days)) {
  document.getElementById('stale-banner').hidden = false;
}

// --- 数量选择 ---
const quantities = new Map(data.items.map((item) => [item.id, 0]));
const copyBtn = document.getElementById('copy-order');
const summary = document.getElementById('order-summary');

function refreshBar() {
  if (expired) {
    summary.textContent = '本期已过锁价期,看最新一期下单';
    copyBtn.disabled = true;
    return;
  }
  let count = 0;
  let total = 0;
  for (const item of data.items) {
    const qty = quantities.get(item.id);
    count += qty;
    total += qty * item.price_cny;
  }
  if (count > 0) {
    summary.innerHTML = '';
    summary.append(`已选 ${count} 件 · 合计 `);
    const b = document.createElement('b');
    b.textContent = `¥${total}`;
    summary.append(b);
  } else {
    summary.textContent = '还没选商品';
  }
  copyBtn.disabled = count === 0;
}

document.querySelectorAll('.product-card').forEach((card) => {
  const id = card.dataset.id;
  const qtyEl = card.querySelector('[data-qty]');
  card.querySelectorAll('.qty-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const delta = btn.dataset.action === 'plus' ? 1 : -1;
      const next = Math.max(0, quantities.get(id) + delta);
      quantities.set(id, next);
      qtyEl.textContent = String(next);
      card.classList.toggle('selected', next > 0);
      refreshBar();
    });
  });
});
refreshBar();

// --- 复制订单:成功弹层展示已复制内容;失败展示可长按全选的降级框 ---
function currentOrderText() {
  const selections = data.items
    .map((item) => ({ ...item, qty: quantities.get(item.id) }))
    .filter((item) => item.qty > 0);
  return buildOrderText({
    issueNo: data.issue,
    ref,
    selections,
    lockUntil: data.lock_until,
  });
}

async function copyText(text) {
  // 微信内置浏览器部分版本 navigator.clipboard 静默失败,须真实验证结果
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* fall through */
    }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

const sheet = document.getElementById('sheet');
const mask = document.getElementById('sheet-mask');
function openSheet(fallback, text) {
  document.getElementById('sheet-title').textContent =
    fallback ? '自动复制没成功' : '订单已复制';
  const hint = document.getElementById('sheet-hint');
  hint.textContent = fallback
    ? '长按下面的文字,全选后复制,再去微信粘贴给我:'
    : '去微信粘贴给我就好。下面是复制的内容:';
  hint.classList.toggle('warn', fallback);
  document.getElementById('sheet-text').value = text;
  mask.hidden = false;
  sheet.classList.add('show');
}
function closeSheet() {
  mask.hidden = true;
  sheet.classList.remove('show');
}
document.getElementById('sheet-close').addEventListener('click', closeSheet);
mask.addEventListener('click', closeSheet);

const toastEl = document.getElementById('toast');
let toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
}

copyBtn.addEventListener('click', async () => {
  const text = currentOrderText();
  const ok = await copyText(text);
  if (ok) {
    sendEvent('copy'); // 归因上报以实际复制结果为准
    copyBtn.textContent = '已复制 ✓';
    copyBtn.classList.add('done');
    setTimeout(() => {
      copyBtn.textContent = '复制订单';
      copyBtn.classList.remove('done');
    }, 2600);
    openSheet(false, text);
  } else {
    sendEvent('copy_fallback');
    openSheet(true, text);
  }
});

// --- 转发:复制本期链接(透传当前 ref) ---
document.getElementById('share-btn').addEventListener('click', async (e) => {
  const ok = await copyText(location.href);
  e.target.textContent = ok ? '链接已复制,去微信粘贴' : '复制失败,请长按地址栏复制';
  if (ok) toast('本期链接已复制');
});
