// 清理 E2E 夹具及其构建产物:dist 与 _manifest.json 都是带着夹具期构建的,
// 留着会让手动 `wrangler pages deploy dist` 把测试期发上生产。
import { rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { E2E_FIXTURES } from './e2e-fixtures.mjs';

const siteDir = dirname(dirname(fileURLToPath(import.meta.url)));
for (const name of E2E_FIXTURES) {
  rmSync(join(siteDir, 'src', 'data', 'issues', name), { force: true });
}
rmSync(join(siteDir, 'dist'), { recursive: true, force: true });
execSync('node scripts/gen-manifest.mjs', { cwd: siteDir, stdio: 'inherit' });

export default async function globalTeardown() {}
