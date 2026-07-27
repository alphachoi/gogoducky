from DrissionPage import ChromiumPage
import time

POLITE_DELAY_SECONDS = 2   # 每页间隔,礼貌节奏不变
MAX_PAGES_PER_CATEGORY = 50  # 防翻页死循环的保险丝


class ScrapeError(Exception):
    pass


class HomarketScraper:
    def __init__(self):
        self.page = ChromiumPage()

    def login(self, username, password):
        """登录 homarket.ca;失败抛 ScrapeError(登录失败的批次不得参与下架判定)。"""
        login_url = 'https://homarket.ca/login/'
        print(f"Navigating to {login_url}...")
        self.page.get(login_url)

        if self.page.ele('#loginword', timeout=5):
            print("Login field found. Entering credentials...")
            self.page.ele('#loginword').input(username)
            self.page.ele('#password').input(password)
            self.page.ele('#submit_btn').click()
            time.sleep(3)

        time.sleep(3)
        print(f"Current URL: {self.page.url}")
        if 'login' in self.page.url and self.page.ele('#loginword', timeout=2):
            raise ScrapeError('登录失败:仍停留在登录页')

    def get_categories(self):
        """抓侧栏分类列表,返回 [{'name', 'url'}]。"""
        print("Scraping categories...")
        categories = []
        category_links = self.page.eles('.side-menu a[href*="/category/"]')
        if not category_links:
            category_links = self.page.eles('css:a[href*="/category/"]')

        seen = set()
        for link in category_links:
            cat_name = link.text
            cat_url = link.attr('href')
            if cat_name and cat_url and cat_url not in seen:
                seen.add(cat_url)
                categories.append({'name': cat_name.strip(), 'url': cat_url})

        print(f"Found {len(categories)} categories.")
        return categories

    def get_products_on_page(self):
        """抓当前页商品。price 保留原始文本,分单位解析在入池层做。"""
        products_data = []
        product_elements = self.page.eles('.product')
        if not product_elements:
            time.sleep(2)
            product_elements = self.page.eles('.product')

        for p in product_elements:
            # 商品格已加载完毕,存在性探测用 timeout=0——选择器失配时
            # 每个元素的等待会在整页乘法放大(50 商品 × 多个 1s+ 探测)
            name_ele = p.ele('css:h3.name a', timeout=0)
            if not name_ele:
                h3 = p.ele('tag:h3', timeout=0)
                name_ele = h3.ele('tag:a', timeout=0) if h3 else None
            if not name_ele:
                continue

            price_ele = p.ele('.price', timeout=0) or p.ele('.product-price', timeout=0)
            img_ele = p.ele('.image img', timeout=0)

            name = (name_ele.text or '').strip()
            link = name_ele.attr('href') or ''
            if not name or not link:
                continue  # 广告卡/占位卡:无名或无链接,不入池
            products_data.append({
                'name': name,
                'price': price_ele.text if price_ele else None,
                'link': link,
                'image_url': img_ele.attr('src') if img_ele else '',
            })
        return products_data

    def _find_next_page_url(self):
        """找下一页链接;找不到返回 None(视为最后一页)。"""
        for selector in ('css:a[rel="next"]',
                         'css:.pagination a.next',
                         'css:.pagination .next a',
                         'css:li.next a'):
            ele = self.page.ele(selector, timeout=1)
            if ele:
                href = ele.attr('href')
                if href and href != self.page.url:
                    return href
        # 文本兜底:'下一页' / 'Next' / '»'
        for text in ('下一页', 'Next', '»'):
            ele = self.page.ele(f'css:.pagination a@@text():{text}', timeout=1) \
                or self.page.ele(f'a@@text():{text}', timeout=1)
            if ele:
                href = ele.attr('href')
                if href and href != self.page.url:
                    return href
        return None

    def get_products(self, category_url):
        """分页抓全一个分类:翻页到尾,返回 (products, page_count)。"""
        self.page.get(category_url)
        time.sleep(POLITE_DELAY_SECONDS)

        all_products = []
        seen_links = set()
        page_count = 0

        while page_count < MAX_PAGES_PER_CATEGORY:
            page_count += 1
            batch = self.get_products_on_page()
            new_items = [p for p in batch if p['link'] not in seen_links]
            for p in new_items:
                seen_links.add(p['link'])
            all_products.extend(new_items)
            print(f"  page {page_count}: {len(new_items)} products")

            next_url = self._find_next_page_url()
            if not next_url or not new_items or page_count >= MAX_PAGES_PER_CATEGORY:
                break
            self.page.get(next_url)
            time.sleep(POLITE_DELAY_SECONDS)

        return all_products, page_count

    def close(self):
        self.page.quit()
