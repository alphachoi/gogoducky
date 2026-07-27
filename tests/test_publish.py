"""入刊工具测试:草稿生成、图片 webp≤100KB 断言、毛利兜底、黑名单拒入刊、检查单阻断。"""
import io
import json

import pytest

import database
import publish
import pricing


@pytest.fixture
def db(tmp_path, monkeypatch):
    path = str(tmp_path / 'test.db')
    database.init_db(path)
    monkeypatch.setattr(database, 'DB_NAME', path)
    return path


@pytest.fixture
def site(tmp_path, monkeypatch):
    site_dir = tmp_path / 'site'
    monkeypatch.setattr(publish, 'SITE_DIR', site_dir)
    monkeypatch.setattr(publish, 'ISSUES_DIR', site_dir / 'src' / 'data' / 'issues')
    monkeypatch.setattr(publish, 'IMAGES_DIR', site_dir / 'public' / 'images' / 'issues')
    return site_dir


@pytest.fixture
def pricing_cfg(tmp_path, monkeypatch):
    cfg = tmp_path / 'pricing.json'
    cfg.write_text(json.dumps({
        'service_fee_rate': 0.15, 'shipping_share_cny': 10, 'min_margin_rate': 0.05}))
    monkeypatch.setattr(pricing, 'PRICING_CONFIG_PATH', cfg)
    return cfg


def _seed_product(db, name='好货A', price='$25.99', link='https://x.ca/p/1', image=''):
    import sqlite3
    run = database.start_run(db)
    cat = database.save_category('c', 'https://x.ca/c/1', db)
    database.save_product(run, cat, {'name': name, 'price': price, 'link': link, 'image_url': image}, db)
    database.finish_run(run, 'complete', db_path=db)
    conn = sqlite3.connect(db)
    pid = conn.execute('SELECT id FROM products WHERE link = ?', (link,)).fetchone()[0]
    conn.close()
    return pid


class TestCompressImage:
    def _make_png(self, width=1600, height=1200):
        from PIL import Image
        img = Image.new('RGB', (width, height), (200, 30, 30))
        buf = io.BytesIO()
        img.save(buf, format='PNG')
        return buf.getvalue()

    def test_webp_under_100kb_max_width_800(self):
        from PIL import Image
        out = publish.compress_image(self._make_png())
        assert len(out) <= publish.IMAGE_MAX_BYTES
        img = Image.open(io.BytesIO(out))
        assert img.format == 'WEBP'
        assert img.width <= publish.IMAGE_MAX_WIDTH

    def test_incompressible_image_fails_loud(self, monkeypatch):
        # 质量梯度打完仍超限 → PublishError(不静默塞超限图入仓)
        monkeypatch.setattr(publish, 'IMAGE_MAX_BYTES', 100)  # 100 字节,必然超
        with pytest.raises(publish.PublishError, match='压缩后仍超'):
            publish.compress_image(self._make_png())


