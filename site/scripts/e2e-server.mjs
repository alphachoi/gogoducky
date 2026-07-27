// E2E 服务器:拷入测试夹具期 → 生成 manifest → astro build →
// 本地 D1 建表并清空事件(防跨轮限频 429 假失败)→ wrangler pages dev。
// 夹具由 playwright globalTeardown 清理,且已在 .gitignore 中防误提交。
import { copyFileSync, mkdirSync } from 'node:fs';
import { execSync, spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { E2E_FIXTURES } from './e2e-fixtures.mjs';

const siteDir = dirname(dirname(fileURLToPath(import.meta.url)));
const issuesDir = join(siteDir, 'src', 'data', 'issues');

mkdirSync(issuesDir, { recursive: true });
for (const name of E2E_FIXTURES) {
  copyFileSync(join(siteDir, 'tests', 'fixtures', name), join(issuesDir, name));
}

const run = (cmd) => execSync(cmd, { cwd: siteDir, stdio: 'inherit' });
run('node scripts/gen-manifest.mjs');
run('npx astro build');
run('npx wrangler d1 execute gogoducky-events --local --file=schema.sql');
run(`npx wrangler d1 execute gogoducky-events --local --command 'DELETE FROM events'`);

const server = spawn(
  'npx',
  ['wrangler', 'pages', 'dev', 'dist', '--port', '8788', '--ip', '127.0.0.1'],
  { cwd: siteDir, stdio: 'inherit' }
);
server.on('exit', (code) => process.exit(code ?? 0));
