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
