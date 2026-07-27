"""药品关键词黑名单——入池层机械拦截(P4 红线第一道粗筛)。

被拦商品打标隔离(blacklisted=1),永不进入可入刊集合;
本地池仅保留隔离记录用于重复抓取时拦截,不外发、不构建进站点。
关键词判不准的命名由发布检查单的逐品人工勾选兜底(合规终审 T6)。

关键词唯一数据源:site/src/data/blacklist-keywords.json——
站点构建层(issues.js)用同一份清单对已发布内容重筛,两侧永不漂移。
"""
import json
import re
from pathlib import Path

KEYWORDS_PATH = (
    Path(__file__).parent.parent / 'site' / 'src' / 'data' / 'blacklist-keywords.json'
)

# 匹配前归一化(小写、去空格点横线),"布 洛 芬"、"Ibu-profen" 也会命中
_STRIP_RE = re.compile(r"[\s\.\-_·•'']+")

KEYWORDS = json.loads(KEYWORDS_PATH.read_text())['keywords']


def _normalize(text):
    return _STRIP_RE.sub('', (text or '').lower())


_NORMALIZED_KEYWORDS = [(_normalize(k), k) for k in KEYWORDS]


def check(name):
    """返回命中的原始关键词,未命中返回 None。"""
    normalized = _normalize(name)
    if not normalized:
        return None
    for norm_kw, original_kw in _NORMALIZED_KEYWORDS:
        if norm_kw in normalized:
            return original_kw
    return None
