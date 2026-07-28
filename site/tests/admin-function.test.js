// 云端后台端点:认证 fail-closed、字段白名单、published 只降不升、
// 关键词筛查、乐观并发、UTF-8 base64 往返(CJK)。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  b64decodeUtf8, b64encodeUtf8, blacklistHit, requireAccess,
} from '../functions/api/admin/_lib.js';
import { applyChanges, onRequestGet as issueGet, onRequestPut } from '../functions/api/admin/issue.js';
import { onRequestGet as refsGet, onRequestPut as refsPut } from '../functions/api/admin/refs.js';
import { onRequestGet as statsGet } from '../functions/api/admin/stats.js';
import { onRequestGet as issuesGet } from '../functions/api/admin/issues.js';

const ADMIN_HOST = 'shop.example.com';
const TEAM = 'team.cloudflareaccess.com';

function b64url(obj) {
  return btoa(JSON.stringify(obj))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// 未签名的伪造 JWT——攻击者知道 AUD 就能拼出来,必须被验签拦下
function forgedJwt(aud, extra = {}) {
  const header = b64url({ alg: 'RS256', kid: 'k1' });
  const payload = b64url({
    aud, iss: `https://${TEAM}`, exp: Math.floor(Date.now() / 1000) + 600, ...extra,
  });
  return `${header}.${payload}.ZmFrZS1zaWc`;
}

function req(headers = {}, body = null, url = `https://${ADMIN_HOST}/api/admin/issue`) {
  return new Request(url, {
    method: body ? 'PUT' : 'GET',
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

const prodEnv = { ADMIN_HOST, ACCESS_AUD: 'expected-aud', ACCESS_TEAM_DOMAIN: TEAM };

describe('requireAccess(fail-closed + 真实验签)', () => {
  it('本地 DEV_MODE 放行;但 Pages 环境里 DEV_MODE 无效(面板误设不解锁线上)', async () => {
    expect(await requireAccess(req(), { DEV_MODE: '1' })).toBeNull();
    const denied = await requireAccess(req(), { DEV_MODE: '1', CF_PAGES: '1', ...prodEnv });
    expect(denied.status).toBe(403);
  });

  it('pages.dev / 预览域一律拒绝(那里没有 Access 边缘保护)', async () => {
    const denied = await requireAccess(
      req({ 'cf-access-jwt-assertion': forgedJwt(['expected-aud']) }, null,
        'https://gogoducky.pages.dev/api/admin/issue'),
      prodEnv);
    expect(denied.status).toBe(403);
    expect((await denied.json()).error).toMatch(/域名/);
  });

  it('伪造(未签名)JWT → 403,即使 aud/iss/exp 全对', async () => {
    // JWKS 返回一把真密钥,但伪造的签名过不了 verify
    const { publicKey } = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true, ['verify', 'sign']);
    const jwk = await crypto.subtle.exportKey('jwk', publicKey);
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ keys: [{ ...jwk, kid: 'k1' }] }), { status: 200 })));

    const denied = await requireAccess(
      req({ 'cf-access-jwt-assertion': forgedJwt(['expected-aud']) }), prodEnv);
    expect(denied.status).toBe(403);
    expect((await denied.json()).error).toMatch(/签名/);
  });

  it('真实签名 + 正确 aud/iss/exp → 放行;aud 错/过期/签发方错 → 403', async () => {
    const { publicKey, privateKey } = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true, ['verify', 'sign']);
    const jwk = await crypto.subtle.exportKey('jwk', publicKey);
    // kid 用新值:上一条用例的 k1 还在模块缓存里,这里同时验证
    // 「缓存里没有该 kid 就强制刷新」这条密钥轮换路径
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ keys: [{ ...jwk, kid: 'k2' }] }), { status: 200 })));

    const sign = async (payload) => {
      const head = b64url({ alg: 'RS256', kid: 'k2' });
      const body = b64url(payload);
      const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey,
        new TextEncoder().encode(`${head}.${body}`));
      const b64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      return `${head}.${body}.${b64}`;
    };
    const future = Math.floor(Date.now() / 1000) + 600;

    const good = await sign({ aud: ['expected-aud'], iss: `https://${TEAM}`, exp: future });
    expect(await requireAccess(req({ 'cf-access-jwt-assertion': good }), prodEnv)).toBeNull();

    const wrongAud = await sign({ aud: ['other'], iss: `https://${TEAM}`, exp: future });
    expect((await requireAccess(req({ 'cf-access-jwt-assertion': wrongAud }), prodEnv)).status).toBe(403);

    const expired = await sign({
      aud: ['expected-aud'], iss: `https://${TEAM}`, exp: Math.floor(Date.now() / 1000) - 10 });
    expect((await requireAccess(req({ 'cf-access-jwt-assertion': expired }), prodEnv)).status).toBe(403);

    const wrongIss = await sign({ aud: ['expected-aud'], iss: 'https://evil.example', exp: future });
    expect((await requireAccess(req({ 'cf-access-jwt-assertion': wrongIss }), prodEnv)).status).toBe(403);
  });

  it('缺配置 / 无 JWT / 畸形 JWT 一律 403', async () => {
    expect((await requireAccess(req({ 'cf-access-jwt-assertion': 'x.y.z' }),
      { ADMIN_HOST })).status).toBe(403);
    expect((await requireAccess(req(), prodEnv)).status).toBe(403);
    expect((await requireAccess(req({ 'cf-access-jwt-assertion': 'not-a-jwt' }), prodEnv)).status).toBe(403);
  });
});

