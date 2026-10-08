import { expect, test } from '@playwright/test';

const pages = [
  { path: '/', banner: 'Test network only. No real money.', rules: 'Per payment', spend: 'Spent today', verify: 'verify ↗' },
  { path: '/zh/', banner: '仅测试网络，不涉及真实资金。', rules: '单笔上限', spend: '今日已支出', verify: '核对 ↗' },
];

for (const p of pages) {
  test.describe(p.path, () => {
    test('renders rules, spend and timeline rows from history.json, with the testnet banner', async ({ page }) => {
      await page.goto(p.path);
      await expect(page.getByRole('note').filter({ hasText: p.banner })).toBeVisible();
      await expect(page.locator('.rules').getByText(p.rules, { exact: true })).toBeVisible();
      await expect(page.locator('.spend').getByText(p.spend, { exact: true })).toBeVisible();
      await expect(page.locator('[data-live="rows"] > li').first()).toBeVisible();
    });

    test('every timeline row links to its BaseScan transaction', async ({ page }) => {
      await page.goto(p.path);
      const links = page.locator('[data-live="rows"] > li a');
      const n = await links.count();
      expect(n).toBeGreaterThan(0);
      for (const href of await links.evaluateAll((as) => as.map((a) => a.getAttribute('href')))) {
        expect(href).toMatch(/^https:\/\/sepolia\.basescan\.org\/tx\/0x[0-9a-f]{64}$/);
      }
      await expect(links.first()).toHaveText(p.verify);
    });
  });
}

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });
  test('the timeline is still readable', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('[data-live="rows"] > li').first()).toBeVisible();
    await expect(page.locator('[data-live="rows"] > li .title').first()).not.toBeEmpty();
  });
});

test('shows a notice when the network is unavailable', async ({ page }) => {
  await page.route('https://sepolia.base.org/**', (route) => route.abort());
  await page.route('https://sepolia.base.org', (route) => route.abort());
  await page.goto('/');
  await expect(page.locator('[data-live="notice"]')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-live="notice"]')).toContainText('Network unavailable');
  await expect(page.locator('[data-live="rows"] > li').first()).toBeVisible(); // data stays on screen
});
