"""一键入刊工具:选品池 → 本期数据文件草稿 + 自托管图片 + 发布检查单。

用法:
  python publish.py list                              # 查看可入刊集合
  python publish.py draft --issue 1 --ids 3,7,12 --fx 5.20 [--lock-days 7]
  python publish.py check --issue 1                   # 发布检查单(合规逐品勾选)

流程约定(eng-review / 外部声音裁决):
- 定价:人民币参考价 = 加币价 × 当日汇率(--fx) × (1+服务费率) + 运费分摊;
  毛利率低于 pricing.json 阈值即标红拒入刊(T5 毛利兜底)。
- 图片:仅入刊商品下载,转 webp、限宽 800px、压至 ≤100KB,入仓自托管,
  不热链 homarket 图源(问题2裁决)。
- 合规终审(T6):黑名单只是粗筛;check 命令对每个商品强制勾选
  「非药品/非器械/无疗效宣称」,勾不全阻断发布(published 保持 false,
  站点构建不包含未发布期)。
"""
import argparse
import io
import json
import sys
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import blacklist
import database
import pricing

# 锁价日期按客户日历(中国)计算:温哥华周四晚 = 北京周五午,
# 用创始人本地日期会让全体客户少享最多 ~15 小时锁价。
CUSTOMER_TZ = ZoneInfo('Asia/Shanghai')

REPO_ROOT = Path(__file__).parent.parent
SITE_DIR = REPO_ROOT / 'site'
ISSUES_DIR = SITE_DIR / 'src' / 'data' / 'issues'
IMAGES_DIR = SITE_DIR / 'public' / 'images' / 'issues'

IMAGE_MAX_WIDTH = 800
IMAGE_MAX_BYTES = 100 * 1024
IMAGE_DOWNLOAD_MAX_BYTES = 10 * 1024 * 1024  # 源图下载上限,防炸弹图


class PublishError(Exception):
    pass


def issue_slug(n):
    return f'{int(n):03d}'


def issue_path(n):
    return ISSUES_DIR / f'issue-{issue_slug(n)}.json'


def cmd_list():
    products = database.eligible_products()
    if not products:
        print('可入刊集合为空(active + 非黑名单 + 价格解析成功)。先跑一轮抓取。')
        return
    print(f'可入刊商品 {len(products)} 条:')
    current_cat = None
    for p in products:
        if p['category_name'] != current_cat:
            current_cat = p['category_name']
            print(f'\n[{current_cat}]')
        cad = p['price_cents'] / 100
        flags = []
        if p['prev_price_cents'] is not None and p['prev_price_cents'] != p['price_cents']:
            flags.append(f"变价 {p['prev_price_cents']/100:.2f}→{cad:.2f}")
        print(f"  #{p['id']:<5} ${cad:>8.2f}  {p['name']}" + (f"  [{'; '.join(flags)}]" if flags else ''))


def compress_image(raw_bytes):
    """转 webp、限宽 800px、压至 ≤100KB。失败抛 PublishError。"""
    from PIL import Image
    img = Image.open(io.BytesIO(raw_bytes))
    if img.mode not in ('RGB', 'RGBA'):
        img = img.convert('RGB')
    if img.width > IMAGE_MAX_WIDTH:
        ratio = IMAGE_MAX_WIDTH / img.width
        img = img.resize((IMAGE_MAX_WIDTH, max(1, int(img.height * ratio))))
    for quality in (85, 75, 65, 50, 40, 30):
        buf = io.BytesIO()
        img.save(buf, format='WEBP', quality=quality)
        if buf.tell() <= IMAGE_MAX_BYTES:
            return buf.getvalue()
    raise PublishError(f'图片压缩后仍超 {IMAGE_MAX_BYTES // 1024}KB')


def download_image(url, dest_path):
    """下载并压缩商品图。返回 (width, height)。"""
    import requests
    from PIL import Image
    from urllib.parse import urlparse

    if urlparse(url).scheme not in ('http', 'https'):
        raise PublishError(f'图片 URL 协议不支持:{url}')
    Image.MAX_IMAGE_PIXELS = 50_000_000  # 防解压炸弹

    resp = requests.get(url, timeout=30, stream=True)
    resp.raise_for_status()
    raw = b''
    for chunk in resp.iter_content(chunk_size=64 * 1024):
        raw += chunk
        if len(raw) > IMAGE_DOWNLOAD_MAX_BYTES:
            raise PublishError(f'源图超过 {IMAGE_DOWNLOAD_MAX_BYTES // 1024 // 1024}MB,拒绝下载')

    compressed = compress_image(raw)
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    dest_path.write_bytes(compressed)
    with Image.open(io.BytesIO(compressed)) as img:
        return img.width, img.height


