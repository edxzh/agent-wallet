import { expect, test, type Page } from '@playwright/test';
import { encodeAbiParameters, encodeEventTopics, pad, parseAbi, type Hex } from 'viem';

// specs/003-try-to-overspend. The Base Sepolia node is mocked, so these tests check the page, not
// the chain (scripts/check-try.ts checks the live contract).
const abi = parseAbi([
  'event PaymentAuthorized(bytes32 indexed nonce, address indexed payee, bytes32 indexed taskId, uint256 amount, uint256 validBefore, bytes32 digest)',
  'event PaymentRefused(bytes32 indexed nonce, address indexed payee, bytes32 indexed taskId, uint256 amount, uint8 reason)',
]);
const ZERO = pad('0x0') as Hex;
const PAYEE = pad('0x1', { size: 20 }) as Hex;
const authorized = () => ({
  topics: encodeEventTopics({ abi, eventName: 'PaymentAuthorized', args: { nonce: ZERO, payee: PAYEE, taskId: ZERO } }),
  data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }], [1n, 1n, ZERO]),
});
const refused = (reason: number) => ({
  topics: encodeEventTopics({ abi, eventName: 'PaymentRefused', args: { nonce: ZERO, payee: PAYEE, taskId: ZERO } }),
  data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint8' }], [1n, reason]),
});

/** A fake node: one payment is refused over the cap; several are authorized, then over the daily budget. */
async function mockNode(page: Page, opts: { chainId?: string } = {}) {
  const methods: string[] = [];
  await page.route('https://sepolia.base.org/**', async (route) => {
    const req = route.request().postDataJSON() as { id: number; method: string; params: any[] };
    methods.push(req.method);
    const result = (() => {
      switch (req.method) {
        case 'eth_chainId':
          return opts.chainId ?? '0x14a34';
        case 'eth_call':
          return pad('0x1F1906b97EBB69dc826bAA03282e0d6F9074C3DB');
        case 'eth_getBlockByNumber':
          return { number: '0x2dbe6a0', timestamp: '0x6700a000' };
        case 'eth_simulateV1': {
          const calls = req.params[0].blockStateCalls[0].calls as unknown[];
          const logs = calls.length === 1 ? [[refused(4)]] : calls.map((_, i) => (i === 0 ? [authorized()] : [refused(6)]));
          return [{ number: '0x2dbe6a1', calls: logs.map((l) => ({ status: '0x1', logs: l })) }];
        }
      }
    })();
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) });
  });
  return methods;
}

const pages = [
  { path: '/try/', heading: 'Try to make it overspend', capped: 'Refused: Over the per-payment cap', allowed: 'Would be allowed', daily: "Refused: Would exceed today's budget", dryRun: 'Nothing was signed or sent', network: "Couldn't reach", badAddress: 'Enter an address' },
  { path: '/zh/try/', heading: '试着让它超支', capped: '被拒绝：超过单笔上限', allowed: '会被放行', daily: '被拒绝：会超出今日预算', dryRun: '没有签名', network: '无法连接', badAddress: '请输入地址' },
];

for (const p of pages) {
  test.describe(p.path, () => {
    test('a preset shows the contract answer, marked as a dry run', async ({ page }) => {
      const methods = await mockNode(page);
      await page.goto(p.path);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(p.heading);
      await page.locator('button[data-attack="big"]').click();
      const result = page.locator('#aw-try-result');
      await expect(result.locator('.verdict')).toHaveText(p.capped);
      await expect(result).toContainText(p.dryRun);
      expect(methods[0]).toBe('eth_chainId');
      expect(methods).toContain('eth_simulateV1');
    });

    test('repeated payments each get their own answer', async ({ page }) => {
      await mockNode(page);
      await page.goto(p.path);
      await page.locator('button[data-attack="daily"]').click();
      const verdicts = page.locator('#aw-try-result .verdict');
      await expect(verdicts).toHaveCount(3);
      await expect(verdicts.nth(0)).toHaveText(p.allowed);
      await expect(verdicts.nth(2)).toHaveText(p.daily);
    });

    test('refuses to run on any chain but Base Sepolia', async ({ page }) => {
      const methods = await mockNode(page, { chainId: '0x1' });
      await page.goto(p.path);
      await page.locator('button[data-attack="normal"]').click();
      await expect(page.locator('#aw-try-result')).toContainText(p.network);
      expect(methods).not.toContain('eth_simulateV1');
    });

    test('a custom attack with a bad address runs nothing', async ({ page }) => {
      const methods = await mockNode(page);
      await page.goto(p.path);
      await expect(page.locator('#aw-try-form button[type="submit"]')).toBeEnabled();
      await page.locator('select[name="payee"]').selectOption('other');
      await page.locator('input[name="address"]').fill('0x1234');
      await page.locator('#aw-try-form button[type="submit"]').click();
      await expect(page.locator('#aw-try-form .invalid')).toContainText(p.badAddress);
      expect(methods).toHaveLength(0);
    });
  });
}

test('the dashboard links to the try page in each language', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.ctas a[href="/try/"]')).toBeVisible();
  await page.goto('/zh/');
  await expect(page.locator('.ctas a[href="/zh/try/"]')).toBeVisible();
});

test('the try page links to the other language and declares its own canonical URL', async ({ page }) => {
  await page.goto('/try/');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://demo.yunshu.ai/try/');
  await expect(page.locator('link[hreflang="zh-Hans"]')).toHaveAttribute('href', 'https://demo.yunshu.ai/zh/try/');
  await expect(page.locator('.lang a[hreflang="zh-Hans"]')).toHaveAttribute('href', '/zh/try/');
});

test.describe('try page without JavaScript', () => {
  test.use({ javaScriptEnabled: false });
  test('explains itself, lists the presets, and links to the real record', async ({ page }) => {
    await page.goto('/try/');
    await expect(page.locator('noscript').first()).toBeAttached();
    await expect(page.locator('.presets li')).toHaveCount(7);
    await expect(page.locator('.presets q').first()).not.toBeEmpty();
    await expect(page.locator('button[data-attack]').first()).toBeDisabled();
  });
});
