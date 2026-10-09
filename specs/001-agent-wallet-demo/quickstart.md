# Quickstart & Validation Guide: Agent Wallet Demo

How to run the demo and prove it meets the spec. Interfaces are in [contracts/](./contracts/),
states and reasons in [data-model.md](./data-model.md).

> Everything runs on **Base Sepolia (chain 84532) with test funds only**. Every script exits
> unless `eth_chainId` is 84532.

## Prerequisites

- Node 22+, npm, Foundry (`forge`, `cast`), Git.
- **Owner steps** (manual: faucets use CAPTCHAs or sign-ins, and keys are credentials):
  1. Create two keys locally: `cast wallet new` for the **operator** (stays on your machine) and
     the **agent**.
  2. Fund both with Base Sepolia ETH (Base or Coinbase faucet). Fund the operator with test USDC
     from Circle's faucet.
  3. Put both keys in `.env` (git-ignored). Later, add only `AGENT_PRIVATE_KEY` and
     `WALLET_ADDRESS` as GitHub Actions secrets in the repo settings.

## Set up and deploy

```bash
npm install
forge test                                   # unit, fuzz, invariant tests (contracts/)
npx agent-wallet deploy-factory              # operator key
npx agent-wallet create-wallet --agent <AGENT_ADDR> --name research-bot-01 --cap 1 --daily 5
npx agent-wallet set-payee <SERVICE_PAYEE> --allow
npx agent-wallet set-task market-research --budget 2
cast send <USDC> "transfer(address,uint256)" <WALLET> 20000000 --private-key $OPERATOR_KEY  # fund 20 USDC
npm run dev -w packages/service              # local paid service, or use api.demo.yunshu.ai
```

## Validation scenarios

| # | Scenario | Command or check | Expected | Spec |
| --- | --- | --- | --- | --- |
| 0 | **Payment-design test** (task 1) | Minimal 1271 wallet pays a local `@x402/hono` endpoint through the x402.org facilitator | Settlement transaction on BaseScan. Records Design A or B in research.md | R2 |
| 1 | Allowed payment | `npx agent-wallet pay https://api.demo.yunshu.ai/quote?pair=ETH-USDC --task market-research` | 200 with quote. `PaymentAuthorized`, then USDC `AuthorizationUsed`. Budgets drop by 0.01 | US1 |
| 2 | Each refusal | `run-scenario` (cap 1.5, task overrun, daily overrun, unlisted payee); `pause` then `pay` | One `PaymentRefused` per attempt with the right reason. Wallet balance unchanged | US2, SC-001 |
| 3 | Agent can't change rules | Call `setPolicy` with the agent key | Reverts | FR-003 |
| 4 | Rules apply next attempt | `set-cap 0.005`, then `pay` | Refused `OVER_PER_PAYMENT_CAP` | US4, SC-005 |
| 5 | Replay | Re-send the same signed x402 payload | Second settlement rejected. Spend unchanged | FR-010 |
| 6 | Expiry | Authorize but don't settle, wait past `validBefore`, `release-expired` | `PaymentExpired`. Budget returned | data-model |
| 7 | Concurrency and limits | `forge test --match-contract Invariant` (≥ 200 random sequences) | Invariants hold | SC-002 |
| 8 | Dashboard | Open `demo.yunshu.ai` and `/zh/` on phone and desktop. Run `pay` with the page open | New row within 30 s. Each row's "verify ↗" opens the matching BaseScan transaction | US3, SC-003 |
| 9 | No-JS / RPC down | Disable JS; block `sepolia.base.org` | Snapshot history still readable. "Network unavailable" notice | III, edge |
| 10 | Schedule | Leave the cron for 48 h | Activity from both days. Each run has at least one settled and one refused | US5, SC-007 |
| 11 | Low funds | Withdraw down to below 0.01 USDC, run the scenario | Exit 3, `INSUFFICIENT_FUNDS` recorded | edge |
| 12 | Reproducible | A new developer follows README on a clean machine | One settled and one refused in ≤ 15 min | US6, SC-008 |
| 13 | Cost | Cloudflare and GitHub billing after 1 month | $0 | SC-006 |

## Done when

- [ ] Scenarios 0–12 pass, and scenario 13 is checked monthly.
- [ ] Website follow-up: the Work section uses a dashboard screenshot, `status: "shipped"` and
      the repo link (feature 001 change).

## Results on Base Sepolia (2026-10-08)

Deployment (`config/deployments.json`): implementation `0xe5c6…46e8ef`, factory `0xdc2f…f0f204`,
wallet **research-bot-01** `0x7b146350cc960A45036C9Db1DcD45Be7693EeBf0` (agent `0x1F19…C3DB`).
Demo policy: **1.00 USDC per payment, 1.00 USDC per day** (chosen so every scheduled run can
show an honest over-daily refusal; see tasks.md T047 note), tasks `market-research` (10.00) and
`archive-research` (0.005, used by the over-task probe). Funded with 9 USDC.

