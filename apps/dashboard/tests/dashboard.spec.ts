import { expect, test } from '@playwright/test';

const pages = [
  { path: '/', banner: 'Test network only. No real money.', rules: 'Per payment', spend: 'Spent today', verify: 'verify ↗', counts: 'refused' },
  { path: '/zh/', banner: '仅测试网络，不涉及真实资金。', rules: '单笔上限', spend: '今日已支出', verify: '核对 ↗', counts: '被拒绝' },
];

for (const p of pages) {
  test.describe(p.path, () => {
    test('renders rules, spend and timeline rows from history.json, with the testnet banner', async ({ page }) => {
      await page.goto(p.path);
      await expect(page.getByRole('note').filter({ hasText: p.banner })).toBeVisible();
      await expect(page.locator('.rules').getByText(p.rules, { exact: true })).toBeVisible();
      await expect(page.locator('.spend').getByText(p.spend, { exact: true })).toBeVisible();
      await expect(page.locator('.timeline li.row').first()).toBeVisible();
    });

    test('groups activity into runs: the newest is open, the rest fold away', async ({ page }) => {
      await page.goto(p.path);
      const groups = page.locator('[data-live="groups"] > details.group');
      expect(await groups.count()).toBeGreaterThan(1);
      await expect(groups.first()).toHaveAttribute('open', '');
      await expect(groups.first().locator('.counts')).toContainText(p.counts);
      await expect(groups.nth(1)).not.toHaveAttribute('open', '');
      await expect(groups.nth(1).locator('li.row').first()).toBeHidden();
      await groups.nth(1).locator('summary').click();
      await expect(groups.nth(1).locator('li.row').first()).toBeVisible();
    });

    test('every timeline row links to its BaseScan transaction (a status change, to the identity)', async ({ page }) => {
      await page.goto(p.path);
      const links = page.locator('.timeline li.row:not([data-kind="status"]) a');
      expect(await links.count()).toBeGreaterThan(0);
      for (const href of await links.evaluateAll((as) => as.map((a) => a.getAttribute('href')))) {
        expect(href).toMatch(/^https:\/\/sepolia\.basescan\.org\/tx\/0x[0-9a-f]{64}$/);
      }
      await expect(links.first()).toHaveText(p.verify);
      // A status change isn't a transaction: it links the service's ERC-8004 identity.
      const status = page.locator('.timeline li.row[data-kind="status"] a');
      for (const href of await status.evaluateAll((as) => as.map((a) => a.getAttribute('href')))) {
        expect(href).toMatch(/^https:\/\/sepolia\.basescan\.org\/nft\/0x[0-9a-fA-F]{40}\/\d+$/);
      }
    });
  });
}

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });
  test('the timeline is still readable', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.timeline li.row').first()).toBeVisible();
    await expect(page.locator('.timeline li.row .title').first()).not.toBeEmpty();
  });
  test('folded runs still open', async ({ page }) => {
    await page.goto('/');
    const second = page.locator('[data-live="groups"] > details.group').nth(1);
    await second.locator('summary').click();
    await expect(second.locator('li.row').first()).toBeVisible();
  });
});

test('shows a notice when the network is unavailable', async ({ page }) => {
  await page.route('https://sepolia.base.org/**', (route) => route.abort());
  await page.route('https://sepolia.base.org', (route) => route.abort());
  await page.goto('/');
  await expect(page.locator('[data-live="notice"]')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-live="notice"]')).toContainText('Network unavailable');
  await expect(page.locator('.timeline li.row').first()).toBeVisible(); // data stays on screen
});

