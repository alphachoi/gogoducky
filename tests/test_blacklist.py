"""P1 必测:药品黑名单入池拦截——中文/英文/变体拼写;合规红线的机械验证。"""
import blacklist


class TestBlacklistCheck:
    def test_chinese_generic(self):
        assert blacklist.check('小儿感冒颗粒') is not None
        assert blacklist.check('儿童退烧贴') is not None
        assert blacklist.check('止咳糖浆') is not None

    def test_chinese_brand(self):
        assert blacklist.check('泰诺林儿童装') is not None
        assert blacklist.check('美林布洛芬混悬液') is not None
        assert blacklist.check('连花清瘟胶囊') is not None

    def test_english(self):
        assert blacklist.check("Children's Tylenol 24ct") is not None
        assert blacklist.check('Advil Liqui-Gels') is not None
        assert blacklist.check('Kirkland Ibuprofen 400mg') is not None

    def test_variant_spelling(self):
        # 归一化后命中:空格/横线/大小写变体
        assert blacklist.check('布 洛 芬 儿 童 装') is not None
        assert blacklist.check('IBU-PROFEN tablets') is not None
        assert blacklist.check('TYLENOL extra strength') is not None

    def test_traditional_chinese(self):
        assert blacklist.check('感冒靈顆粒') is not None
        assert blacklist.check('兒童退燒藥') is not None

    def test_canadian_otc_brands(self):
        assert blacklist.check('Voltaren Emulgel 100g') is not None
        assert blacklist.check('Polysporin 抗菌软膏') is not None
        assert blacklist.check('Pepto-Bismol 咀嚼片') is not None

    def test_medical_devices(self):
        # 红线含「非器械」,机械层同样要拦
        assert blacklist.check('婴儿电子体温计') is not None
        assert blacklist.check('Band-Aid 弹性创可贴') is not None
        assert blacklist.check('欧姆龙血压计') is not None

    def test_safe_products_pass(self):
        assert blacklist.check('Kirkland 坚果混合装 1.13kg') is None
        assert blacklist.check('Skechers 女士运动鞋') is None
        assert blacklist.check('Nature Valley 燕麦棒') is None
        assert blacklist.check('儿童保温杯') is None  # 儿童用品但非药品

    def test_empty(self):
        assert blacklist.check('') is None
        assert blacklist.check(None) is None
