// 构建前生成 functions/_manifest.json:
// - refs:src/data/refs.json 白名单(只有码,无客户信息)
// - issues:已发布期号列表(归因端点只接受合法期号)
// 下划线开头的文件不会成为路由,只作为 Function 的打包依赖。
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const siteDir = dirname(dirname(fileURLToPath(import.meta.url)));
const issuesDir = join(siteDir, 'src', 'data', 'issues');
const refsPath = join(siteDir, 'src', 'data', 'refs.json');
const outPath = join(siteDir, 'functions', '_manifest.json');

const refs = JSON.parse(readFileSync(refsPath, 'utf8')).refs;

// 生产构建防线:占位符不能上线,这些约束不能只活在 README 里。
// Cloudflare Pages 生产构建(main 分支)时直接失败;其他环境只警告。
// 注:生产分支若改名,这里的 'main' 要跟着改。
const isProdBuild = process.env.CF_PAGES_BRANCH === 'main';
const prodBlockers = [];
if (refs.includes('demo01')) {
  prodBlockers.push('refs.json 仍含演示码 demo01,删掉换真码');
}
const siteCfg = JSON.parse(readFileSync(join(siteDir, 'src', 'data', 'site.json'), 'utf8'));
if (siteCfg.wechat_id.includes('填写')) {
  prodBlockers.push('site.json 微信号还是占位符');
}
const wranglerToml = readFileSync(join(siteDir, 'wrangler.toml'), 'utf8');
if (wranglerToml.includes('TODO-run-wrangler-d1-create')) {
  prodBlockers.push('wrangler.toml D1 database_id 未填(归因会静默全灭)');
}
// 占位二维码上线 = 新客加微信主路径直接缺失,与文本占位符同级拦截
const PLACEHOLDER_QR_SHA256 = '4fd3b95430ae15db68fdf64a23f05cf0f5f711ef2fa39ffef84214715702334c';
const qrPath = join(siteDir, 'public', 'images', 'wechat-qr.png');
if (existsSync(qrPath)) {
  const qrHash = createHash('sha256').update(readFileSync(qrPath)).digest('hex');
  if (qrHash === PLACEHOLDER_QR_SHA256) {
    prodBlockers.push('wechat-qr.png 还是占位图,换成真实微信二维码');
  }
} else {
  prodBlockers.push('wechat-qr.png 不存在');
}
if (prodBlockers.length > 0) {
  if (isProdBuild) {
    throw new Error('生产构建拒绝:\n  - ' + prodBlockers.join('\n  - '));
  }
  for (const b of prodBlockers) console.warn(`⚠ ${b}(生产构建会被拒绝)`);
}

let issues = [];
if (existsSync(issuesDir)) {
  for (const file of readdirSync(issuesDir)) {
    if (!/^issue-\d+\.json$/.test(file)) continue;
    const issue = JSON.parse(readFileSync(join(issuesDir, file), 'utf8'));
    if (issue.published) issues.push(issue.issue);
  }
}
issues.sort((a, b) => a - b);

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify({ refs, issues }, null, 2) + '\n');
console.log(`_manifest.json: ${refs.length} refs, issues [${issues.join(', ')}]`);
