// 锁价日期判断:期内 / 过期 / 超14天(P1 站点必测)
import { describe, expect, it } from 'vitest';
import { formatCnDate, isExpired, isStale } from '../src/lib/dates.js';

describe('formatCnDate', () => {
  it('ISO 日期转中文', () => {
    expect(formatCnDate('2026-08-01')).toBe('8月1日');
    expect(formatCnDate('2026-12-15')).toBe('12月15日');
  });
});

describe('isExpired(锁价截止判断)', () => {
  it('截止日当天仍有效', () => {
    expect(isExpired('2026-08-01', new Date('2026-08-01T20:00:00'))).toBe(false);
  });
  it('截止日次日起过期', () => {
    expect(isExpired('2026-08-01', new Date('2026-08-02T00:00:01'))).toBe(true);
  });
  it('期内不过期', () => {
    expect(isExpired('2026-08-01', new Date('2026-07-28T10:00:00'))).toBe(false);
  });
  it('非法日期 fail-closed:按已过期处理(价格守卫不能坏日期就永远有效)', () => {
    expect(isExpired('not-a-date', new Date('2026-07-28T10:00:00'))).toBe(true);
    expect(isExpired(undefined, new Date('2026-07-28T10:00:00'))).toBe(true);
  });
});

describe('isStale(超14天提示条)', () => {
  it('14 天内不提示', () => {
    expect(isStale('2026-07-01', new Date('2026-07-14T12:00:00'))).toBe(false);
  });
  it('超过 14 天提示', () => {
    expect(isStale('2026-07-01', new Date('2026-07-16T00:00:01'))).toBe(true);
  });
});
