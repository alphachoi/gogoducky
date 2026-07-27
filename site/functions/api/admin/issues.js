// GET /api/admin/issues — 期刊列表(实时读 GitHub main 分支,含未发布草稿)。
import { ghGetFile, ghListDir, ISSUES_DIR, json, requireAccess } from './_lib.js';

export async function onRequestGet({ request, env }) {
  const denied = requireAccess(request, env);
  if (denied) return denied;

  try {
    const entries = await ghListDir(env, ISSUES_DIR);
    const files = entries
      .filter((e) => /^issue-\d+\.json$/.test(e.name))
      .map((e) => e.name)
      .sort()
      .reverse();

    const issues = [];
    for (const name of files) {
      const file = await ghGetFile(env, `${ISSUES_DIR}/${name}`);
      if (!file) continue;
      const data = JSON.parse(file.content);
      issues.push({
        issue: data.issue,
        title: data.title,
        published: data.published,
        published_at: data.published_at,
        lock_until: data.lock_until,
        item_count: (data.items || []).length,
      });
    }
    issues.sort((a, b) => b.issue - a.issue);
    return json({ issues });
  } catch (e) {
    console.error('admin issues list failed:', e);
    return json({ error: '读取期刊列表失败' }, 502);
  }
}
