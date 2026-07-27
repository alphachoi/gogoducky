# gogoducky

私域代购周刊货架(加拿大→中国)。设计:`~/.gstack/projects/alphachoi-gogoducky/alpha-main-design-20260725-151152.md`(APPROVED / ENG CLEARED)。

## 结构

```
homarket_scraper/   选品池管道(本地运行,不部署)
  main.py             每周抓取入口(批次模型 + fail-loud)
  scraper.py          DrissionPage 抓取(分页抓全)
  database.py         SQLite 选品池(变价/下架检测、黑名单隔离)
  blacklist.py        药品关键词黑名单(入池层拦截,P4 红线)
  pricing.py          价格解析(分单位)+ 定价公式 + 毛利兜底
  pricing.json        定价三数字(创始人填:服务费率/运费分摊/毛利阈值)
  publish.py          一键入刊:选品→草稿→图片webp→定价→合规检查单
site/               周刊站点(Astro SSG → Cloudflare Pages)
  src/data/issues/    每期一个 JSON(publish.py 生成草稿)
  src/data/refs.json  邀请码白名单(只有码,无客户信息)
  functions/api/      归因端点(Pages Function → D1)
  tests/  e2e/        Vitest + Playwright
tests/              管道 pytest
docs/               微信真机检查单、指标基线模板
```

## 每周工作流

```bash
cd homarket_scraper
# 0. 首次:cp .env.example .env 填凭据;pip install -r requirements.txt
venv/bin/python main.py                                # 1. 抓一轮(批次入池)
venv/bin/python publish.py list                        # 2. 看可入刊集合(变价有标)
venv/bin/python publish.py draft --issue 12 --ids 3,7,12 --fx 5.20   # 3. 生成草稿+图片
# 4. 手改 site/src/data/issues/issue-012.json 补卷首语(greeting)/规格/时效/备注/角标(deal)
venv/bin/python publish.py check --issue 12            # 5. 合规检查单(勾不全不发布)
git add site/ && git commit && git push                # 6. push 即部署
# 7. 发版前过一遍 docs/wechat-checklist.md
```

发新邀请码:`site/src/data/refs.json` 加一行 + push;码→客户映射只记在本地表格。

## 测试

```bash
homarket_scraper/venv/bin/python -m pytest tests/      # 管道 pytest
cd site && npm test                                    # 站点+归因 Vitest
cd site && npm run e2e                                 # 全链路 E2E(Playwright,含本地 D1)
```

## 首次部署

1. 买主/备域名;Cloudflare 建 Pages 项目连本仓库,构建目录 `site`,命令 `npm run build`,输出 `dist`。
2. `npx wrangler d1 create gogoducky-events` → id 填进 `site/wrangler.toml` → `npx wrangler d1 execute gogoducky-events --remote --file=schema.sql`,Pages 绑定 D1(binding 名 `DB`)。
3. 换掉 `site/public/images/wechat-qr.png`(真二维码)、填 `site/src/data/site.json` 微信号、填 `homarket_scraper/pricing.json` 三个数字、`refs.json` 删掉 demo01 换真码。
4. 上线前两周开始填 `docs/metrics-baseline.md` 基线。
