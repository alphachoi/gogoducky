"""选品池数据库(SQLite)。

产线级约定(eng-review 裁决):
- 写库 fail-loud:任何写失败抛 DatabaseError,由 main 终止本轮抓取并汇总报错,
  绝不静默丢数据。
- 价格为分单位整数(price_cents),解析失败存 NULL 并置 price_parse_failed=1。
- 抓取批次模型(scrape_runs + run_categories):仅完整批次参与变价/下架对比,
  连续 2 轮完整批次缺席才标下架。
- 药品黑名单在入池层拦截:命中商品 blacklisted=1 隔离,永不进入可入刊集合。
"""
import sqlite3
from pathlib import Path

import blacklist
import pricing

DB_NAME = str(Path(__file__).parent / 'homarket.db')

DELIST_MISSING_RUNS = 2  # 连续 N 轮完整批次缺席才标下架


class DatabaseError(Exception):
    pass


class ProductValidationError(Exception):
    """单个商品数据不合格(缺 name/link 等)。与写库失败不同:
    调用方应跳过该商品继续本轮,而不是终止整轮抓取。"""


def _connect(db_path=None):
    conn = sqlite3.connect(db_path or DB_NAME)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA foreign_keys = ON')
    return conn


def init_db(db_path=None):
    conn = _connect(db_path)
    try:
        # 旧 demo 库(price TEXT 哨兵字符串时代)与新 schema 不兼容,fail-loud 提示归档
        row = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='products'"
        ).fetchone()
        if row is not None:
            cols = {r['name'] for r in conn.execute('PRAGMA table_info(products)')}
            if 'price_cents' not in cols:
                raise DatabaseError(
                    '检测到旧版 demo 数据库 schema(price 为文本)。'
                    '请先归档:mv homarket.db homarket.db.demo-bak,再重新抓取。'
                )
        conn.executescript('''
            CREATE TABLE IF NOT EXISTS categories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                url TEXT UNIQUE NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS products (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                category_id INTEGER REFERENCES categories(id),
                name TEXT NOT NULL,
                price_cents INTEGER,
                price_raw TEXT,
                price_parse_failed INTEGER NOT NULL DEFAULT 0,
                prev_price_cents INTEGER,
                price_changed_at TIMESTAMP,
                link TEXT UNIQUE NOT NULL,
                image_url TEXT,
                status TEXT NOT NULL DEFAULT 'active',
                missing_streak INTEGER NOT NULL DEFAULT 0,
                blacklisted INTEGER NOT NULL DEFAULT 0,
                blacklist_reason TEXT,
                first_seen_run INTEGER,
                last_seen_run INTEGER,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS scrape_runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                finished_at TIMESTAMP,
                status TEXT NOT NULL DEFAULT 'running',
                notes TEXT
            );

            CREATE TABLE IF NOT EXISTS run_categories (
                run_id INTEGER NOT NULL REFERENCES scrape_runs(id),
                category_id INTEGER NOT NULL REFERENCES categories(id),
                ok INTEGER NOT NULL DEFAULT 0,
                product_count INTEGER NOT NULL DEFAULT 0,
                error TEXT,
                PRIMARY KEY (run_id, category_id)
            );
        ''')
        conn.commit()
    finally:
        conn.close()


def start_run(db_path=None):
    """开一个批次。同库同时只允许一个 running 批次(并发批次会互相
    覆盖价格、把 last_seen_run 往回拽,导致误判下架);超过 6 小时的
    running 批次视为崩溃残留,自动标 failed 后放行。"""
    conn = _connect(db_path)
    try:
        stale = conn.execute('''
            SELECT id FROM scrape_runs WHERE status = 'running'
              AND started_at < datetime('now', '-6 hours')
        ''').fetchall()
        for row in stale:
            conn.execute(
                "UPDATE scrape_runs SET status = 'failed', "
                "notes = 'stale running run, auto-failed' WHERE id = ?", (row['id'],))
        running = conn.execute(
            "SELECT id FROM scrape_runs WHERE status = 'running'").fetchone()
        if running is not None:
            raise DatabaseError(
                f'批次 #{running["id"]} 仍在运行(同库不允许并发抓取)。'
                '若确认它已死,手工将其标为 failed 后重试。'
            )
        cursor = conn.execute('INSERT INTO scrape_runs (status) VALUES (?)', ('running',))
        conn.commit()
        return cursor.lastrowid
    except DatabaseError:
        raise
    except sqlite3.Error as e:
        raise DatabaseError(f'创建抓取批次失败:{e}') from e
    finally:
        conn.close()


def save_category(name, url, db_path=None):
    conn = _connect(db_path)
    try:
        conn.execute('INSERT OR IGNORE INTO categories (name, url) VALUES (?, ?)', (name, url))
        conn.commit()
        row = conn.execute('SELECT id FROM categories WHERE url = ?', (url,)).fetchone()
        if row is None:
            raise DatabaseError(f'分类写入后查询不到:{url}')
        return row['id']
    except sqlite3.Error as e:
        raise DatabaseError(f'保存分类 {name!r} 失败:{e}') from e
    finally:
        conn.close()