# 汇率合理性区间:加币→人民币十年区间约 4.5–5.8,留宽防真实波动。
# 打错一位(52 当 5.2)会生成 10 倍价并静默通过毛利检查——钱面上的静默损坏。
FX_SANE_RANGE = (3.0, 8.0)


def cmd_draft(issue_no, ids, fx_rate, lock_days, force=False, allow_unusual_fx=False):
    cfg = pricing.load_pricing_config()  # 数字未填即 fail-loud

    if not allow_unusual_fx and not (FX_SANE_RANGE[0] <= fx_rate <= FX_SANE_RANGE[1]):
        raise PublishError(
            f'汇率 {fx_rate} 超出合理区间 {FX_SANE_RANGE}(疑似打错位)。'
            '确认无误请加 --allow-unusual-fx。'
        )
    if lock_days < 1:
        raise PublishError(f'锁价天数必须 ≥1,当前 {lock_days}(0 天 = 出生即过期)。')
    if issue_no < 1:
        raise PublishError(f'期号必须 ≥1,当前 {issue_no}。')

    # 覆盖保护:重跑 draft 会毁掉手工编辑的 greeting/spec/note 并把已发布期拉回
    # published=false(在售期直接下线、期号从归因白名单消失)。必须显式 --force。
    existing_path = issue_path(issue_no)
    if existing_path.exists() and not force:
        raise PublishError(
            f'第{issue_no}期数据文件已存在:{existing_path}\n'
            '重新生成会覆盖手工编辑内容并重置发布状态。确认要重来请加 --force。'
        )

    products = database.get_products_by_ids(ids)
    found_ids = {p['id'] for p in products}
    missing = set(ids) - found_ids
    if missing:
        raise PublishError(f'商品 ID 不存在:{sorted(missing)}')

    # 入刊资格防线(黑名单/下架/价格缺失绝不入刊)
    rejected, items = [], []
    for p in products:
        if p['blacklisted']:
            rejected.append((p, f"黑名单拦截({p['blacklist_reason']})——P4 红线,拒入刊"))
            continue
        if p['status'] != 'active':
            rejected.append((p, '已下架,拒入刊'))
            continue
        if p['price_cents'] is None:
            rejected.append((p, '价格解析失败(null),拒入刊'))
            continue

        price_cny = pricing.cny_reference_yuan(
            p['price_cents'], fx_rate, cfg['service_fee_rate'], cfg['shipping_share_cny'])
        margin = pricing.margin_rate(
            price_cny, p['price_cents'], fx_rate, cfg['shipping_share_cny'])
        if margin < cfg['min_margin_rate']:
            rejected.append((p, f'毛利率 {float(margin):.1%} 低于阈值 '
                                f"{cfg['min_margin_rate']:.0%},标红拒入刊(毛利兜底)"))
            continue
        items.append((p, price_cny))

    if rejected:
        print('以下商品被拒入刊:')
        for p, reason in rejected:
            print(f"  ✗ #{p['id']} {p['name']}: {reason}")
    if not items:
        raise PublishError('无可入刊商品,草稿未生成。')

    slug = issue_slug(issue_no)
    published_at = datetime.now(CUSTOMER_TZ).date()
    issue_items = []
    for p, price_cny in items:
        image_rel = None
        image_dims = (None, None)
        if p['image_url']:
            dest = IMAGES_DIR / slug / f"p{p['id']}.webp"
            try:
                image_dims = download_image(p['image_url'], dest)
                image_rel = f'/images/issues/{slug}/p{p["id"]}.webp'
                print(f"  ✓ 图片 {dest.name}({dest.stat().st_size // 1024}KB,{image_dims[0]}x{image_dims[1]})")
            except Exception as e:
                print(f"  ! #{p['id']} 图片下载失败({e}),image 留空待补")
        issue_items.append({
            'id': f"p{p['id']}",
            'name': p['name'],
            'image': image_rel,
            'image_width': image_dims[0],
            'image_height': image_dims[1],
            'price_cny': price_cny,
            'price_cad_cents': p['price_cents'],
            'spec': '',
            'eta': '',
            'note': '',
            'deal': '',
            'compliance_confirmed': False,
        })

    issue_data = {
        'issue': int(issue_no),
        'title': f'第{int(issue_no)}期',
        'published_at': published_at.isoformat(),
        'lock_until': (published_at + timedelta(days=lock_days)).isoformat(),
        'fx_rate': fx_rate,
        'greeting': '',
        'published': False,
        'items': issue_items,
    }
    path = issue_path(issue_no)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(issue_data, ensure_ascii=False, indent=2) + '\n')
    print(f'\n草稿已生成:{path}')
    print(f'  {len(issue_items)} 个商品,锁价至 {issue_data["lock_until"]}')
    print('  下一步:补 greeting(卷首语)/spec/eta/note/deal(角标,如"本周特价")后'
          '运行 publish.py check 过发布检查单。')


