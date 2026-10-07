# Contract: Dashboard (`demo.yunshu.ai`)

## Routes

| Path | Content |
| --- | --- |
| `/` | English dashboard (default, matching yunshu.ai) |
| `/zh/` | Chinese dashboard |
| `/history.json` | The snapshot below, public, for independent use |

Static HTML from the snapshot at build time. Readable with no JS (constitution III). A banner on
every page: "Test network only. No real money." / "仅测试网络，不涉及真实资金。" (FR-020).

## Page sections (per wallet)

1. **Rules**: per-payment cap, daily budget with time to next reset (UTC midnight), allowed
   payees with labels, task budgets, and a paused badge.
2. **Spend**: today spent / budget and each task's spent / budget as bars, plus balance.
3. **Timeline**, newest first:
   - settled ✓, refused ✕ with a plain-language reason, expired ↺, rule change ⚙;
   - each row shows the amount, payee label, task label, relative time and a "verify ↗" link to
     BaseScan (FR-012, FR-014).

Plain-language reasons come from `src/i18n/{en,zh}.json` under `reason.*` (FR-016), e.g. English
`OVER_DAILY_BUDGET` = "Would exceed today's budget".

## `history.json` (snapshot, built by `scripts/snapshot.ts`)

```jsonc
{
  "network": "eip155:84532",
  "generatedAt": "2026-10-07T06:00:00Z",
  "lastBlock": 47804117,                 // live tail starts after this
  "wallets": [{
    "address": "0x…", "name": "research-bot-01", "paused": false,
    "policy": { "perPaymentCap": "1000000", "dailyBudget": "5000000" },
    "payees": [{ "address": "0x…", "label": "Yunshu demo quote API", "allowed": true }],
    "tasks": [{ "id": "0x…", "label": "market-research", "budget": "2000000", "spent": "40000" }],
    "today": { "day": 20733, "spent": "30000" },
    "balance": "19870000",
    "events": [ /* record entries, see data-model.md, newest first, capped at 500 */ ]
  }]
}
```

## Live tail (JS, lazy-loaded after first paint)

- Polls `eth_getLogs` on `https://sepolia.base.org` every **10 s**, for the wallet and USDC
  `AuthorizationUsed` logs, from `lastBlock + 1`. Each call stays within 500 blocks (the RPC's
  limit, research R7).
- New rows animate in (respecting reduced motion) and the counters update (FR-015, SC-003).
- On RPC failure: keep what's shown and display "Network unavailable, showing data as of
  <time>".
- First-screen JS budget ≤ 50 KB gzip. viem loads only in this chunk.