describe('UTF-8 base64(GitHub contents)', () => {
  it('中文往返无损', () => {
    const text = JSON.stringify({ greeting: '这周 Costco 特价挑了 6 样,¥185 → 锁价' });
    expect(b64decodeUtf8(b64encodeUtf8(text))).toBe(text);
  });
  it('GitHub 返回的 60 字符换行包裹 base64 可解码(每条读路径都依赖)', () => {
    const text = JSON.stringify({ greeting: '换行包裹的中文内容测试'.repeat(10) });
    const wrapped = b64encodeUtf8(text).replace(/(.{60})/g, '$1\n');
    expect(wrapped).toContain('\n');
    expect(b64decodeUtf8(wrapped)).toBe(text);
  });
});

describe('applyChanges(字段白名单与红线)', () => {
  const base = () => ({
    issue: 12, title: '第12期', greeting: '',
    published_at: '2026-07-26', lock_until: '2026-08-01', published: true, fx_rate: 5.2,
    items: [{ id: 'p1', name: '好货A', spec: '', eta: '', note: '', deal: '', price_cny: 180,
              price_cad_cents: 2599, compliance_confirmed: true }],
  });

  it('合法编辑生效', () => {
    const cur = base();
    const { error } = applyChanges(cur, {
      greeting: '新卷首语', lock_until: '2026-08-05',
      items: [{ id: 'p1', note: '回购最多', price_cny: 175 }],
    });
    expect(error).toBeUndefined();
    expect(cur.greeting).toBe('新卷首语');
    expect(cur.items[0].price_cny).toBe(175);
  });

  it('价格低于加币进价折算 → 拒绝(锁价一周的确定亏损)', () => {
    // 25.99 CAD × 5.2 ≈ ¥135
    expect(applyChanges(base(), { items: [{ id: 'p1', price_cny: 100 }] }).error)
      .toMatch(/低于加币进价/);
    expect(applyChanges(base(), { items: [{ id: 'p1', price_cny: 140 }] }).error).toBeUndefined();
  });

  it('锁价日期只能顺延有限天数(年份手滑打成 2099 会废掉过期防线)', () => {
    expect(applyChanges(base(), { lock_until: '2099-12-31' }).error).toMatch(/1–30 天/);
    expect(applyChanges(base(), { lock_until: '2026-07-20' }).error).toMatch(/1–30 天/);
  });

  it('改商品名 → 合规勾选作废 + 本期自动下架(身份变了,原勾选不再适用)', () => {
    const cur = base();
    const { error, warnings } = applyChanges(cur, {
      items: [{ id: 'p1', name: '好货A 2024 新版' }],
    });
    expect(error).toBeUndefined();
    expect(cur.items[0].compliance_confirmed).toBe(false);
    expect(cur.published).toBe(false);
    expect(warnings[0]).toMatch(/合规勾选作废/);
  });

  it('published 只许下架:true→true 拒绝,→false 放行', () => {
    expect(applyChanges(base(), { published: true }).error).toMatch(/检查单/);
    const cur = base();
    expect(applyChanges(cur, { published: false }).error).toBeUndefined();
    expect(cur.published).toBe(false);
  });

  it('未知字段拒绝(compliance_confirmed 等只读)', () => {
    expect(applyChanges(base(), { compliance_confirmed: true }).error).toMatch(/不允许/);
    expect(applyChanges(base(), { items: [{ id: 'p1', compliance_confirmed: true }] }).error).toMatch(/不允许/);
    expect(applyChanges(base(), { items: [{ id: 'p1', image: '/x.webp' }] }).error).toMatch(/不允许/);
  });

  it('文本命中药品关键词拒绝', () => {
    expect(applyChanges(base(), { greeting: '本期有退烧神器' }).error).toMatch(/黑名单/);
    expect(applyChanges(base(), { items: [{ id: 'p1', note: 'IBU-PROFEN 平替' }] }).error).toMatch(/黑名单/);
  });

  it('价格与日期校验', () => {
    expect(applyChanges(base(), { items: [{ id: 'p1', price_cny: 0 }] }).error).toMatch(/价格/);
    expect(applyChanges(base(), { items: [{ id: 'p1', price_cny: 99.5 }] }).error).toMatch(/价格/);
    expect(applyChanges(base(), { lock_until: '2026-02-31' }).error).toMatch(/日期/);
  });

  it('不许增删商品', () => {
    expect(applyChanges(base(), { items: [{ id: 'p9', note: 'x' }] }).error).toMatch(/不存在/);
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

  const env = { DEV_MODE: '1', GITHUB_TOKEN: 't', GITHUB_REPO: 'alpha/gogoducky', ADMIN_HOST };

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
    // 真实 GitHub 缺 sha 会 422、缺 branch 会写错分支——mock 不会替我们发现
    expect(ghPuts[0].sha).toBe('sha-1');
    expect(ghPuts[0].branch).toBe('main');
    expect(ghPuts[0].message).toContain('12');
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

  it('sha 预检后 GitHub 端仍 409(竞态)→ 端点 409,可读提示', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      if ((init.method || 'GET') === 'PUT') return new Response('{}', { status: 409 });
      return new Response(JSON.stringify({
        content: b64encodeUtf8(JSON.stringify(issueData)), sha: 'sha-1',
      }), { status: 200 });
    }));
    const resp = await onRequestPut({
      request: req({}, { issue: 12, sha: 'sha-1', changes: { greeting: 'x' } }),
      env,
    });
    expect(resp.status).toBe(409);
    expect((await resp.json()).error).toMatch(/刷新/);
  });

  it('请求体不是 JSON → 400;GET:期号不合法 400、不存在 404', async () => {
    const bad = await onRequestPut({
      request: new Request('http://x/api/admin/issue', { method: 'PUT', body: '{oops' }),
      env,
    });
    expect(bad.status).toBe(400);

    const badN = await issueGet({
      request: new Request('http://x/api/admin/issue?n=abc'), env,
    });
    expect(badN.status).toBe(400);

    // 内容 404 但仓库探针 200 = 文件真不存在(404);探针也失败才是 token 问题
    vi.stubGlobal('fetch', vi.fn(async (url) =>
      String(url).includes('/contents/')
        ? new Response('{}', { status: 404 })
        : new Response('{}', { status: 200 })));
    const missing = await issueGet({
      request: new Request('http://x/api/admin/issue?n=999'), env,
    });
    expect(missing.status).toBe(404);

    // 探针也 401/404 → token 失效,必须报 502 而不是伪装成"该期不存在"
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    const badToken = await issueGet({
      request: new Request('http://x/api/admin/issue?n=999'), env,
    });
    expect(badToken.status).toBe(502);
    expect((await badToken.json()).error).toMatch(/token/);
  });
});

