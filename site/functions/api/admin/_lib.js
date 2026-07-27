// 云端后台共享层:认证、GitHub contents API、UTF-8 base64、关键词筛查。
//
// 安全模型:
// - 第一道闸在边缘:Cloudflare Access 应用必须覆盖 /admin* 与 /api/admin*
//   (部署文档有配置步骤),未登录请求根本到不了这里。
// - 本层做纵深防御:校验 Access JWT 头存在且 aud 匹配(不做签名验证——
//   边缘已强制;这里防的是 Access 应用被误删/漏配路径)。
// - fail-closed:ACCESS_AUD 未配置且非本地开发(DEV_MODE)时一律 403,
//   「忘了配 Access 就裸奔」这条路不存在。
import blacklistData from '../../../src/data/blacklist-keywords.json';

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export function requireAccess(request, env) {
  if (env.DEV_MODE === '1') return null; // 仅本地 wrangler pages dev --binding DEV_MODE=1
  const jwt = request.headers.get('cf-access-jwt-assertion');
  if (!env.ACCESS_AUD || !jwt) {
    return json({ error: '未认证(Access 未配置或未登录)' }, 403);
  }
  try {
    const payload = JSON.parse(b64urlDecodeUtf8(jwt.split('.')[1]));
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(env.ACCESS_AUD)) {
      return json({ error: 'Access aud 不匹配' }, 403);
    }
  } catch {
    return json({ error: 'Access JWT 不可解析' }, 403);
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

export async function ghGetFile(env, path) {
  const resp = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}?ref=main`,
    { headers: ghHeaders(env) }
  );
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`GitHub GET ${path}: ${resp.status}`);
  const file = await resp.json();
  return { content: b64decodeUtf8(file.content), sha: file.sha };
}

export async function ghListDir(env, path) {
  const resp = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}?ref=main`,
    { headers: ghHeaders(env) }
  );
  if (resp.status === 404) return [];
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

// ---- 关键词筛查(与入池层/构建层同一清单、同一归一化)----
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

export const ISSUES_DIR = 'site/src/data/issues';
export const REFS_PATH = 'site/src/data/refs.json';
