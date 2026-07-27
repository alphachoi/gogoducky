"""每周抓取入口:批次模型 + fail-loud。

- 每轮抓取记一个 scrape_runs 批次(每分类成败标记)。
- 分类抓取失败:记录错误,继续其余分类,批次标 partial——部分批次不参与下架判定。
- 数据库写入失败(DatabaseError):立即终止本轮,批次标 failed,输出错误汇总。
"""
import sys
import traceback

import config
import database
from scraper import HomarketScraper, ScrapeError, MAX_PAGES_PER_CATEGORY


def main():
    username, password = config.get_credentials()

    database.init_db()
    run_id = database.start_run()
    print(f"Scrape run #{run_id} started.")

    stats = {
        'categories_ok': 0, 'categories_failed': 0, 'products': 0,
        'blacklisted': 0, 'price_parse_failed': 0, 'price_changed': 0,
        'validation_skipped': 0,
    }
    failed_categories = []
    scraper = None

    try:
        # 浏览器构造放在 try 内:Chromium 启动失败也要把批次标 failed,
        # 否则 running 残留会把并发锁卡死 6 小时
        scraper = HomarketScraper()
        scraper.login(username, password)
        categories = scraper.get_categories()
        if not categories:
            raise ScrapeError('未抓到任何分类——页面结构可能已变化')

        for cat in categories:
            print(f"\nProcessing Category: {cat['name']} ({cat['url']})")
            cat_id = database.save_category(cat['name'], cat['url'])
            try:
                products, page_count = scraper.get_products(cat['url'])
            except database.DatabaseError:
                raise
            except Exception as e:
                stats['categories_failed'] += 1
                failed_categories.append((cat['name'], str(e)))
                database.record_category_result(run_id, cat_id, ok=False, error=str(e))
                print(f"  FAILED: {e}")
                continue

            for p in products:
                try:
                    result = database.save_product(run_id, cat_id, p)
                except database.ProductValidationError as e:
                    # 单个商品数据不合格:跳过继续,不杀整轮
                    stats['validation_skipped'] += 1
                    print(f"  skip: {e}")
                    continue
                stats['products'] += 1
                for key in ('blacklisted', 'price_parse_failed', 'price_changed'):
                    if result[key]:
                        stats[key] += 1

            # 抓不全的分类不能算成功,否则它的商品会被误判下架:
            # 翻页触顶 = 尾部没抓到;整分类 0 商品 = 选择器/会话大概率坏了
            suspect = None
            if page_count >= MAX_PAGES_PER_CATEGORY:
                suspect = '翻页触顶,未抓全'
            elif len(products) == 0:
                suspect = '整分类 0 商品(选择器或登录态可疑)'
            database.record_category_result(
                run_id, cat_id, ok=suspect is None, product_count=len(products),
                error=suspect)
            if suspect:
                stats['categories_failed'] += 1
                failed_categories.append((cat['name'], suspect))
                print(f"  WARNING: {cat['name']}: {suspect}")
            else:
                stats['categories_ok'] += 1
            print(f"  Saved {len(products)} products ({page_count} pages)")

        run_status = 'complete' if stats['categories_failed'] == 0 else 'partial'
        # 半数以上价格解析失败 = 页面结构大概率变了(或静默未登录):
        # 本轮不可信,降级 partial,保护下架判定不被污染
        if stats['products'] > 0 and stats['price_parse_failed'] > stats['products'] / 2:
            run_status = 'partial'
            print('  WARNING: 过半商品价格解析失败,本轮降级为 partial(不参与下架判定)')
        run_notes = f"failed categories: {len(failed_categories)}" if failed_categories else None
        database.finish_run(run_id, run_status, notes=run_notes)

    except database.DatabaseError as e:
        # fail-loud:写库失败终止本轮,绝不静默丢数据
        database.finish_run(run_id, 'failed', notes=f'DB write error: {e}')
        print('\n' + '=' * 60)
        print(f'批次 #{run_id} 因数据库写入失败终止:{e}')
        traceback.print_exc()
        sys.exit(1)
    except Exception as e:
        database.finish_run(run_id, 'failed', notes=str(e))
        print('\n' + '=' * 60)
        print(f'批次 #{run_id} 失败:{e}')
        traceback.print_exc()
        sys.exit(1)
    finally:
        if scraper is not None:
            scraper.close()

    print('\n' + '=' * 60)
    print(f"批次 #{run_id} 完成,状态:{run_status}")
    print(f"  分类:{stats['categories_ok']} 成功,{stats['categories_failed']} 失败")
    print(f"  商品:{stats['products']} 条入池")
    print(f"  黑名单拦截:{stats['blacklisted']} 条(隔离,不入可入刊集合)")
    print(f"  价格解析失败:{stats['price_parse_failed']} 条(存 null 打标)")
    if stats['validation_skipped']:
        print(f"  数据不合格跳过:{stats['validation_skipped']} 条(缺名/缺链接)")
    print(f"  变价:{stats['price_changed']} 条")
    if failed_categories:
        print("  失败分类明细:")
        for name, err in failed_categories:
            print(f"    - {name}: {err}")
    if run_status != 'complete':
        print("  注意:非完整批次,本轮不参与下架判定。")


if __name__ == '__main__':
    main()
