"""管道测试:fail-loud 回归(哨兵字符串与吞异常不得复活)、批次模型、变价/下架检测。"""
import sqlite3

import pytest

import database


@pytest.fixture
def db(tmp_path):
    path = str(tmp_path / 'test.db')
    database.init_db(path)
    return path


def _product(name='Test Product', link='https://x.ca/p/1', price='$12.99', image='https://x.ca/i/1.jpg'):
    return {'name': name, 'link': link, 'price': price, 'image_url': image}


def _get(db, link):
    conn = sqlite3.connect(db)
    conn.row_factory = sqlite3.Row
    row = conn.execute('SELECT * FROM products WHERE link = ?', (link,)).fetchone()
    conn.close()
    return dict(row) if row else None


class TestFailLoud:
    def test_missing_name_raises_validation_error(self, db):
        # 验证失败与写库失败是两类:前者跳过单品继续,后者终止整轮
        run = database.start_run(db)
        cat = database.save_category('c', 'https://x.ca/c/1', db)
        with pytest.raises(database.ProductValidationError):
            database.save_product(run, cat, {'name': '', 'link': 'https://x.ca/p/1'}, db)

    def test_db_write_failure_raises(self, tmp_path):
        # 写失败必须包装成 DatabaseError(fail-loud 契约),不得漏出裸 sqlite3.Error
        path = str(tmp_path / 'readonly.db')
        database.init_db(path)
        (tmp_path / 'readonly.db').chmod(0o444)
        try:
            with pytest.raises(database.DatabaseError):
                database.start_run(path)
        finally:
            (tmp_path / 'readonly.db').chmod(0o644)

    def test_no_sentinel_price_string(self, db):
        # 哨兵字符串回归测试:乱文本价格必须存 NULL+打标,绝不是 "No Price"
        run = database.start_run(db)
        cat = database.save_category('c', 'https://x.ca/c/1', db)
        result = database.save_product(run, cat, _product(price='No Price'), db)
        assert result['price_parse_failed'] is True
        row = _get(db, 'https://x.ca/p/1')
        assert row['price_cents'] is None
        assert row['price_parse_failed'] == 1
        assert row['price_raw'] == 'No Price'

    def test_parse_failed_price_excluded_from_eligible(self, db):
        # 价格 null 的商品绝不进入可入刊集合(与黑名单同级的机械防线)
        run = database.start_run(db)
        cat = database.save_category('c', 'https://x.ca/c/1', db)
        database.save_product(run, cat, _product(price='call for price'), db)
        database.finish_run(run, 'complete', db_path=db)
        assert database.eligible_products(db) == []

    def test_old_demo_schema_detected(self, tmp_path):
        path = str(tmp_path / 'old.db')
        conn = sqlite3.connect(path)
        conn.execute('CREATE TABLE products (id INTEGER PRIMARY KEY, price TEXT)')
        conn.commit()
        conn.close()
        with pytest.raises(database.DatabaseError, match='旧版'):
            database.init_db(path)


class TestPriceCents:
    def test_price_stored_as_cents(self, db):
        run = database.start_run(db)
        cat = database.save_category('c', 'https://x.ca/c/1', db)
        database.save_product(run, cat, _product(price='$12.99'), db)
        assert _get(db, 'https://x.ca/p/1')['price_cents'] == 1299


class TestBlacklistAtEntry:
    def test_blacklisted_flagged_and_excluded(self, db):
        run = database.start_run(db)
        cat = database.save_category('c', 'https://x.ca/c/1', db)
        result = database.save_product(
            run, cat, _product(name="Children's Tylenol", link='https://x.ca/p/rx'), db)
        assert result['blacklisted'] is True
        row = _get(db, 'https://x.ca/p/rx')
        assert row['blacklisted'] == 1
        assert row['blacklist_reason'] == 'tylenol'
        # 被拦商品绝不出现在可入刊集合(P1 必测)
        assert all(p['link'] != 'https://x.ca/p/rx' for p in database.eligible_products(db))

    def test_safe_product_eligible(self, db):
        run = database.start_run(db)
        cat = database.save_category('c', 'https://x.ca/c/1', db)
        database.save_product(run, cat, _product(), db)
        database.finish_run(run, 'complete', db_path=db)
        assert len(database.eligible_products(db)) == 1

    def test_manual_blacklist_is_sticky(self, db):
        # 手工拉黑(关键词漏掉的商品,如「儿童馒欣」类命名)绝不因下次抓取而洗白
        run = database.start_run(db)
        cat = database.save_category('c', 'https://x.ca/c/1', db)
        database.save_product(run, cat, _product(name='儿童馒欣咀嚼片'), db)
        database.finish_run(run, 'complete', db_path=db)
        conn = sqlite3.connect(db)
        conn.execute("UPDATE products SET blacklisted = 1, blacklist_reason = 'manual' "
                     "WHERE link = 'https://x.ca/p/1'")
        conn.commit()
        conn.close()

        run2 = database.start_run(db)
        result = database.save_product(run2, cat, _product(name='儿童馒欣咀嚼片'), db)
        assert result['blacklisted'] is True
        row = _get(db, 'https://x.ca/p/1')
        assert row['blacklisted'] == 1
        assert row['blacklist_reason'] == 'manual'
        assert database.eligible_products(db) == []