class TestDraft:
    def test_draft_generated(self, db, site, pricing_cfg):
        pid = _seed_product(db)
        publish.cmd_draft(1, [pid], fx_rate=5.2, lock_days=7)
        path = publish.issue_path(1)
        assert path.exists()
        data = json.loads(path.read_text())
        assert data['published'] is False
        assert len(data['items']) == 1
        item = data['items'][0]
        # 25.99 × 5.2 × 1.15 + 10 = 165.42 → 165
        assert item['price_cny'] == 165
        assert item['compliance_confirmed'] is False
        assert data['lock_until'] > data['published_at']

    def test_blacklisted_rejected(self, db, site, pricing_cfg):
        pid = _seed_product(db, name="Children's Tylenol", link='https://x.ca/p/rx')
        with pytest.raises(publish.PublishError, match='无可入刊'):
            publish.cmd_draft(1, [pid], fx_rate=5.2, lock_days=7)
        assert not publish.issue_path(1).exists()

    def test_low_margin_rejected(self, db, site, pricing_cfg, monkeypatch):
        # 阈值拉高到 90%,正常商品必被毛利兜底拦下
        cfg = json.loads(pricing_cfg.read_text())
        cfg['min_margin_rate'] = 0.9
        pricing_cfg.write_text(json.dumps(cfg))
        pid = _seed_product(db)
        with pytest.raises(publish.PublishError, match='无可入刊'):
            publish.cmd_draft(1, [pid], fx_rate=5.2, lock_days=7)

    def test_unknown_id_rejected(self, db, site, pricing_cfg):
        _seed_product(db)
        with pytest.raises(publish.PublishError, match='不存在'):
            publish.cmd_draft(1, [1, 999], fx_rate=5.2, lock_days=7)
        assert not publish.issue_path(1).exists()

    def test_image_download_failure_degrades(self, db, site, pricing_cfg, monkeypatch):
        # 图片下载失败不阻断草稿:image 留空待补,商品照常入刊
        def boom(url, dest):
            raise RuntimeError('网络超时')
        monkeypatch.setattr(publish, 'download_image', boom)
        pid = _seed_product(db, image='https://x.ca/i/1.jpg')
        publish.cmd_draft(1, [pid], fx_rate=5.2, lock_days=7)
        data = json.loads(publish.issue_path(1).read_text())
        assert len(data['items']) == 1
        assert data['items'][0]['image'] is None

    def test_existing_draft_not_overwritten(self, db, site, pricing_cfg):
        # 重跑 draft 会毁掉手工编辑并把已发布期拉下线——必须显式 --force
        pid = _seed_product(db)
        publish.cmd_draft(1, [pid], fx_rate=5.2, lock_days=7)
        data = json.loads(publish.issue_path(1).read_text())
        data['greeting'] = '手工写的卷首语'
        publish.issue_path(1).write_text(json.dumps(data, ensure_ascii=False))

        with pytest.raises(publish.PublishError, match='已存在'):
            publish.cmd_draft(1, [pid], fx_rate=5.2, lock_days=7)
        # 手工内容原封未动
        assert json.loads(publish.issue_path(1).read_text())['greeting'] == '手工写的卷首语'
        # --force 才允许重来
        publish.cmd_draft(1, [pid], fx_rate=5.2, lock_days=7, force=True)
        assert json.loads(publish.issue_path(1).read_text())['greeting'] == ''

    def test_fx_typo_rejected(self, db, site, pricing_cfg):
        # --fx 52(5.2 打错位)= 10 倍价且毛利检查照样通过——必须拦
        pid = _seed_product(db)
        with pytest.raises(publish.PublishError, match='合理区间'):
            publish.cmd_draft(1, [pid], fx_rate=52, lock_days=7)
        with pytest.raises(publish.PublishError, match='锁价天数'):
            publish.cmd_draft(1, [pid], fx_rate=5.2, lock_days=0)

    def test_unfilled_pricing_config_blocks(self, db, site, tmp_path, monkeypatch):
        cfg = tmp_path / 'unfilled.json'
        cfg.write_text(json.dumps({
            'service_fee_rate': None, 'shipping_share_cny': None, 'min_margin_rate': None}))
        monkeypatch.setattr(pricing, 'PRICING_CONFIG_PATH', cfg)
        pid = _seed_product(db)
        with pytest.raises(pricing.PricingConfigError):
            publish.cmd_draft(1, [pid], fx_rate=5.2, lock_days=7)


class TestCheck:
    def _draft(self, db, site, pricing_cfg):
        pid = _seed_product(db)
        publish.cmd_draft(1, [pid], fx_rate=5.2, lock_days=7)

    def test_all_confirmed_publishes(self, db, site, pricing_cfg, monkeypatch):
        self._draft(db, site, pricing_cfg)
        monkeypatch.setattr('builtins.input', lambda _: 'y')
        publish.cmd_check(1)
        data = json.loads(publish.issue_path(1).read_text())
        assert data['published'] is True
        assert all(i['compliance_confirmed'] for i in data['items'])

    def test_any_unconfirmed_blocks(self, db, site, pricing_cfg, monkeypatch):
        # 勾不全阻断发布——最后一道闸是人,不是正则
        self._draft(db, site, pricing_cfg)
        monkeypatch.setattr('builtins.input', lambda _: 'n')
        with pytest.raises(SystemExit):
            publish.cmd_check(1)
        data = json.loads(publish.issue_path(1).read_text())
        assert data['published'] is False

    def test_freetext_violation_blocks_before_prompt(self, db, site, pricing_cfg, monkeypatch):
        # 草稿后手填的备注/角标同样过黑名单——「退烧神器」不能靠人眼单扛
        self._draft(db, site, pricing_cfg)
        data = json.loads(publish.issue_path(1).read_text())
        data['items'][0]['note'] = '宝宝退烧神器,一贴见效'
        publish.issue_path(1).write_text(json.dumps(data, ensure_ascii=False))

        def no_prompt(_):
            raise AssertionError('筛查未过时不应进入人工勾选')
        monkeypatch.setattr('builtins.input', no_prompt)
        with pytest.raises(SystemExit):
            publish.cmd_check(1)
        assert json.loads(publish.issue_path(1).read_text())['published'] is False

    def test_eta_freetext_also_screened(self, db, site, pricing_cfg, monkeypatch):
        # eta 也是手填自由文本,同样过黑名单
        self._draft(db, site, pricing_cfg)
        data = json.loads(publish.issue_path(1).read_text())
        data['items'][0]['eta'] = '退烧贴 3 天到手'
        publish.issue_path(1).write_text(json.dumps(data, ensure_ascii=False))
        monkeypatch.setattr('builtins.input', lambda _: 'y')
        with pytest.raises(SystemExit):
            publish.cmd_check(1)