describe('GET /api/admin/stats(D1)', () => {
  const env = { DEV_MODE: '1', ADMIN_HOST };

  // 按绑定的时间窗口/分组分派不同结果:三条查询若接错线,断言会炸
  function makeDb() {
    const seen = [];
    return {
      seen,
      prepare(sql) {
        return {
          bind(window) {
            seen.push({ sql, window });
            const tag = `${sql.includes('issue, type') ? 'issue' : 'ref'}${window}`;
            return { __rows: [{ tag, n: 1 }] };
          },
        };
      },
      async batch(stmts) {
        return stmts.map((s) => ({ results: s.__rows }));
      },
    };
  }

  it('D1 未绑定 → 502', async () => {
    expect((await statsGet({ request: req(), env })).status).toBe(502);
  });

  it('三组口径各自对应正确的窗口与分组(batch 一次往返)', async () => {
    const db = makeDb();
    const resp = await statsGet({ request: req(), env: { ...env, DB: db } });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.by_ref_7d[0].tag).toBe('ref-7 days');
    expect(body.by_ref_28d[0].tag).toBe('ref-28 days');
    expect(body.by_issue_28d[0].tag).toBe('issue-28 days');
    expect(db.seen).toHaveLength(3); // 一次 batch,不是四次串行
  });

  it('查询抛错 → 502(不静默空数据)', async () => {
    const db = { prepare: () => ({ bind: () => ({}) }), batch: async () => { throw new Error('D1 down'); } };
    const resp = await statsGet({ request: req(), env: { ...env, DB: db } });
    expect(resp.status).toBe(502);
  });
});

