import { defineConfig } from 'astro/config';

export default defineConfig({
  // SSG:每期 = 一个数据文件,push 即构建发布(Cloudflare Pages)
  output: 'static',
});
