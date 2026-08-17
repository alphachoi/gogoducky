// 归因端点(Cloudflare Pages Function → D1)。
// 防线(eng-review 问题1裁决):仅接受合法期号 + 合法事件类型;
// refs.json 白名单构建时注入(scripts/gen-manifest.mjs → _manifest.json),
// 未知码降级计入 direct(2026-07-26 裁决:退役码旧链接流量不丢,白名单
// 仍保护 ref 字段不进乱码);码→客户映射只存创始人本地表格。
// D1 写失败静默降级(前端不阻塞),但必须 console.error 留痕——
// 否则绑定配错时归因全灭且无人知晓,只能靠发版检查单撞见。
import manifest from '../_manifest.json';

const VALID_TYPES = ['open', 'copy', 'copy_fallback'];
// 中国移动网络大量共享出口 IP(运营商级 NAT),群聊转发的爆发时刻正是归因要
// 度量的时刻——限频宽松些,防脚本刷即可,不误伤同 IP 群体。
const RATE_LIMIT_PER_WINDOW = 120;
const RATE_LIMIT_WINDOW_SECONDS = 60;

function resp(status) {
  return new Response(null, { status });
}

// 原始 IP 永不落库:存「IP+UTC小时」的哈希,只够限频窗口内做相等匹配。
// 盐每小时轮换,旧行之间不可关联——无需依赖后续流量的清理任务。
async function hourlyIpKey(ip) {
  const hour = new Date().toISOString().slice(0, 13); // e.g. 2026-07-26T16
  const data = new TextEncoder().encode(`${ip}:${hour}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return resp(400);
  }
  const { type, issue, ref } = body || {};

  if (!VALID_TYPES.includes(type)) return resp(400);
  if (!Number.isInteger(issue) || !manifest.issues.includes(issue)) return resp(400);
  if (typeof ref !== 'string' || !ref) return resp(400);
  // 未知码降级计入 direct(退役码在微信转发链里永不过期,拒收=流量黑洞)
  const refValue = ref === 'direct' || manifest.refs.includes(ref) ? ref : 'direct';

  if (!env.DB) {
    console.error('attribution: D1 binding "DB" missing — events are being dropped');
    return resp(204);
  }

  try {
    const ipKey = await hourlyIpKey(request.headers.get('cf-connecting-ip') || 'unknown');
    const { results } = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM events WHERE ip = ? AND ts > datetime(\'now\', ?)'
    ).bind(ipKey, `-${RATE_LIMIT_WINDOW_SECONDS} seconds`).all();
    if (results[0].n >= RATE_LIMIT_PER_WINDOW) return resp(429);

    await env.DB.prepare(
      'INSERT INTO events (type, issue, ref, ip) VALUES (?, ?, ?, ?)'
    ).bind(type, issue, refValue, ipKey).run();
  } catch (e) {
    // 写入失败静默降级——归因丢一条,前端照常;但日志必须留痕
    console.error('attribution write failed:', e);
  }
  return resp(204);
}
