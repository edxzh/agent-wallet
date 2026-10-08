import { defineConfig, devices } from '@playwright/test';

// Smoke tests run against the built site (`npm run build` first), served by `astro preview`.
export default defineConfig({
  testDir: 'tests',
  timeout: 30_000,
  use: { baseURL: 'http://localhost:4399' },
  webServer: { command: 'node tests/serve.mjs', url: 'http://localhost:4399', reuseExistingServer: !process.env.CI },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'phone', use: { ...devices['Pixel 7'] } },
  ],
});
