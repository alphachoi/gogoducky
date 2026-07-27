// 云端后台端点:认证 fail-closed、字段白名单、published 只降不升、
// 关键词筛查、乐观并发、UTF-8 base64 往返(CJK)。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  b64decodeUtf8, b64encodeUtf8, blacklistHit, requireAccess,
} from '../functions/api/admin/_lib.js';
import { applyChanges, onRequestPut } from '../functions/api/admin/issue.js';
import { onRequestPut as refsPut } from '../functions/api/admin/refs.js';

function jwtWithAud(aud) {
  const payload = btoa(JSON.stringify({ aud }))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `header.${payload}.sig`;
}

function req(headers = {}, body = null) {
  return new Request('http://x/api/admin/issue', {
    method: body ? 'PUT' : 'GET',
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe('requireAccess(fail-closed)', () => {
  it('DEV_MODE=1 放行(仅本地)', () => {
    expect(requireAccess(req(), { DEV_MODE: '1' })).toBeNull();
  });
  it('无 ACCESS_AUD 配置 → 403(忘配 Access 不裸奔)', () => {
    const denied = requireAccess(req({ 'cf-access-jwt-assertion': jwtWithAud(['a']) }), {});
    expect(denied.status).toBe(403);
  });
  it('无 JWT 头 → 403', () => {
    expect(requireAccess(req(), { ACCESS_AUD: 'a' }).status).toBe(403);
  });
  it('aud 不匹配 → 403;匹配放行', () => {
    const env = { ACCESS_AUD: 'expected-aud' };
    expect(requireAccess(req({ 'cf-access-jwt-assertion': jwtWithAud(['other']) }), env).status).toBe(403);
    expect(requireAccess(req({ 'cf-access-jwt-assertion': jwtWithAud(['expected-aud']) }), env)).toBeNull();
  });
});

describe('UTF-8 base64(GitHub contents)', () => {
  it('中文往返无损', () => {
    const text = JSON.stringify({ greeting: '这周 Costco 特价挑了 6 样,¥185 → 锁价' });
    expect(b64decodeUtf8(b64encodeUtf8(text))).toBe(text);
  });
});

describe('applyChanges(字段白名单与红线)', () => {
  const base = () => ({
    issue: 12, title: '第12期', greeting: '', lock_until: '2026-08-01', published: true,
    items: [{ id: 'p1', name: '好货A', spec: '', eta: '', note: '', deal: '', price_cny: 180,
              compliance_confirmed: true }],
  });

  it('合法编辑生效', () => {
    const cur = base();
    const err = applyChanges(cur, {
      greeting: '新卷首语', lock_until: '2026-08-05',
      items: [{ id: 'p1', note: '回购最多', price_cny: 175 }],
    });
    expect(err).toBeNull();
    expect(cur.greeting).toBe('新卷首语');
    expect(cur.items[0].price_cny).toBe(175);
  });

  it('published 只许下架:true→true 拒绝,→false 放行', () => {
    expect(applyChanges(base(), { published: true })).toMatch(/检查单/);
    const cur = base();
    expect(applyChanges(cur, { published: false })).toBeNull();
    expect(cur.published).toBe(false);
  });

  it('未知字段拒绝(compliance_confirmed 等只读)', () => {
    expect(applyChanges(base(), { compliance_confirmed: true })).toMatch(/不允许/);
    expect(applyChanges(base(), { items: [{ id: 'p1', compliance_confirmed: true }] })).toMatch(/不允许/);
    expect(applyChanges(base(), { items: [{ id: 'p1', image: '/x.webp' }] })).toMatch(/不允许/);
  });

  it('文本命中药品关键词拒绝', () => {
    expect(applyChanges(base(), { greeting: '本期有退烧神器' })).toMatch(/黑名单/);
    expect(applyChanges(base(), { items: [{ id: 'p1', note: 'IBU-PROFEN 平替' }] })).toMatch(/黑名单/);
  });

  it('价格与日期校验', () => {
    expect(applyChanges(base(), { items: [{ id: 'p1', price_cny: 0 }] })).toMatch(/价格/);
    expect(applyChanges(base(), { items: [{ id: 'p1', price_cny: 99.5 }] })).toMatch(/价格/);
    expect(applyChanges(base(), { lock_until: '2026-02-31' })).toMatch(/日期/);
  });

  it('不许增删商品', () => {
    expect(applyChanges(base(), { items: [{ id: 'p9', note: 'x' }] })).toMatch(/不存在/);
  });
});

describe('PUT /api/admin/issue(GitHub 提交流)', () => {
  const issueData = {
    issue: 12, title: '第12期', greeting: '', lock_until: '2026-08-01', published: true,
    items: [{ id: 'p1', name: '好货A', spec: '', eta: '', note: '', deal: '', price_cny: 180 }],
  };
  let ghPuts;

  beforeEach(() => {
    ghPuts = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      if (String(url).includes('api.github.com')) {
        if ((init.method || 'GET') === 'PUT') {
          ghPuts.push(JSON.parse(init.body));
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response(JSON.stringify({
          content: b64encodeUtf8(JSON.stringify(issueData)), sha: 'sha-1',
        }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }));
  });

  const env = { DEV_MODE: '1', GITHUB_TOKEN: 't', GITHUB_REPO: 'alpha/gogoducky' };

  it('合法编辑 → 提交内容为合并后的 JSON(CJK 无损)', async () => {
    const resp = await onRequestPut({
      request: req({}, { issue: 12, sha: 'sha-1', changes: { greeting: '中文卷首语' } }),
      env,
    });
    expect(resp.status).toBe(200);
    expect(ghPuts).toHaveLength(1);
    const committed = JSON.parse(b64decodeUtf8(ghPuts[0].content));
    expect(committed.greeting).toBe('中文卷首语');
    expect(committed.items[0].price_cny).toBe(180); // 未动字段保留
  });

  it('sha 过期 → 409,不提交(乐观并发)', async () => {
    const resp = await onRequestPut({
      request: req({}, { issue: 12, sha: 'stale', changes: { greeting: 'x' } }),
      env,
    });
    expect(resp.status).toBe(409);
    expect(ghPuts).toHaveLength(0);
  });

  it('校验失败 → 400,不提交', async () => {
    const resp = await onRequestPut({
      request: req({}, { issue: 12, sha: 'sha-1', changes: { published: true } }),
      env,
    });
    expect(resp.status).toBe(400);
    expect(ghPuts).toHaveLength(0);
  });
});

describe('PUT /api/admin/refs', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({
        content: b64encodeUtf8(JSON.stringify({ refs: ['yuxing01'] })), sha: 'r1',
      }), { status: 200 })));
  });
  const env = { DEV_MODE: '1', GITHUB_TOKEN: 't', GITHUB_REPO: 'a/b' };

  it('非法字符集拒绝', async () => {
    const resp = await refsPut({
      request: req({}, { refs: ['合法之外的码!'], sha: 'r1' }), env,
    });
    expect(resp.status).toBe(400);
  });
  it('重复码拒绝', async () => {
    const resp = await refsPut({
      request: req({}, { refs: ['a1', 'a1'], sha: 'r1' }), env,
    });
    expect(resp.status).toBe(400);
  });
});

describe('blacklistHit(与入池层同清单)', () => {
  it('变体拼写命中,安全品放行', () => {
    expect(blacklistHit('退 烧 贴')).toBeTruthy();
    expect(blacklistHit('Stanley 保温杯')).toBeNull();
  });
});
