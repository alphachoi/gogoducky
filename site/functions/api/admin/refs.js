// GET/PUT /api/admin/refs — 邀请码白名单管理(只有码,无客户信息;
// 码→客户映射仍只存创始人本地表格)。退役的码删掉即可:其旧链接事件
// 会自动降级计入 direct,流量不丢。
import { ghGetFile, ghPutFile, json, REFS_PATH, requireAccess } from './_lib.js';

const REF_RE = /^[a-zA-Z0-9_-]{1,24}$/;

export async function onRequestGet({ request, env }) {
  const denied = requireAccess(request, env);
  if (denied) return denied;
  try {
    const file = await ghGetFile(env, REFS_PATH);
    if (!file) return json({ error: 'refs.json 不存在' }, 404);
    const data = JSON.parse(file.content);
    return json({ refs: data.refs, sha: file.sha });
  } catch (e) {
    console.error('admin refs get failed:', e);
    return json({ error: '读取失败' }, 502);
  }
}

export async function onRequestPut({ request, env }) {
  const denied = requireAccess(request, env);
  if (denied) return denied;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: '请求体不是合法 JSON' }, 400);
  }
  const { refs, sha } = body || {};
  if (!Array.isArray(refs)) return json({ error: 'refs 必须是数组' }, 400);
  if (typeof sha !== 'string' || !sha) return json({ error: '缺少 sha(并发保护)' }, 400);
  for (const ref of refs) {
    if (typeof ref !== 'string' || !REF_RE.test(ref)) {
      return json({ error: `邀请码不合法:${ref}(限 a-zA-Z0-9_-,最长 24 位)` }, 400);
    }
  }
  if (new Set(refs).size !== refs.length) return json({ error: '邀请码重复' }, 400);

  try {
    const file = await ghGetFile(env, REFS_PATH);
    if (!file) return json({ error: 'refs.json 不存在' }, 404);
    if (file.sha !== sha) return json({ error: 'refs.json 已被其他修改更新,请刷新重试' }, 409);
    const data = JSON.parse(file.content);
    data.refs = refs;
    await ghPutFile(env, REFS_PATH, JSON.stringify(data, null, 2) + '\n', sha, 'admin: 邀请码更新');
    return json({ ok: true, note: '已提交,归因白名单约 1 分钟后随重建生效' });
  } catch (e) {
    if (e.conflict) return json({ error: e.message }, 409);
    console.error('admin refs put failed:', e);
    return json({ error: '提交失败' }, 502);
  }
}
