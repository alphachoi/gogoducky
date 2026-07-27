// P1 必测:归因校验——合法码写入、未知码拒绝、direct 接受、非法期号拒绝、
// 限频触发、D1 写失败前端不阻塞(仍 204)。
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../functions/_manifest.json', () => ({
  default: { refs: ['yuxing01', 'demo01'], issues: [1, 12] },
}));

import { onRequestPost } from '../functions/api/event.js';

function makeDb({ recentCount = 0, failWrites = false } = {}) {
  const statements = [];
  const db = {
    statements,
    // 只看真正的事件写入(端点还会跑一条 IP 过期清理 UPDATE)
    get inserts() {
      return statements.filter((s) => s.sql.startsWith('INSERT'));
    },
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async all() {
              if (failWrites) throw new Error('D1 down');
              return { results: [{ n: recentCount }] };
            },
            async run() {
              if (failWrites) throw new Error('D1 down');
              statements.push({ sql, args });
              return {};
            },
          };
        },
      };
    },
  };
  return db;
}

function makeRequest(body, ip = '1.2.3.4') {
  return new Request('http://x/api/event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': ip },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function call(body, dbOpts) {
  const db = makeDb(dbOpts);
  const response = await onRequestPost({ request: makeRequest(body), env: { DB: db } });
  return { response, db };
}

describe('归因端点', () => {
  it('合法码写入 → 204,原始 IP 不落库(存时段盐哈希)', async () => {
    const { response, db } = await call({ type: 'open', issue: 12, ref: 'yuxing01' });
    expect(response.status).toBe(204);
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0].args.slice(0, 3)).toEqual(['open', 12, 'yuxing01']);
    const stored = db.inserts[0].args[3];
    expect(stored).toMatch(/^[0-9a-f]{64}$/); // SHA-256 hex
    expect(stored).not.toContain('1.2.3.4');  // 原始 IP 永不出现
  });

  it('保留值 direct 接受', async () => {
    const { response, db } = await call({ type: 'copy', issue: 1, ref: 'direct' });
    expect(response.status).toBe(204);
    expect(db.inserts).toHaveLength(1);
  });

  it('copy_fallback 事件接受', async () => {
    const { response } = await call({ type: 'copy_fallback', issue: 1, ref: 'demo01' });
    expect(response.status).toBe(204);
  });

  it('未知码降级计入 direct(退役码旧链接流量不丢,2026-07-26 裁决)', async () => {
    const { response, db } = await call({ type: 'open', issue: 1, ref: 'retired99' });
    expect(response.status).toBe(204);
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0].args[2]).toBe('direct'); // 不归户,只保总量
  });

  it('ref 缺失/非字符串 → 400', async () => {
    for (const ref of [null, undefined, 42, '']) {
      const { response } = await call({ type: 'open', issue: 1, ref });
      expect(response.status).toBe(400);
    }
  });

  it('非法期号拒绝 → 400', async () => {
    for (const issue of [999, 0, -1, 1.5, '12', null]) {
      const { response } = await call({ type: 'open', issue, ref: 'direct' });
      expect(response.status).toBe(400);
    }
  });

  it('非法事件类型拒绝 → 400', async () => {
    const { response } = await call({ type: 'pageview', issue: 1, ref: 'direct' });
    expect(response.status).toBe(400);
  });

  it('非 JSON body → 400', async () => {
    const { response } = await call('not json{{');
    expect(response.status).toBe(400);
  });

  it('限频触发 → 429', async () => {
    const { response, db } = await call(
      { type: 'open', issue: 1, ref: 'direct' }, { recentCount: 120 });
    expect(response.status).toBe(429);
    expect(db.inserts).toHaveLength(0);
  });

  it('限频以下正常写入(共享出口 IP 的群聊场景不误伤)', async () => {
    const { response, db } = await call(
      { type: 'open', issue: 1, ref: 'direct' }, { recentCount: 119 });
    expect(response.status).toBe(204);
    expect(db.inserts).toHaveLength(1);
  });

  it('同 IP 同小时哈希一致(限频可用),跨小时不可关联由盐轮换保证', async () => {
    const a = await call({ type: 'open', issue: 1, ref: 'direct' });
    const b = await call({ type: 'copy', issue: 1, ref: 'direct' });
    expect(a.db.inserts[0].args[3]).toBe(b.db.inserts[0].args[3]);
  });

  it('D1 写失败静默降级 → 仍 204,前端不阻塞', async () => {
    const { response } = await call(
      { type: 'open', issue: 1, ref: 'direct' }, { failWrites: true });
    expect(response.status).toBe(204);
  });

  it('D1 绑定缺失 → 仍 204(不阻塞前端,靠日志留痕)', async () => {
    const response = await onRequestPost({
      request: makeRequest({ type: 'open', issue: 1, ref: 'direct' }),
      env: {},
    });
    expect(response.status).toBe(204);
  });
});
