# Agent Wallet

An AI agent pays for services on its own through [x402](https://www.x402.org/), gets stopped
**before any money moves** when it goes over budget or out of scope, and every payment and
refusal is on a public record anyone can verify.

> **Test network only (Base Sepolia). No real money.**

- Live dashboard: https://demo.yunshu.ai (中文: https://demo.yunshu.ai/zh/)
- Demo wallet `research-bot-01`: [`0xC788…b0Fc`](https://sepolia.basescan.org/address/0xC788272Fe9c76810ef1bA2539B56822405eDb0Fc) (since 2026-10-10, with the trusted-payees rule; 001's wallet was [`0x7b14…EeBf0`](https://sepolia.basescan.org/address/0x7b146350cc960A45036C9Db1DcD45Be7693EeBf0))
- Spec, plan, tasks and test results: [`specs/001-agent-wallet-demo/`](specs/001-agent-wallet-demo/),
  and for trusted payees [`specs/002-trusted-payees-erc8004/`](specs/002-trusted-payees-erc8004/)
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

## Trusted payees (ERC-8004)

The wallet can also pay services it has **never been told about**, if they have earned a good
enough reputation from reviewers the operator trusts. Services prove who they are with an
[ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) identity, and the wallet reads reputation
from the ERC-8004 registries **on-chain, inside `authorize`**, before any money moves.

**The rule** (`setReputationRule`, operator only). On `research-bot-01` it is: pay a service
outside the allowlist only if its trusted reviewers' average is **≥ 70 from ≥ 3 reviews**. The
trusted reviewers are set with `setTrustedReviewer`, at most 5. For each payment the wallet
checks:

1. **Identity**: if the service claims an ERC-8004 identity (in its x402 `extra`), the
   identity's registered wallet must be the payee. This applies even to an allowlisted payee.
2. **Allowlist**: an allowlisted payee passes, as in 001.
3. **Reputation**: otherwise, with the rule on, the service needs an identity, at least 3
   trusted reviews, and an average of at least 70.

There are five new refusal reasons, again events with exactly one reason:
`PAYEE_IDENTITY_UNVERIFIED`, `PAYEE_IDENTITY_MISMATCH`, `REPUTATION_UNAVAILABLE` (a registry
read failed: never a pass, never a revert), `NOT_ENOUGH_TRUSTED_REVIEWS` and
`PAYEE_REPUTATION_TOO_LOW`. `checkPayee` gives the same answer as a free read.

**Why ratings can't be faked** ([research R4](specs/002-trusted-payees-erc8004/research.md)):
- The wallet itself is the reviewer: `rate(nonce, score, …)` can be called only by its agent.
- It can rate only a payment that **settled** to an identity the wallet **checked**. The
  `agentId` comes from that payment's record, never from the caller, and each payment is rated
  once.
- Each rating's `feedbackHash` is the payment nonce, so every review links to a real payment on
  the public record.
- So even a stolen agent key can't invent reviews for a service the operator's rules never let
  it pay. An impostor (a different payee claiming someone else's identity) can't gain trusted
  reviews at all.

**The live demo** ([research R5](specs/002-trusted-payees-erc8004/research.md)). One Worker serves
five demo services next to 001's `/quote`, each with its own payee and identity. The services
are owned by a separate account, because the registry bans rating your own service.

| Service | Behaviour | What the gated wallet sees |
| --- | --- | --- |
| `/quote` (001, #9613) | always fresh | allowlisted: always pays, and rates it |
| `/s/reliable/quote` (#9614) | always fresh | refused until it has 3 reviews, then paid |
| `/s/flaky/quote` (#9615) | fresh, then stale from 2026-10-10 18:17 UTC | paid, then `PAYEE_REPUTATION_TOO_LOW` for good |
| `/s/newcomer/quote` (#9616) | closed (503) until 2026-10-11 18:17 UTC | `NOT_ENOUGH_TRUSTED_REVIEWS`, then paid |
| `/s/impostor/quote` | claims reliable's identity with its own payee | always `PAYEE_IDENTITY_MISMATCH` |
| `/s/anonymous/quote` | no identity | always `PAYEE_IDENTITY_UNVERIFIED` |

Every 6 hours, two **scout** wallets (`scout-02` and `scout-03`, rule off, allowlisting only the
demo services) pay and rate each open service. Then `research-bot-01` tries every service. Each
quote is scored by a fixed rule (90 for a fresh quote, 40 for a stale one), so trust is earned and lost on the public
record with no manual steps. The dashboard shows the rule, a card per service (average, count,
payable since, trend) and the ratings.

**Pinned registries.** The ERC-8004 registries are upgradeable contracts run by a third party.
`config/erc8004.json` pins their proxy and implementation addresses. Every run checks the pins
first: on any change it **exits 4 before paying anything**, and the dashboard says the registry changed and the demo is paused for review. Accepting a new implementation is a deliberate owner change
to the pin.

**Owner keys.** Registering the services (`register-services`) uses new keys:
- the services owner;
- the reliable, flaky and newcomer payees;
- 001's payee key, used once.

They live only in a local `.env` (see `.env.example`), like the operator key. They are never in
CI, which still holds only the agent key.

**中文简介**：钱包现在也可以付款给不在白名单上的服务，但前提是该服务拥有 ERC-8004 链上身份，且运营者信任的评价者给出的平均分 ≥ 70、评价数 ≥ 3。检查在 `authorize` 内部于链上完成，资金动用前就做出决定。评价只能由钱包本身针对**已结算**的付款给出，因此无法伪造。冒用他人身份或没有身份的服务会被拒绝。演示中，可靠的服务赢得信任，不稳定的服务失去信任，新服务逐步获得信任，一切都记录在公开的链上。

## Repository

| Path | What |
| --- | --- |
| `contracts/` | Foundry: `PolicyWallet`, `PolicyWalletFactory` (EIP-1167 clones), unit, fuzz, invariant and fork tests |
| `packages/agent/` | SDK (`createPolicyWalletSigner`, `payUrl`) and the `agent-wallet` CLI |
| `packages/service/` | The x402-paid demo API (Hono on Cloudflare Workers) |
| `apps/dashboard/` | The public dashboard at demo.yunshu.ai (English `/`, Chinese `/zh/`) |
| `scripts/` | `snapshot.ts` (chain → `history.json`), `check-reputation.ts` (dashboard numbers = registry), `export-abi.ts`, the x402/ERC-1271 spike |
| `config/` | `deployments.json` (public addresses), `payees.json` (labels), `erc8004.json` (pinned registries), `services.json` (demo service identities) |
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
`set-daily`, `pause`, `unpause`, `withdraw`, `set-reputation`, `trust-reviewer` (operator);
`register-services` (services owner, local only); `pay [--rate]`, `run-scenario`,
`release-expired` (agent); `status`, `reputation` (read-only). Every command refuses to run on
any chain but Base Sepolia. Exit codes: `0` ok, `1` wrong network or config, `2` unexpected
outcome, `3` insufficient funds, `4` an ERC-8004 registry changed (nothing paid).

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
