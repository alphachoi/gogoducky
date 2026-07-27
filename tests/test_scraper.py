"""翻页循环纯逻辑测试(无浏览器):跨页去重、重复页即停(防死循环)、最大页数保险丝。

登录与 DOM 选择器依赖真实站点,属有意的集成缺口(不做镜像实现的假页面 mock)。
"""
import scraper as scraper_module
from scraper import HomarketScraper, MAX_PAGES_PER_CATEGORY


class FakePage:
    def __init__(self):
        self.url = None
        self.visited = []

    def get(self, url):
        self.url = url
        self.visited.append(url)


def make_scraper(pages, next_map, monkeypatch):
    """pages: url→本页商品列表;next_map: url→下一页 url(缺失视为最后一页)。"""
    monkeypatch.setattr(scraper_module, 'POLITE_DELAY_SECONDS', 0)
    s = object.__new__(HomarketScraper)  # 不触发 ChromiumPage 启动
    s.page = FakePage()
    s.get_products_on_page = lambda: pages[s.page.url]
    s._find_next_page_url = lambda: next_map.get(s.page.url)
    return s


def _p(link):
    return {'name': f'P {link}', 'price': '$1.00', 'link': link, 'image_url': ''}


class TestPagination:
    def test_dedup_and_stop_on_repeat_page(self, monkeypatch):
        # 第 3 页全是已见商品(翻到尾常出现重复内容)→ 即停,防死循环
        pages = {
            'c1': [_p('a'), _p('b')],
            'c2': [_p('b'), _p('c')],  # b 跨页重复,须去重
            'c3': [_p('a')],           # 全部已见
        }
        next_map = {'c1': 'c2', 'c2': 'c3', 'c3': 'c4'}
        s = make_scraper(pages, next_map, monkeypatch)
        products, page_count = s.get_products('c1')
        assert [p['link'] for p in products] == ['a', 'b', 'c']
        assert page_count == 3
        assert 'c4' not in s.page.visited  # 有下一页链接也不再翻

    def test_single_page_category(self, monkeypatch):
        # 单页分类:无下一页链接,抓完即止
        pages = {'c1': [_p('a'), _p('b')]}
        s = make_scraper(pages, {}, monkeypatch)
        products, page_count = s.get_products('c1')
        assert [p['link'] for p in products] == ['a', 'b']
        assert page_count == 1

    def test_empty_category(self, monkeypatch):
        # 空分类:零商品不炸,不翻页
        pages = {'c1': []}
        s = make_scraper(pages, {'c1': 'c2'}, monkeypatch)
        products, page_count = s.get_products('c1')
        assert products == []
        assert page_count == 1
        assert 'c2' not in s.page.visited  # 空页即停,不追下一页

    def test_max_pages_fuse(self, monkeypatch):
        # 每页都有新商品且永远有下一页 → 保险丝在 MAX_PAGES_PER_CATEGORY 处熔断
        n = MAX_PAGES_PER_CATEGORY + 10
        pages = {f'c{i}': [_p(f'item{i}')] for i in range(1, n)}
        next_map = {f'c{i}': f'c{i + 1}' for i in range(1, n)}
        s = make_scraper(pages, next_map, monkeypatch)
        products, page_count = s.get_products('c1')
        assert page_count == MAX_PAGES_PER_CATEGORY
        assert len(products) == MAX_PAGES_PER_CATEGORY
