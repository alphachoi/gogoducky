"""P1 必测:定价公式——分单位整数运算、四舍五入、null 拒入公式、配置 fail-loud。"""
import json

import pytest

import pricing


class TestParsePriceCents:
    def test_basic(self):
        assert pricing.parse_price_cents('$12.99') == 1299

    def test_thousands_separator(self):
        assert pricing.parse_price_cents('CAD $1,234.50') == 123450

    def test_no_decimals(self):
        assert pricing.parse_price_cents('$45') == 4500

    def test_one_decimal(self):
        assert pricing.parse_price_cents('$12.9') == 1290

    def test_sale_price_takes_last(self):
        # 划线原价 + 现价:取最后一个(现价在后)
        assert pricing.parse_price_cents('$19.99 $14.99') == 1499

    def test_garbage_returns_none(self):
        assert pricing.parse_price_cents('No Price') is None
        assert pricing.parse_price_cents('call for price') is None

    def test_currency_preferred_over_bare_numbers(self):
        # "$12.99 / 100g" 必须取 12.99,不是 100(裸数字陷阱)
        assert pricing.parse_price_cents('$12.99 / 100g') == 1299
        assert pricing.parse_price_cents('2 for $5') == 500

    def test_bare_number_only_when_unambiguous(self):
        # 无 $ 锚点:唯一一个数才敢当价格;多数字分不清哪个是钱 → None 打标
        assert pricing.parse_price_cents('CAD 1,234.50') == 123450
        assert pricing.parse_price_cents('CAD 12.99 / 100g') is None

    def test_three_decimals_rejected(self):
        # "$12.999" 不猜(取 99 或 999 都是错价),存 null 打标
        assert pricing.parse_price_cents('$12.999') is None

    def test_empty_and_none(self):
        assert pricing.parse_price_cents('') is None
        assert pricing.parse_price_cents(None) is None


class TestCnyReference:
    def test_formula(self):
        # 25.99 CAD × 5.2 × 1.15 + 10 = 165.42... → 165
        assert pricing.cny_reference_yuan(2599, 5.2, 0.15, 10) == 165

    def test_rounding_half_up(self):
        # 10 CAD × 5.0 × 1.0 + 0.5 = 50.5 → 51(四舍五入)
        assert pricing.cny_reference_yuan(1000, 5.0, 0.0, 0.5) == 51

    def test_null_price_rejected(self):
        # 解析失败的 null 不得进入公式
        with pytest.raises(ValueError):
            pricing.cny_reference_yuan(None, 5.2, 0.15, 10)


class TestMarginRate:
    def test_margin(self):
        # 售价 165,成本 25.99×5.2+10 = 145.148 → margin ≈ 12.0%
        m = pricing.margin_rate(165, 2599, 5.2, 10)
        assert 0.11 < float(m) < 0.13

    def test_zero_price(self):
        assert float(pricing.margin_rate(0, 1000, 5.0, 0)) == -1


class TestPricingConfig:
    def test_unfilled_config_fails_loud(self, tmp_path):
        cfg = tmp_path / 'pricing.json'
        cfg.write_text(json.dumps({
            'service_fee_rate': None, 'shipping_share_cny': 10, 'min_margin_rate': 0.1}))
        with pytest.raises(pricing.PricingConfigError, match='service_fee_rate'):
            pricing.load_pricing_config(cfg)

    def test_missing_file_fails_loud(self, tmp_path):
        with pytest.raises(pricing.PricingConfigError):
            pricing.load_pricing_config(tmp_path / 'nope.json')

    def test_filled_config_loads(self, tmp_path):
        cfg = tmp_path / 'pricing.json'
        cfg.write_text(json.dumps({
            'service_fee_rate': 0.15, 'shipping_share_cny': 10, 'min_margin_rate': 0.1}))
        assert pricing.load_pricing_config(cfg)['service_fee_rate'] == 0.15
