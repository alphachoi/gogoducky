-- 归因事件表(D1)。open/copy/copy_fallback 三类事件,ref 为邀请码或 'direct'。
-- ip 列存的是「IP+UTC小时」的 SHA-256 哈希(仅供限频),原始 IP 永不落库。
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  type TEXT NOT NULL,
  issue INTEGER NOT NULL,
  ref TEXT NOT NULL,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_ip_ts ON events(ip, ts);
CREATE INDEX IF NOT EXISTS idx_events_ref ON events(ref, type, issue);
-- 后台报表按时间窗口查(ts 范围),没有这个索引就是全表扫
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
