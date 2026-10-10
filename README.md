# Agent Wallet

An AI agent pays for services on its own through [x402](https://www.x402.org/), gets stopped
**before any money moves** when it goes over budget or out of scope, and every payment and
refusal is on a public record anyone can verify.

> **Test network only (Base Sepolia). No real money.**

- Live dashboard: https://demo.yunshu.ai (中文: https://demo.yunshu.ai/zh/)
- Demo wallet `research-bot-01`: [`0xC788…b0Fc`](https://sepolia.basescan.org/address/0xC788272Fe9c76810ef1bA2539B56822405eDb0Fc) (since 2026-10-10, with the trusted-payees rule; 001's wallet was [`0x7b14…EeBf0`](https://sepolia.basescan.org/address/0x7b146350cc960A45036C9Db1DcD45Be7693EeBf0))
- Spec, plan, tasks and test results: [`specs/001-agent-wallet-demo/`](specs/001-agent-wallet-demo/)
- Built by [Yunshu AI](https://yunshu.ai)

**中文简介**：AI agent 通过 x402 自主为 API 付费；它的钱包是一个链上合约，单笔上限、每日预算、任务预算和收款白名单都写在合约里。违反规则的付款在资金动用前就被拒绝，并作为公开事件记录在链上，任何人都能核对。仅运行在 Base Sepolia 测试网络，不涉及真实资金，每月成本 0 美元。

## How it works

```text
 agent ──(1) GET /quote ───────────────────────────────▶ paid API (Cloudflare Worker, @x402/hono)
   ▲    ◀─ 402 PAYMENT-REQUIRED: 0.01 USDC to payee ────┘
   │
   ├─(2) wallet.authorize(nonce, payee, amount, …) ──▶ PolicyWallet (Base Sepolia)
   │        rule broken?  → PaymentRefused(reason) event, returns false, nothing signed
   │        all rules ok? → reserve budget + digest, PaymentAuthorized event
   │
   ├─(3) sign EIP-3009 TransferWithAuthorization (from = wallet) with the agent key
   │
   └─(4) GET /quote + PAYMENT-SIGNATURE ─▶ paid API ─▶ x402.org facilitator ─▶ USDC
                                                       USDC asks wallet.isValidSignature (ERC-1271):
                                                       valid only for a reserved digest signed by the agent
```

- **Rules live in the contract** (`contracts/src/PolicyWallet.sol`): per-payment cap, daily
  budget (UTC days), task budgets, allowed payees, pause. Only the operator can change them; the
  agent's key can't raise its own limits.
- **Refusals are events, not reverts**, so blocked payments are on the public record with exactly
  one reason: `PAUSED`, `INVALID_AMOUNT`, `PAYEE_NOT_ALLOWED`, `OVER_PER_PAYMENT_CAP`,
  `OVER_TASK_BUDGET`, `OVER_DAILY_BUDGET`, `INSUFFICIENT_FUNDS`.
- **Payments are standard x402** (`exact` scheme, test USDC). The wallet is an ERC-1271 signer,
  so it can pay any x402 service on Base Sepolia. This was tested live before building
  ([research R2](specs/001-agent-wallet-demo/research.md)).
- **Unused authorizations expire**: anyone can call `release(nonce)` after `validBefore` to return
  the reserved budget.
- **The dashboard** (`apps/dashboard`, Astro) renders from a snapshot of the chain
  (`npm run snapshot`) and tails new events live. It works without JavaScript.

## Repository

| Path | What |
| --- | --- |
| `contracts/` | Foundry: `PolicyWallet`, `PolicyWalletFactory` (EIP-1167 clones), unit, fuzz, invariant and fork tests |
| `packages/agent/` | SDK (`createPolicyWalletSigner`, `payUrl`) and the `agent-wallet` CLI |
| `packages/service/` | The x402-paid demo API (Hono on Cloudflare Workers) |
| `apps/dashboard/` | The public dashboard at demo.yunshu.ai (English `/`, Chinese `/zh/`) |
| `scripts/` | `snapshot.ts` (chain → `history.json`), `export-abi.ts`, the x402/ERC-1271 spike |
| `config/` | `deployments.json` (public addresses), `payees.json` (labels) |
| `.github/workflows/` | `ci.yml` (all tests), `agent-run.yml` (scripted agent every 6 h) |

## Run it yourself (about 15 minutes)

You need Node 22, [Foundry](https://getfoundry.sh) and three test keys. Everything is free.

```bash
git clone https://github.com/edxzh/agent-wallet && cd agent-wallet
npm ci
cd contracts && forge install foundry-rs/forge-std --no-git && cd ..
npm run build:contracts          # forge build + export ABIs
npm run test:contracts           # unit, fuzz (1,000 runs per reason), invariants
npm test                         # SDK, service, snapshot, dashboard content checks
```

1. **Keys**: run `cast wallet new` three times (operator, agent, service payee) and copy
   `.env.example` to `.env`. Put the operator and agent private keys and the payee **address** in
   it. Never commit `.env`, and never put the operator key in CI or chat.
2. **Fund** (free): Base Sepolia ETH for the operator and agent (e.g. the Coinbase Developer
   Platform faucet), and test USDC for the operator (CDP faucet or faucet.circle.com).
3. **Deploy and configure** (operator key):

   ```bash
   alias aw='npx tsx packages/agent/src/cli.ts'
   aw deploy-factory
   aw create-wallet --name my-agent --cap 1.00 --daily 1.00
   aw set-payee <SERVICE_PAYEE> --allow
   aw set-task market-research --budget 10
   aw set-task archive-research --budget 0.005
   aw fund 5
   aw status --pretty
   ```

4. **Run the paid API locally** with your payee: set `PAYEE_ADDRESS` in
   `packages/service/wrangler.toml`, then `npm run dev -w packages/service` (port 8787).
5. **Pay and get refused** (agent key):

   ```bash
   aw pay "http://localhost:8787/quote?pair=ETH-USDC" --task market-research --pretty
   aw run-scenario --api http://localhost:8787     # 3 payments + 4 deliberate violations
   ```

6. **See it**: `npm run snapshot && npm run dev -w apps/dashboard`.

CLI commands: `deploy-factory`, `create-wallet`, `fund`, `set-payee`, `set-task`, `set-cap`,
`set-daily`, `pause`, `unpause`, `withdraw` (operator); `pay`, `run-scenario`, `release-expired`
(agent); `status` (read-only). Every command refuses to run on any chain but Base Sepolia.
Exit codes: `0` ok, `1` wrong network or config, `2` unexpected outcome, `3` insufficient funds.

## Safety notes

- Test network only. Contracts, scripts and the Worker all check the chain and refuse anything
  but Base Sepolia (84532).
- `authorize` reverts only for a non-agent caller or a reused nonce; every policy outcome is an
  event. `isValidSignature` accepts nothing but a reserved digest signed by the agent key.
- The facilitator checks signatures on its own node, which can lag; the SDK waits 3
  confirmations after `authorize` before signing (found during live testing).
- Not audited. Don't use with real funds.

## Cost

$0 a month: Base Sepolia test tokens, the public RPC, the free x402.org facilitator, Cloudflare
Workers and Pages free tiers, and GitHub Actions for a public repo.

## License

MIT