describe('PUT /api/admin/refs', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({
        content: b64encodeUtf8(JSON.stringify({ refs: ['yuxing01'] })), sha: 'r1',
      }), { status: 200 })));
  });
  const env = { DEV_MODE: '1', GITHUB_TOKEN: 't', GITHUB_REPO: 'a/b', ADMIN_HOST };

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

describe('覆盖缺口补齐(闸门第二轮)', () => {
  const env = { DEV_MODE: '1', GITHUB_TOKEN: 't', GITHUB_REPO: 'a/b', ADMIN_HOST };

  it('GitHub 5xx → 端点 502(不吞成 200)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('oops', { status: 500 })));
    const resp = await issueGet({ request: new Request('http://x/api/admin/issue?n=1'), env });
    expect(resp.status).toBe(502);
  });

  it('applyChanges:超长文本、items 非数组、价格超上限', () => {
    const base = {
      issue: 1, greeting: '', lock_until: '2026-08-01', published: true,
      items: [{ id: 'p1', name: 'A', price_cny: 100 }],
    };
    expect(applyChanges({ ...base }, { greeting: 'x'.repeat(501) }).error).toMatch(/超长/);
    expect(applyChanges({ ...base }, { items: 'not-array' }).error).toMatch(/数组/);
    expect(applyChanges({ ...base }, { items: [{ id: 'p1', price_cny: 100001 }] }).error).toMatch(/价格/);
  });

  it('refs GET 返回码表+sha;合法 PUT 提交成功;陈旧 sha → 409', async () => {
    const ghPuts = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      if ((init.method || 'GET') === 'PUT') {
        ghPuts.push(JSON.parse(init.body));
        return new Response('{}', { status: 200 });
      }
      return new Response(JSON.stringify({
        content: b64encodeUtf8(JSON.stringify({ refs: ['yuxing01'] })), sha: 'r1',
      }), { status: 200 });
    }));
    const got = await refsGet({ request: req(), env });
    expect((await got.json())).toMatchObject({ refs: ['yuxing01'], sha: 'r1' });

    const ok = await refsPut({ request: req({}, { refs: ['yuxing01', 'chenyq01'], sha: 'r1' }), env });
    expect(ok.status).toBe(200);
    expect(JSON.parse(b64decodeUtf8(ghPuts[0].content)).refs).toEqual(['yuxing01', 'chenyq01']);

    const stale = await refsPut({ request: req({}, { refs: ['x1'], sha: 'old' }), env });
    expect(stale.status).toBe(409);
  });

  it('issues 列表:过滤非期文件、按期号倒序、字段摘要', async () => {
    const mk = (issue) => ({
      issue, title: `第${issue}期`, published: true,
      published_at: '2026-07-20', lock_until: '2026-07-27', items: [{}, {}],
    });
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const s = String(url);
      if (s.includes('issue-001.json')) {
        return new Response(JSON.stringify({
          content: b64encodeUtf8(JSON.stringify(mk(1))), sha: 'a' }), { status: 200 });
      }
      if (s.includes('issue-002.json')) {
        return new Response(JSON.stringify({
          content: b64encodeUtf8(JSON.stringify(mk(2))), sha: 'b' }), { status: 200 });
      }
      return new Response(JSON.stringify([
        { name: 'issue-001.json' }, { name: 'issue-002.json' }, { name: 'README.md' },
      ]), { status: 200 });
    }));
    const resp = await issuesGet({ request: req(), env });
    const { issues } = await resp.json();
    expect(issues.map((i) => i.issue)).toEqual([2, 1]);
    expect(issues[0]).toMatchObject({ title: '第2期', item_count: 2, published: true });
  });

  it('stats:D1 查询抛错 → 502(不静默空数据)', async () => {
    const db = { prepare: () => ({ all: async () => { throw new Error('D1 down'); } }) };
    const resp = await statsGet({ request: req(), env: { DEV_MODE: '1', DB: db } });
    expect(resp.status).toBe(502);
  });
});
