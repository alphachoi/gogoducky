// GET /api/admin/issue?n=12 — 单期内容 + sha(乐观并发)
// PUT /api/admin/issue — 白名单字段编辑,提交到 GitHub → Pages 自动重建生效
//
// 红线(与本地检查单/构建防线一致,云端绝不放宽):
// - published 只许 true→false(下架);上架必须走本地 publish.py check 检查单
// - compliance_confirmed 只读
// - 全部文本字段过关键词黑名单(构建层还会再筛一遍,这里提前给出可读报错)
// - 不允许增删商品(v1)
import {
  blacklistHit, ghGetFile, ghPutFile, ISSUES_DIR, isRealDate, json, requireAccess,
} from './_lib.js';

const TEXT_LIMIT = 500;
const ITEM_TEXT_FIELDS = ['name', 'spec', 'eta', 'note', 'deal'];

function issuePath(n) {
  return `${ISSUES_DIR}/issue-${String(n).padStart(3, '0')}.json`;
}

export async function onRequestGet({ request, env }) {
  const denied = requireAccess(request, env);
  if (denied) return denied;

  const n = Number(new URL(request.url).searchParams.get('n'));
  if (!Number.isInteger(n) || n < 1) return json({ error: '期号不合法' }, 400);

  try {
    const file = await ghGetFile(env, issuePath(n));
    if (!file) return json({ error: '该期不存在' }, 404);
    return json({ data: JSON.parse(file.content), sha: file.sha });
  } catch (e) {
    console.error('admin issue get failed:', e);
    return json({ error: '读取失败' }, 502);
  }
}

// 返回错误字符串或 null;merged 就地修改
export function applyChanges(current, changes) {
  const textCheck = (where, value) => {
    if (typeof value !== 'string') return `${where} 必须是文本`;
    if (value.length > TEXT_LIMIT) return `${where} 超长(≤${TEXT_LIMIT} 字)`;
    const hit = blacklistHit(value);
    if (hit) return `${where} 命中药品黑名单关键词「${hit}」,请改写`;
    return null;
  };

  for (const key of Object.keys(changes)) {
    if (!['greeting', 'lock_until', 'published', 'items'].includes(key)) {
      return `不允许修改字段:${key}`;
    }
  }

  if ('greeting' in changes) {
    const err = textCheck('卷首语', changes.greeting);
    if (err) return err;
    current.greeting = changes.greeting;
  }
  if ('lock_until' in changes) {
    if (!isRealDate(changes.lock_until)) return `锁价日期不合法:${changes.lock_until}`;
    current.lock_until = changes.lock_until;
  }
  if ('published' in changes) {
    if (changes.published !== false) {
      return '云端只能下架(published→false);上架必须在本地过 publish.py check 检查单';
    }
    current.published = false;
  }
  if ('items' in changes) {
    if (!Array.isArray(changes.items)) return 'items 必须是数组';
    const byId = new Map(current.items.map((item) => [item.id, item]));
    for (const patch of changes.items) {
      const item = byId.get(patch.id);
      if (!item) return `商品不存在:${patch.id}(云端不允许增删商品)`;
      for (const key of Object.keys(patch)) {
        if (key === 'id') continue;
        if (key === 'price_cny') {
          if (!Number.isInteger(patch.price_cny) || patch.price_cny < 1 || patch.price_cny > 100000) {
            return `「${item.name}」价格不合法:${patch.price_cny}`;
          }
          item.price_cny = patch.price_cny;
        } else if (ITEM_TEXT_FIELDS.includes(key)) {
          const err = textCheck(`「${item.name}」${key}`, patch[key]);
          if (err) return err;
          item[key] = patch[key];
        } else {
          return `商品字段不允许修改:${key}`;
        }
      }
    }
  }
  return null;
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
  const { issue, sha, changes } = body || {};
  if (!Number.isInteger(issue) || issue < 1) return json({ error: '期号不合法' }, 400);
  if (typeof sha !== 'string' || !sha) return json({ error: '缺少 sha(并发保护)' }, 400);
  if (!changes || typeof changes !== 'object') return json({ error: '缺少 changes' }, 400);

  try {
    const file = await ghGetFile(env, issuePath(issue));
    if (!file) return json({ error: '该期不存在' }, 404);
    if (file.sha !== sha) {
      return json({ error: '该期已被其他修改更新,请刷新后重试' }, 409);
    }
    const current = JSON.parse(file.content);
    const err = applyChanges(current, changes);
    if (err) return json({ error: err }, 400);

    await ghPutFile(
      env, issuePath(issue),
      JSON.stringify(current, null, 2) + '\n',
      sha,
      `admin: 第${issue}期 云端编辑`
    );
    return json({ ok: true, note: '已提交,站点约 1 分钟后自动重建生效' });
  } catch (e) {
    if (e.conflict) return json({ error: e.message }, 409);
    console.error('admin issue put failed:', e);
    return json({ error: '提交失败' }, 502);
  }
}
