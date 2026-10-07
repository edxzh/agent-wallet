// @ts-check
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://demo.yunshu.ai',
  output: 'static',
  trailingSlash: 'always',
  build: { format: 'directory' },
});
