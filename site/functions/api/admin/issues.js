// GET /api/admin/issues — 期刊列表(实时读 GitHub main 分支,含未发布草稿)。
//
// 只取最近 LIST_LIMIT 期并发拉取:串行 N+1 会在 Workers 子请求上限(50)处硬失败,
// 一年周刊就撞线;并发也要限量,后台只需要看最近几期。
import { ghGetFile, ghListDir, ISSUES_DIR, json, requireAccess } from './_lib.js';

const LIST_LIMIT = 24; // 约半年;更早的期在本地仓库里看

export async function onRequestGet({ request, env }) {
  const denied = await requireAccess(request, env);
  if (denied) return denied;

  try {
    const entries = await ghListDir(env, ISSUES_DIR);
    const files = entries
      .filter((e) => /^issue-\d+\.json$/.test(e.name))
      .map((e) => e.name)
      .sort()
      .reverse()
      .slice(0, LIST_LIMIT);

    const fetched = await Promise.all(
      files.map((name) => ghGetFile(env, `${ISSUES_DIR}/${name}`))
    );

    const issues = fetched
      .filter(Boolean)
      .map((file) => JSON.parse(file.content))
      .map((data) => ({
        issue: data.issue,
        title: data.title,
        published: data.published,
        published_at: data.published_at,
        lock_until: data.lock_until,
        item_count: (data.items || []).length,
      }))
      .sort((a, b) => b.issue - a.issue);

    return json({ issues, truncated: entries.length > LIST_LIMIT });
  } catch (e) {
    console.error('admin issues list failed:', e);
    return json({ error: `读取期刊列表失败:${e.message}` }, 502);
  }
}
