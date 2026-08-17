"""主流程编排测试:分类失败 → partial(不参与下架判定);写库失败 → failed + exit 1。"""
import sqlite3

import pytest

import database
import main as main_module


class FakeScraper:
    fail_categories = set()

    def __init__(self):
        pass

    def login(self, username, password):
        pass

    def get_categories(self):
        return [
            {'name': 'A', 'url': 'https://x.ca/c/a'},
            {'name': 'B', 'url': 'https://x.ca/c/b'},
        ]

    def get_products(self, url):
        if url in self.fail_categories:
            raise RuntimeError('category timeout')
        return ([{'name': f'P-{url[-1]}', 'price': '$1.00',
                  'link': f'https://x.ca/p/{url[-1]}', 'image_url': ''}], 1)

    def close(self):
        pass


@pytest.fixture
def env(tmp_path, monkeypatch):
    db_path = str(tmp_path / 'main.db')
    monkeypatch.setattr(database, 'DB_NAME', db_path)
    monkeypatch.setenv('HOMARKET_USERNAME', 'u')
    monkeypatch.setenv('HOMARKET_PASSWORD', 'p')
    monkeypatch.setattr(main_module, 'HomarketScraper', FakeScraper)
    FakeScraper.fail_categories = set()
    return db_path


def _run_row(db_path):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    row = conn.execute('SELECT * FROM scrape_runs ORDER BY id DESC LIMIT 1').fetchone()
    conn.close()
    return dict(row)


class TestMainOrchestration:
    def test_all_categories_ok_run_complete(self, env):
        main_module.main()
        assert _run_row(env)['status'] == 'complete'

    def test_category_failure_marks_partial_and_continues(self, env):
        # 单分类失败:记录错误、继续其余分类、批次标 partial(不推进下架判定)
        FakeScraper.fail_categories = {'https://x.ca/c/a'}
        main_module.main()
        row = _run_row(env)
        assert row['status'] == 'partial'
        conn = sqlite3.connect(env)
        saved = conn.execute('SELECT COUNT(*) FROM products').fetchone()[0]
        cat_results = conn.execute(
            'SELECT ok FROM run_categories ORDER BY category_id').fetchall()
        conn.close()
        assert saved == 1                       # B 分类照常入池
        assert [r[0] for r in cat_results] == [0, 1]

    def test_db_write_failure_aborts_run_failed(self, env, monkeypatch):
        # fail-loud:写库失败终止本轮,批次标 failed,进程退出码 1
        def boom(*args, **kwargs):
            raise database.DatabaseError('disk full')
        monkeypatch.setattr(database, 'save_product', boom)
        with pytest.raises(SystemExit) as exc:
            main_module.main()
        assert exc.value.code == 1
        assert _run_row(env)['status'] == 'failed'