class TestRunConcurrencyGuard:
    def test_second_running_run_rejected(self, db):
        # 并发批次会互相覆盖价格、拽回 last_seen_run → 同库只许一个 running
        database.start_run(db)
        with pytest.raises(database.DatabaseError, match='仍在运行'):
            database.start_run(db)

    def test_finished_run_releases_lock(self, db):
        run = database.start_run(db)
        database.finish_run(run, 'complete', db_path=db)
        assert database.start_run(db) > run


class TestPriceChangeDetection:
    def test_price_change_flagged(self, db):
        cat = database.save_category('c', 'https://x.ca/c/1', db)
        run1 = database.start_run(db)
        database.save_product(run1, cat, _product(price='$12.99'), db)
        database.finish_run(run1, 'complete', db_path=db)

        run2 = database.start_run(db)
        result = database.save_product(run2, cat, _product(price='$14.99'), db)
        assert result['price_changed'] is True
        row = _get(db, 'https://x.ca/p/1')
        assert row['price_cents'] == 1499
        assert row['prev_price_cents'] == 1299
        assert row['price_changed_at'] is not None

    def test_parse_failure_preserves_last_good_price(self, db):
        # 静默未登录抓取(游客页无价)不能让价格历史不可恢复:
        # 好价被 null 覆盖前存进 prev_price_cents
        cat = database.save_category('c', 'https://x.ca/c/1', db)
        run1 = database.start_run(db)
        database.save_product(run1, cat, _product(price='$12.99'), db)
        database.finish_run(run1, 'complete', db_path=db)
        run2 = database.start_run(db)
        database.save_product(run2, cat, _product(price='Login to see price'), db)
        row = _get(db, 'https://x.ca/p/1')
        assert row['price_cents'] is None
        assert row['price_parse_failed'] == 1
        assert row['prev_price_cents'] == 1299  # 最后已知好价可恢复

    def test_same_price_not_flagged(self, db):
        cat = database.save_category('c', 'https://x.ca/c/1', db)
        run1 = database.start_run(db)
        database.save_product(run1, cat, _product(), db)
        database.finish_run(run1, 'complete', db_path=db)
        run2 = database.start_run(db)
        result = database.save_product(run2, cat, _product(), db)
        assert result['price_changed'] is False


class TestDelisting:
    """外部声音 T4:仅完整批次参与下架对比,连续 2 轮完整缺席才标下架。"""

    def _seed(self, db):
        cat = database.save_category('c', 'https://x.ca/c/1', db)
        run = database.start_run(db)
        database.save_product(run, cat, _product(), db)
        database.finish_run(run, 'complete', db_path=db)
        return cat

    def _complete_empty_run(self, db):
        run = database.start_run(db)
        database.finish_run(run, 'complete', db_path=db)

    def test_one_missing_run_not_delisted(self, db):
        self._seed(db)
        self._complete_empty_run(db)
        assert _get(db, 'https://x.ca/p/1')['status'] == 'active'
        assert _get(db, 'https://x.ca/p/1')['missing_streak'] == 1

    def test_two_missing_complete_runs_delisted(self, db):
        self._seed(db)
        self._complete_empty_run(db)
        self._complete_empty_run(db)
        row = _get(db, 'https://x.ca/p/1')
        assert row['status'] == 'delisted'
        assert all(p['link'] != 'https://x.ca/p/1' for p in database.eligible_products(db))

    def test_partial_run_does_not_count(self, db):
        # 登录失败/分类超时 → partial/failed 批次不得推进下架判定(杜绝整池误判)
        self._seed(db)
        run = database.start_run(db)
        database.finish_run(run, 'partial', db_path=db)
        run = database.start_run(db)
        database.finish_run(run, 'failed', db_path=db)
        row = _get(db, 'https://x.ca/p/1')
        assert row['status'] == 'active'
        assert row['missing_streak'] == 0

    def test_reappearance_resets_streak(self, db):
        cat = self._seed(db)
        self._complete_empty_run(db)
        run = database.start_run(db)
        database.save_product(run, cat, _product(), db)
        database.finish_run(run, 'complete', db_path=db)
        row = _get(db, 'https://x.ca/p/1')
        assert row['missing_streak'] == 0
        assert row['status'] == 'active'
