"""价格解析与定价公式。

- 抓取价一律解析为加币分单位整数("$12.99" → 1299);解析失败返回 None,
  由调用方存 null 并打标,废除 "No Price" 哨兵字符串。
- 人民币参考价 = 加币价 × 汇率 × (1 + 服务费率) + 运费分摊,整数元,四舍五入。
- 毛利兜底:低于阈值即拒入刊(锁价一周未锁成本)。
"""
import json
import re
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

PRICING_CONFIG_PATH = Path(__file__).parent / 'pricing.json'

# 优先取带 $ 前缀的金额,防止 "$12.99 / 100g" 取到 100;
# 尾部 (?![\d.]) 拒绝 "$12.999" 这类三位小数(存 null 打标,不猜)。
_CURRENCY_RE = re.compile(r'\$\s*(\d[\d,]*)(?:\.(\d{1,2}))?(?![\d.])')
_PRICE_RE = re.compile(r'(?<![\d.])(\d[\d,]*)(?:\.(\d{1,2}))?(?![\d.])')


class PricingConfigError(Exception):
    pass


def parse_price_cents(text):
    """"$12.99" → 1299;"CAD 1,234.5" → 123450;乱文本/三位小数 → None。

    页面偶见 "$19.99 $14.99"(划线原价+现价)时取最后一个金额(现价在后);
    带 $ 的金额优先于裸数字("$12.99 / 100g" 取 12.99 而非 100)。
    """
    if not text:
        return None
    s = str(text)
    matches = _CURRENCY_RE.findall(s)
    if not matches:
        # 无 $ 锚点的裸数字:只有唯一一个数才敢当价格用;
        # "CAD 12.99 / 100g" 这类多数字文本分不清哪个是钱 → None 打标
        matches = _PRICE_RE.findall(s)
        if len(matches) != 1:
            return None
    if not matches:
        return None
    whole, frac = matches[-1]
    whole = whole.replace(',', '')
    frac = (frac or '').ljust(2, '0')
    try:
        return int(whole) * 100 + int(frac)
    except ValueError:
        return None


def load_pricing_config(path=None):
    """读取定价配置;数字未填(null)时 fail-loud。"""
    config_path = Path(path) if path else PRICING_CONFIG_PATH
    if not config_path.exists():
        raise PricingConfigError(f'定价配置不存在:{config_path}')
    config = json.loads(config_path.read_text())
    required = ['service_fee_rate', 'shipping_share_cny', 'min_margin_rate']
    missing = [k for k in required if config.get(k) is None]
    if missing:
        raise PricingConfigError(
            f'定价配置未填数字:{", ".join(missing)}(见 {config_path})。'
            '这三个数字必须由创始人填,不能用默认值。'
        )
    return config


def cny_reference_yuan(price_cad_cents, fx_rate, service_fee_rate, shipping_share_cny):
    """人民币参考价(整数元,四舍五入)。price_cad_cents 为 None 时拒算。"""
    if price_cad_cents is None:
        raise ValueError('价格缺失(解析失败的 null 不得进入定价公式)')
    cad = Decimal(price_cad_cents) / 100
    cny = cad * Decimal(str(fx_rate)) * (1 + Decimal(str(service_fee_rate))) \
        + Decimal(str(shipping_share_cny))
    return int(cny.quantize(Decimal('1'), rounding=ROUND_HALF_UP))


def margin_rate(price_cny_yuan, price_cad_cents, fx_rate, shipping_share_cny):
    """毛利率 = (售价 - 成本) / 售价;成本 = 加币价×汇率 + 运费分摊。"""
    cost = Decimal(price_cad_cents) / 100 * Decimal(str(fx_rate)) \
        + Decimal(str(shipping_share_cny))
    price = Decimal(price_cny_yuan)
    if price <= 0:
        return Decimal('-1')
    return (price - cost) / price