| # | Scenario | Result |
| --- | --- | --- |
| 1 | `pay …/quote` (local `wrangler dev`) | ✅ 200. [authorize](https://sepolia.basescan.org/tx/0xd76f6e6ebe14a341f2a8ea2ef9cacabff400e109a1a5091c5f3ab822198cf66b) → [settlement](https://sepolia.basescan.org/tx/0xc9901a700da9712b92d275133044c60c6b27d24ac48973a60b8793c7d2e93379) |
| 2 | `run-scenario --seed 1` | ✅ exit 0. 3 payments settled; refused: [over cap 1.50](https://sepolia.basescan.org/tx/0x8b73fcc2dd335b9bf2cd7040ba99df5b39628949a233e57bcd8cea75ca7ac6a2), [unlisted payee](https://sepolia.basescan.org/tx/0xe7ad6ea5948e429d81d7d3913cda8827e2f198023cd7a5ac04bf959040ce0443), [over task](https://sepolia.basescan.org/tx/0xc8474c767f142d06709167afea4b87a1cf64c2f6fbb7f39cd678ae8c27b405bc), [over daily 0.95](https://sepolia.basescan.org/tx/0xc1ad6668ab4af32b49ec6e954276c5ffbfee7997de7655b981a0b7ede07c454a). Balance unchanged by each refusal |
| 3 | Agent calls `setPolicy` / `setPayee` | ✅ Reverts `NotOperator` (simulated with `cast call --from agent`) |
| 5 | Replay a used nonce | ✅ Wallet reverts `NonceAlreadyUsed`; USDC `authorizationState` is `true` for the settled nonce |
| 6 | Expiry + `release-expired` | ✅ The two authorizations from the first attempts (see below) never settled; after they expired (`validBefore` = signing + 300 s, the API's `maxTimeoutSeconds`) `release-expired` returned their 0.02: [release 1](https://sepolia.basescan.org/tx/0x09850950e43a089cba56bdff2ad19d2b8295c4c8dee4cfa51631e1ad5c7680a5), [release 2](https://sepolia.basescan.org/tx/0x1a139aaa9b266e0731de56369a9247274621cf22dbb30152f4875bc7fa059996) |
| 4 | `set-cap 0.005` → pay; `pause` → pay; `unpause` → pay | ✅ Refused `OVER_PER_PAYMENT_CAP`, then refused `PAUSED`, then paid. Cap restored to 1.00 |

**Found and fixed during the run**: the first two payments were rejected by the facilitator with
`invalid_exact_evm_signature` although the signature and digest were correct. The facilitator
checks `isValidSignature` on a node that can lag our receipt by a block, so it didn't yet see the
reservation. The signer now waits for 3 confirmations (~4 s) after `authorize` before returning
the signature (`AUTHORIZE_CONFIRMATIONS` in `packages/agent/src/signer.ts`).

**Scenario 9 (live tail, local build)**: with the built dashboard open in Chrome, a `pay` at
02:33:27 UTC settled at 02:33:39 and its row appeared at the top of the timeline within the next
10 s poll, marked settled, and the balance counter updated (8.95 → 8.94). The browser's requests
to `https://sepolia.base.org` returned 200 (no CORS issue) and the console had no errors. The
blocked-RPC notice is covered by the Playwright test. On `demo.yunshu.ai` itself this still needs
re-checking after the next deploy (T040).

### Scenarios 8 and 9 on demo.yunshu.ai (2026-10-09, T040)

Checked with Playwright (Chromium) against the live site after the first automatic deploy
(`deploy-dashboard.yml` run 37930648579).

| # | Check | Result |
| --- | --- | --- |
| 8 | `/` and `/zh/` on desktop (1280×900) and phone (Pixel 7) | ✅ Testnet banner in the right language, 6 run groups (newest open), "Older activity (7)". No horizontal scroll on the phone, no console errors, RPC requests 200 |
| 8 | "verify ↗" links | ✅ All 39 rows link to `sepolia.basescan.org/tx/0x…`; all 34 distinct transactions succeeded on-chain and emit logs from the wallet (or USDC `AuthorizationUsed` for it) |
| 8 | `pay` with the page open | ✅ Settled 10.3 s after start ([tx](https://sepolia.basescan.org/tx/0xea6194591af8a76ab6b2ddae0a3d4a54bcfbbf413d8801e7c0fcd573bf254fdf)); its row appeared **5.9 s after settlement** (SC-003 ≤ 30 s), linking to the settlement tx, in a new "Agent activity" group; balance 8.90 → 8.89 |
| 8 | Live tail catch-up | ✅ Picked up a release made after the snapshot (row 39) using 200-block `getLogs` chunks |
| 9 | JavaScript disabled | ✅ All 38 snapshot rows render; folded groups open with `<details>` |
| 9 | `sepolia.base.org` blocked | ✅ "Network unavailable, showing data as of 9 Oct 2026, 11:27 UTC." and all rows stay on screen |

