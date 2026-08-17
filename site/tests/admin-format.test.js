// 后台 UI 纯函数:HTML 属性上下文转义、按码聚合(原型污染防护)。
import { describe, expect, it } from 'vitest';
import { aggregateByRef, esc } from '../src/lib/admin-format.js';

describe('esc(属性上下文转义)', () => {
  it('转义引号——值插进 value="…",不转引号就是注入口', () => {
    expect(esc('"><img src=x onerror=alert(1)>')).toBe(
      '&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
    expect(esc("it's")).toBe('it&#39;s');
  });
  it('& 先转,避免二次转义错位', () => {
    expect(esc('a & <b>')).toBe('a &amp; &lt;b&gt;');
  });
  it('null/undefined → 空串', () => {
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
  });
});

describe('aggregateByRef', () => {
  it('按码归并三类事件,按复制量倒序', () => {
    const rows = [
      { ref: 'a1', type: 'open', n: 10 }, { ref: 'a1', type: 'copy', n: 1 },
      { ref: 'b2', type: 'copy', n: 5 }, { ref: 'b2', type: 'copy_fallback', n: 2 },
    ];
    const out = aggregateByRef(rows);
    expect(out.map(([ref]) => ref)).toEqual(['b2', 'a1']);
    expect(out[1][1]).toEqual({ open: 10, copy: 1, copy_fallback: 0 });
  });
  it('__proto__ 这类码不污染原型(Map 聚合)', () => {
    const out = aggregateByRef([{ ref: '__proto__', type: 'open', n: 1 }]);
    expect(out).toHaveLength(1);
    expect({}.open).toBeUndefined();
  });
  it('未知 type 不写入桶', () => {
    const out = aggregateByRef([{ ref: 'a1', type: 'weird', n: 9 }]);
    expect(out[0][1]).toEqual({ open: 0, copy: 0, copy_fallback: 0 });
  });
});