def save_product(run_id, category_id, product_data, db_path=None):
    """入池 upsert。fail-loud:写失败抛 DatabaseError,绝不吞异常。

    product_data: dict with 'name', 'price'(原始文本), 'link', 'image_url'
    返回 dict:{'blacklisted': bool, 'price_parse_failed': bool, 'price_changed': bool}
    """
    name = product_data.get('name')
    link = product_data.get('link')
    if not name or not link:
        # 验证失败 ≠ 写库失败:一张广告卡不该杀掉整轮抓取
        raise ProductValidationError(f'商品缺 name/link,拒绝入池:{product_data!r}')

    price_raw = product_data.get('price')
    price_cents = pricing.parse_price_cents(price_raw)
    parse_failed = price_cents is None

    hit = blacklist.check(name)

    conn = _connect(db_path)
    try:
        existing = conn.execute(
            'SELECT id, price_cents, blacklisted, blacklist_reason FROM products WHERE link = ?',
            (link,)
        ).fetchone()

        # 黑名单只置不清(sticky):手工拉黑的商品绝不因下次抓取关键词未命中而洗白,
        # 且保留最初隔离原因。红线是单向闸门——解除隔离必须人工改库,不给自动路径。
        if existing is not None and existing['blacklisted']:
            hit = existing['blacklist_reason'] or hit or 'manual'

        price_changed = (
            existing is not None
            and existing['price_cents'] is not None
            and price_cents is not None
            and existing['price_cents'] != price_cents
        )
        # 解析失败覆盖好价前,把最后已知好价存进 prev_price_cents——
        # 一次静默的未登录抓取(游客页无价格)不能让全池价格历史不可恢复
        preserve_prev = (
            existing is not None
            and existing['price_cents'] is not None
            and price_cents is None
        )

        if existing is None:
            conn.execute('''
                INSERT INTO products (
                    category_id, name, price_cents, price_raw, price_parse_failed,
                    link, image_url, status, missing_streak,
                    blacklisted, blacklist_reason, first_seen_run, last_seen_run
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?, ?, ?)
            ''', (category_id, name, price_cents, price_raw, int(parse_failed),
                  link, product_data.get('image_url'), int(hit is not None), hit,
                  run_id, run_id))
        else:
            conn.execute('''
                UPDATE products SET
                    category_id = ?, name = ?,
                    prev_price_cents = CASE WHEN ? THEN price_cents ELSE prev_price_cents END,
                    price_changed_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE price_changed_at END,
                    price_cents = ?, price_raw = ?, price_parse_failed = ?,
                    image_url = ?, status = 'active', missing_streak = 0,
                    blacklisted = ?, blacklist_reason = ?,
                    last_seen_run = ?, updated_at = CURRENT_TIMESTAMP
                WHERE link = ?
            ''', (category_id, name,
                  int(price_changed or preserve_prev), int(price_changed),
                  price_cents, price_raw, int(parse_failed),
                  product_data.get('image_url'), int(hit is not None), hit,
                  run_id, link))
        conn.commit()
        return {
            'blacklisted': hit is not None,
            'price_parse_failed': parse_failed,
            'price_changed': price_changed,
        }
    except sqlite3.Error as e:
        raise DatabaseError(f'保存商品 {name!r} 失败:{e}') from e
    finally:
        conn.close()


def record_category_result(run_id, category_id, ok, product_count=0, error=None, db_path=None):
    conn = _connect(db_path)
    try:
        conn.execute('''
            INSERT OR REPLACE INTO run_categories (run_id, category_id, ok, product_count, error)
            VALUES (?, ?, ?, ?, ?)
        ''', (run_id, category_id, int(ok), product_count, error))
        conn.commit()
    except sqlite3.Error as e:
        raise DatabaseError(f'记录分类结果失败:{e}') from e
    finally:
        conn.close()


def finish_run(run_id, status, notes=None, db_path=None):
    """收尾批次。仅 status='complete' 的批次参与下架判定:

    本轮未见的 active 商品 missing_streak += 1;
    连续 DELIST_MISSING_RUNS 轮完整批次缺席 → status='delisted'。
    部分批次(partial/failed)不动任何商品状态,杜绝登录失败/分类超时导致的整池误判。
    """
    conn = _connect(db_path)
    try:
        conn.execute(
            "UPDATE scrape_runs SET status = ?, finished_at = CURRENT_TIMESTAMP, notes = ? WHERE id = ?",
            (status, notes, run_id))
        if status == 'complete':
            conn.execute('''
                UPDATE products SET missing_streak = missing_streak + 1,
                                    updated_at = CURRENT_TIMESTAMP
                WHERE status = 'active' AND (last_seen_run IS NULL OR last_seen_run < ?)
            ''', (run_id,))
            conn.execute('''
                UPDATE products SET status = 'delisted', updated_at = CURRENT_TIMESTAMP
                WHERE status = 'active' AND missing_streak >= ?
            ''', (DELIST_MISSING_RUNS,))
        conn.commit()
    except sqlite3.Error as e:
        raise DatabaseError(f'收尾批次 {run_id} 失败:{e}') from e
    finally:
        conn.close()


def eligible_products(db_path=None):
    """可入刊集合:active、非黑名单、价格解析成功。药品红线的机械验证入口。"""
    conn = _connect(db_path)
    try:
        rows = conn.execute('''
            SELECT p.*, c.name AS category_name FROM products p
            LEFT JOIN categories c ON c.id = p.category_id
            WHERE p.status = 'active' AND p.blacklisted = 0 AND p.price_cents IS NOT NULL
            ORDER BY p.category_id, p.name
        ''').fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def get_products_by_ids(ids, db_path=None):
    ids = list(dict.fromkeys(ids))  # 去重保序
    if not ids:
        return []
    conn = _connect(db_path)
    try:
        placeholders = ','.join('?' * len(ids))
        rows = conn.execute(
            f'SELECT * FROM products WHERE id IN ({placeholders})', ids
        ).fetchall()
        return [dict(r) for r in rows]
    except sqlite3.Error as e:
        raise DatabaseError(f'按 ID 查询商品失败:{e}') from e
    finally:
        conn.close()