def cmd_check(issue_no):
    path = issue_path(issue_no)
    if not path.exists():
        raise PublishError(f'期数据文件不存在:{path}')
    issue_data = json.loads(path.read_text())

    # 机械筛查先行:草稿后手填的自由文本(卷首语/规格/备注/角标)同样过黑名单,
    # 「退烧神器」这类疗效宣称不能靠人眼单扛。人工勾选仍是最后一道闸。
    violations = []
    for issue_field in ('greeting', 'title'):
        hit = blacklist.check(issue_data.get(issue_field) or '')
        if hit:
            violations.append((issue_field, issue_data[issue_field], hit))
    for item in issue_data['items']:
        for field in ('name', 'spec', 'eta', 'note', 'deal'):
            hit = blacklist.check(item.get(field) or '')
            if hit:
                violations.append((f'「{item["name"]}」的 {field}', item.get(field), hit))
    if violations:
        print('✗ 黑名单筛查未过,发布阻断。命中如下:')
        for where, text, keyword in violations:
            print(f'  - {where}: {text!r} 命中关键词「{keyword}」')
        issue_data['published'] = False
        path.write_text(json.dumps(issue_data, ensure_ascii=False, indent=2) + '\n')
        sys.exit(1)

    print(f'=== 第{issue_data["issue"]}期 发布检查单 ===')
    print('对每个商品确认:非药品 / 非医疗器械 / 无疗效宣称。')
    print('任何一项不确定,输入 n——勾不全阻断发布。\n')

    all_confirmed = True
    for item in issue_data['items']:
        answer = input(f'  「{item["name"]}」 非药品/非器械/无疗效宣称?[y/n] ').strip().lower()
        item['compliance_confirmed'] = answer == 'y'
        if answer != 'y':
            all_confirmed = False
            print('    → 未确认。该期不得发布,请先移除该商品或人工核实。')

    issue_data['published'] = all_confirmed
    path.write_text(json.dumps(issue_data, ensure_ascii=False, indent=2) + '\n')

    if all_confirmed:
        print(f'\n✓ 检查单全过,published=true。git push 后站点将包含第{issue_data["issue"]}期。')
    else:
        print(f'\n✗ 检查单未过,published=false——站点构建不会包含本期。')
        sys.exit(1)


def main(argv=None):
    parser = argparse.ArgumentParser(description='gogoducky 一键入刊工具')
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('list')
    draft = sub.add_parser('draft')
    draft.add_argument('--issue', type=int, required=True)
    draft.add_argument('--ids', required=True, help='逗号分隔的商品 ID,如 3,7,12')
    draft.add_argument('--fx', type=float, required=True, help='当日加币→人民币汇率')
    draft.add_argument('--lock-days', type=int, default=7)
    draft.add_argument('--force', action='store_true', help='覆盖已存在的期数据文件')
    draft.add_argument('--allow-unusual-fx', action='store_true',
                       help='允许合理区间外的汇率(确认不是打错位)')
    check = sub.add_parser('check')
    check.add_argument('--issue', type=int, required=True)

    args = parser.parse_args(argv)
    try:
        if args.command == 'list':
            cmd_list()
        elif args.command == 'draft':
            ids = [int(x) for x in args.ids.split(',') if x.strip()]
            cmd_draft(args.issue, ids, args.fx, args.lock_days,
                      force=args.force, allow_unusual_fx=args.allow_unusual_fx)
        elif args.command == 'check':
            cmd_check(args.issue)
    except (PublishError, pricing.PricingConfigError) as e:
        print(f'错误:{e}')
        sys.exit(1)


if __name__ == '__main__':
    main()
