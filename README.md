# gogoducky

私域代购周刊货架(加拿大→中国)。设计:`~/.gstack/projects/alphachoi-gogoducky/alpha-main-design-20260725-151152.md`(APPROVED / ENG CLEARED)。

## 结构

```
homarket_scraper/   选品池管道(本地运行,不部署)
  main.py             每周抓取入口(批次模型 + fail-loud)
  scraper.py          DrissionPage 抓取(分页抓全;每分类上限 50 页,触顶本轮记 partial)
  database.py         SQLite 选品池(变价/下架检测、黑名单隔离)
  blacklist.py        药品关键词黑名单(入池层拦截,P4 红线;关键词唯一数据源
                      是 site/src/data/blacklist-keywords.json,站点构建层共用同一清单)
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
# 0. 首次:cp .env.example .env 填凭据;python3 -m venv venv && venv/bin/pip install -r requirements.txt
venv/bin/python main.py                                # 1. 抓一轮(批次入池)
venv/bin/python publish.py list                        # 2. 看可入刊集合(变价有标)
venv/bin/python publish.py draft --issue 12 --ids 3,7,12 --fx 5.20   # 3. 生成草稿+图片
#    锁价天数默认 7(--lock-days);重跑已存在的期需 --force(覆盖保护);
#    汇率超合理区间会拒绝,确认没打错位后加 --allow-unusual-fx
# 4. 手改 site/src/data/issues/issue-012.json 补卷首语(greeting)/规格/时效/备注/角标(deal)
venv/bin/python publish.py check --issue 12            # 5. 合规检查单(勾不全不发布)
cd .. && git add site/ && git commit && git push       # 6. 回仓库根;push 即部署
# 7. 发版前过一遍 docs/wechat-checklist.md
```

发新邀请码:`site/src/data/refs.json` 加一行 + push(或在云端后台发码);码→客户映射只记在本地表格。码限 `[A-Za-z0-9_-]`、最长 24 位,不合规或不在白名单的码事件静默降级计入 `direct`。

## 云端后台(/admin)

手机可用的管理界面(Cloudflare Access 邮箱验证码登录),覆盖**出刊之后**的管理:

- 改已发布期刊的文案(卷首语/规格/时效/备注/角标)和价格、延锁价——提交走 GitHub API,约 1 分钟自动重建生效
- **下架**某期(上架不行:上架必须在本地过 `publish.py check` 合规检查单,云端红线)
- 邀请码发码/退役(退役码旧链接流量自动计入 direct)
- 归因报表(按码 7/28 天、按期,直读 D1)

做不了的(数据在本地):跑爬虫、看选品池、生成新期草稿——仍走上面的每周工作流。所有云端文案编辑在服务端和构建层都重过药品关键词筛查。

**启用步骤**(部署后一次性):
1. GitHub 建 fine-grained token(仅本仓库、仅 Contents 读写)
2. Cloudflare Zero Trust → Access → Applications 建自托管应用,路径覆盖 `你的域名/admin*` 和 `你的域名/api/admin*`,策略=你的邮箱;记下 Application Audience (AUD)
3. Pages 项目 → Settings → Environment variables 加 Secret:`GITHUB_TOKEN`、`GITHUB_REPO`(如 `alphachoi/gogoducky`)、`ACCESS_AUD`
4. 打开 `你的域名/admin/`,邮箱收验证码登录

未配置 Access 时后台 fail-closed:页面能开但所有管理端点一律 403,不存在"忘配就裸奔"。

## 测试

```bash
homarket_scraper/venv/bin/python -m pytest tests/      # 管道 pytest
cd site && npm test                                    # 站点+归因 Vitest
cd site && npm run e2e                                 # 全链路 E2E(Playwright,含本地 D1)
```

## 首次部署

1. 买主/备域名;Cloudflare 建 Pages 项目连本仓库,构建目录 `site`,命令 `npm run build`,输出 `dist`。
2. `cd site` 后:`npx wrangler d1 create gogoducky-events` → id 填进 `wrangler.toml` → `npx wrangler d1 execute gogoducky-events --remote --file=schema.sql`,Pages 绑定 D1(binding 名 `DB`)。
3. 换掉 `site/public/images/wechat-qr.png`(真二维码)、填 `site/src/data/site.json` 微信号、填 `homarket_scraper/pricing.json` 三个数字、`refs.json` 删掉 demo01 换真码。
   以上任一占位符没换(demo01 / 占位微信号 / 占位二维码 / 未填 D1 id),main 分支生产构建会直接失败(`site/scripts/gen-manifest.mjs` 防线);本地与预览构建只警告。
4. 上线前两周开始填 `docs/metrics-baseline.md` 基线。