test('live events join the newest run, or start a new one when far apart', async ({ page }) => {
  const { encodeAbiParameters, encodeEventTopics, parseAbi, pad } = await import('viem');
  const history = (await import('../src/data/history.json', { with: { type: 'json' } })).default;
  const w = history.wallets[0]!;
  const abi = parseAbi(['event PaymentRefused(bytes32 indexed nonce, address indexed payee, bytes32 indexed taskId, uint256 amount, uint8 reason)']);
  const newest = Date.parse(w.events[0]!.time) / 1000;
  const blocks: Record<string, number> = { '0x1': newest + 60, '0x2': newest + 86_400 }; // +1 min, +1 day
  const log = (n: number) => ({
    address: w.address,
    topics: encodeEventTopics({ abi, eventName: 'PaymentRefused', args: { nonce: pad(`0x${n}`), payee: w.payees[0]!.address as `0x${string}`, taskId: pad('0x0') } }),
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint8' }], [10_000n, 3]),
    blockNumber: `0x${n}`,
    logIndex: '0x0',
    transactionHash: pad(`0x${n}`),
  });
  let served = false;
  await page.route('https://sepolia.base.org', async (route) => {
    const req = route.request().postDataJSON() as { id: number; method: string; params: any[] };
    const reply = (result: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) });
    if (req.method === 'eth_blockNumber') return reply(`0x${(history.lastBlock + 1).toString(16)}`);
    if (req.method === 'eth_getBlockByNumber') return reply({ timestamp: `0x${blocks[req.params[0]]!.toString(16)}` });
    if (req.method === 'eth_call') return reply(pad('0x0'));
    if (req.method === 'eth_getLogs') {
      const isWallet = req.params[0].address.toLowerCase() === w.address.toLowerCase();
      if (!isWallet || served) return reply([]);
      served = true;
      return reply([log(1), log(2)]);
    }
    return reply(null);
  });
  const groups = page.locator('[data-live="groups"] > details.group');
  await page.goto('/');
  const before = await groups.first().locator('li.row').count();
  await expect(groups.first().locator('.counts')).toContainText('refused', { timeout: 15_000 });
  await expect(groups.first().locator('li.row')).toHaveCount(1, { timeout: 15_000 }); // +1 day: new run
  await expect(groups.first()).toHaveAttribute('open', '');
  await expect(groups.first().locator('.counts')).toHaveText('1 refused');
  await expect(groups.nth(1).locator('li.row')).toHaveCount(before + 1); // +1 min: joined
});

// ── 002: trusted payees (T031) ─────────────────────────────────────────────────────────────
const trustPages = [
  { path: '/', rule: 'Pays services it hasn', payable: /^(Payable|Not payable)$/, rated: 'Rated ' },
  { path: '/zh/', rule: '未经手动允许的服务', payable: /^(可付款|不可付款)$/, rated: '评分' },
];
for (const p of trustPages) {
  test(`${p.path}: trust rule, one card per service, rated rows`, async ({ page }) => {
    await page.route('https://sepolia.base.org', (r) => r.abort());
    await page.goto(p.path);
    await expect(page.locator('[data-trust="rule"]')).toContainText(p.rule);
    const cards = page.locator('.services > li.service');
    expect(await cards.count()).toBe(6);
    for (const key of ['quote', 'reliable', 'flaky', 'newcomer', 'impostor', 'anonymous']) {
      const card = page.locator(`[data-service="${key}"]`);
      await expect(card.locator('[data-svc="badge"]')).toHaveText(p.payable);
      if (key !== 'anonymous') {
        await expect(card.locator('[data-svc="average"]')).not.toBeEmpty();
        await expect(card.locator('[data-svc="count"]')).toHaveText(/^\d+$/);
      }
    }
    // A refused service always says why.
    const refusedReason = page.locator('.service:has(.badge.off) [data-svc="reason"]').first();
    await expect(refusedReason).not.toBeEmpty();
    const rated = page.locator('.timeline li.row', { hasText: p.rated }).first();
    await expect(rated.locator('a')).toHaveAttribute('href', /^https:\/\/sepolia\.basescan\.org\/tx\/0x[0-9a-f]{64}$/);
  });
}

test.describe('trust section without JavaScript', () => {
  test.use({ javaScriptEnabled: false });
  test('renders the rule and every card', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('[data-trust="rule"]')).toBeVisible();
    expect(await page.locator('.services > li.service').count()).toBe(6);
    await expect(page.locator('[data-service="impostor"] [data-svc="reason"]')).toHaveText("Service claimed someone else's identity");
  });
});
