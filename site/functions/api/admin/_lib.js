// 云端后台共享层:认证、GitHub contents API、UTF-8 base64、关键词筛查。
//
// 安全模型(必须自立,不能只依赖边缘):
// - Cloudflare Access 在边缘拦截自定义域上的 /admin* 与 /api/admin*。
// - 但 Pages 同时把同一份部署(带 GITHUB_TOKEN 绑定)挂在 <project>.pages.dev
//   和分支预览域上,那里没有 Access 强制——所以本层必须真验签,
//   否则任何知道 AUD 标签(它不是秘密)的人都能伪造 JWT 拿到仓库写权限。
// - 因此:JWKS 验签(RS256)+ aud/exp/iss 校验 + 主机白名单,全部 fail-closed。
import { blacklistHit, isRealDate, isValidRef } from '../../../src/lib/blacklist.js';

export { blacklistHit, isRealDate, isValidRef };

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

// JWKS 缓存(Worker 实例内存活;Access 轮换密钥后最迟 1 小时自动刷新)
let jwksCache = { keys: null, fetchedAt: 0 };
const JWKS_TTL_MS = 60 * 60 * 1000;

async function getJwks(teamDomain, { force = false } = {}) {
  const now = Date.now();
  if (!force && jwksCache.keys && now - jwksCache.fetchedAt < JWKS_TTL_MS) return jwksCache.keys;
  const resp = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!resp.ok) throw new Error(`JWKS fetch failed: ${resp.status}`);
  const { keys } = await resp.json();
  jwksCache = { keys, fetchedAt: now };
  return keys;
}

// 密钥轮换后新 kid 不在缓存里:强制刷新一次再判,
// 否则每次轮换都要把创始人挡在门外最多一小时
async function findKey(teamDomain, kid) {
  let keys = await getJwks(teamDomain);
  let jwk = keys.find((k) => k.kid === kid);
  if (!jwk) {
    keys = await getJwks(teamDomain, { force: true });
    jwk = keys.find((k) => k.kid === kid);
  }
  return jwk;
}

function b64urlToBytes(b64url) {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

// 生产部署只接受自定义域;pages.dev / 预览域不受 Access 保护,一律拒绝。
function hostAllowed(request, env) {
  if (!env.ADMIN_HOST) return false;
  const host = new URL(request.url).hostname;
  return host === env.ADMIN_HOST;
}

export async function requireAccess(request, env) {
  // DEV_MODE 只在非 Pages 环境(本地 wrangler pages dev)生效——
  // 在 Pages 面板误设也解锁不了线上部署
  if (env.DEV_MODE === '1' && !env.CF_PAGES) return null;

  if (!hostAllowed(request, env)) {
    return json({ error: '此域名不提供后台(仅自定义域,Access 保护)' }, 403);
  }
  const jwt = request.headers.get('cf-access-jwt-assertion');
  if (!env.ACCESS_AUD || !env.ACCESS_TEAM_DOMAIN || !jwt) {
    return json({ error: '未认证(Access 未配置或未登录)' }, 403);
  }

  const parts = jwt.split('.');
  if (parts.length !== 3) return json({ error: 'Access JWT 格式错误' }, 403);

  try {
    const header = JSON.parse(b64decodeUtf8(parts[0].replace(/-/g, '+').replace(/_/g, '/')));
    const payload = JSON.parse(b64urlDecodeUtf8(parts[1]));

    const jwk = await findKey(env.ACCESS_TEAM_DOMAIN, header.kid);
    if (!jwk) return json({ error: 'Access 签名密钥未知' }, 403);

    const key = await crypto.subtle.importKey(
      'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']
    );
    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5', key,
      b64urlToBytes(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    );
    if (!valid) return json({ error: 'Access 签名无效' }, 403);

    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(env.ACCESS_AUD)) return json({ error: 'Access aud 不匹配' }, 403);
    if (payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) {
      return json({ error: 'Access 签发方不匹配' }, 403);
    }
    if (!payload.exp || payload.exp * 1000 <= Date.now()) {
      return json({ error: 'Access 登录已过期,请重新登录' }, 403);
    }
  } catch (e) {
    console.error('access verify failed:', e);
    return json({ error: 'Access 校验失败' }, 403);
  }
  return null;
}

// ---- UTF-8 safe base64(GitHub contents API 用;btoa 只认 latin1)----
export function b64encodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function b64decodeUtf8(b64) {
  const bin = atob(b64.replace(/\n/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function b64urlDecodeUtf8(b64url) {
  return b64decodeUtf8(b64url.replace(/-/g, '+').replace(/_/g, '/'));
}

// ---- GitHub contents API ----
function ghHeaders(env) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'gogoducky-admin',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

// GitHub 对私有仓库的鉴权失败也返回 404(防信息泄露),不能一律当"文件不存在":
// token 失效会伪装成"该期不存在",配错时排查无从下手。
async function is404Auth(env) {
  const probe = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}`,
    { headers: ghHeaders(env) });
  return !probe.ok;
}

export async function ghGetFile(env, path) {
  const resp = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}?ref=main`,
    { headers: ghHeaders(env) }
  );
  if (resp.status === 404) {
    if (await is404Auth(env)) throw new Error('GitHub token 无效或权限不足');
    return null;
  }
  if (!resp.ok) throw new Error(`GitHub GET ${path}: ${resp.status}`);
  const file = await resp.json();
  return { content: b64decodeUtf8(file.content), sha: file.sha };
}

export async function ghListDir(env, path) {
  const resp = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}?ref=main`,
    { headers: ghHeaders(env) }
  );
  if (resp.status === 404) {
    if (await is404Auth(env)) throw new Error('GitHub token 无效或权限不足');
    return [];
  }
  if (!resp.ok) throw new Error(`GitHub LIST ${path}: ${resp.status}`);
  return resp.json();
}

export async function ghPutFile(env, path, content, sha, message) {
  const resp = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`,
    {
      method: 'PUT',
      headers: ghHeaders(env),
      body: JSON.stringify({
        message,
        content: b64encodeUtf8(content),
        sha,
        branch: 'main',
      }),
    }
  );
  if (resp.status === 409) {
    throw Object.assign(new Error('文件已被其他修改更新,请刷新后重试'), { conflict: true });
  }
  if (!resp.ok) throw new Error(`GitHub PUT ${path}: ${resp.status}`);
  return resp.json();
}

export const ISSUES_DIR = 'site/src/data/issues';
export const REFS_PATH = 'site/src/data/refs.json';
