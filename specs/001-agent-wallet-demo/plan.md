# Implementation Plan: Agent Wallet Demo

**Branch**: `002-agent-wallet-demo` (spec directory; code goes in a new repo) | **Date**: 2026-10-07 |
**Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/002-agent-wallet-demo/spec.md`

## Summary

Build a $0, testnet-only agent wallet that makes the website's Work section real.

- **Wallet**: each agent gets a `PolicyWallet` contract on Base Sepolia. The operator sets a
  per-payment cap, a daily budget, task budgets and allowed payees.
- **Refusals**: every attempt goes through `authorize()`, which **emits a refusal event instead
  of reverting**, so blocked payments are on the public record. Passing attempts reserve budget.
- **Payment**: the agent then pays through the **standard x402 `exact` scheme** with test USDC,
  using the wallet as an ERC-1271 signer (Design A). A first-task test confirms this works end
  to end; otherwise we fall back to a custom on-chain scheme (Design B), which meets the same
  spec.
- **Demo pieces**:
  - a paid demo API on a Cloudflare Worker;
  - a scripted agent run every 6 hours by GitHub Actions;
  - a bilingual static dashboard at `demo.yunshu.ai`, built from a committed history snapshot
    plus a live feed from the public RPC.

## Technical Context

**Language/Version**: Solidity ^0.8.24 (contracts); TypeScript 5/6 on Node 22 (agent, service,
scripts, dashboard)

**Primary Dependencies**:
- Foundry (forge/cast) and OpenZeppelin Contracts (`ECDSA`, `Clones`, `IERC1271`);
- viem 2.57;
- `@x402/fetch`, `@x402/evm`, `@x402/hono` 2.28 (x402 v2);
- Hono on Cloudflare Workers;
- Astro (dashboard, same stack as yunshu.ai).

**Storage**: on-chain contract state and events (source of truth). `history.json` snapshot
committed to the repo (derived cache). No database.

**Testing**:
- Foundry unit, fuzz and invariant tests (SC-001, SC-002);
- Vitest for the SDK, signer and snapshot decoder;
- a Base Sepolia end-to-end script (quickstart);
- Playwright smoke tests and the content-parity check for the dashboard (reused from yunshu.ai).

**Target Platform**: Base Sepolia (chain 84532); Cloudflare Pages (dashboard) and Workers
(service); GitHub Actions (cron); evergreen browsers.

**Project Type**: monorepo with contracts, SDK/CLI, web service and static web app.

**Performance Goals**: new activity on the dashboard ≤ 30 s (10 s polling); dashboard Lighthouse
≥ 90; first-screen JS ≤ 50 KB gzip.

**Constraints**:
- testnet only, with a chain-ID guard in every script;
- $0 a month on free tiers (SC-006);
- public RPC `eth_getLogs` ≤ 500 blocks per call (checked);
- operator key never in CI;
- refusals must be on-chain events, not reverts.

**Scale/Scope**: 1 operator, 1–3 agent wallets, ~3 paid calls and ~4 violations per 6-hour run;
about 2 contracts, 1 Worker route, 1 dashboard page in 2 languages.

**Unknowns**: none open for planning. Design A vs B is decided by the task 1 test (research R2),
and both satisfy the spec.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

*Update 2026-10-07: this repo now has its own constitution (Agent Wallet v1.0.0), whose Principles I–V formalise the plan-level gates below. The check still holds.*

The repo constitution (v1.0.1) governs the **yunshu.ai website**. This product is applied
against it as follows. Contract security has no governing principle, so this plan sets its own
gates (below) until a product constitution is ratified in the new repo (follow-up).

| Principle | Applies to the demo? | Pre-research | Post-design |
| --- | --- | --- | --- |
| I. Static-First, No Server | Main site only; products live on subdomains (I, last bullet) | ✅ Dashboard static; Worker allowed as a subdomain product | ✅ Dashboard is static HTML from a snapshot; Worker at `api.demo.yunshu.ai` |
| II. Bilingual Parity | Yes, dashboard (FR-018) | ✅ | ✅ `/` and `/zh/`, one template set, key-parity check reused |
| III. Progressive Enhancement | Yes, dashboard | ✅ | ✅ Full history renders from `history.json` with no JS; live feed is an enhancement (R7) |
| IV. Performance Budgets | Yes, dashboard | ✅ | ✅ viem lazy-loaded after first paint; budget script and Lighthouse CI reused |
| V. Accessible, Restrained Motion | Yes, dashboard | ✅ | ✅ Row-insert animation off under reduced motion; keyboard and contrast as on the site |
| VI. Minimal Dependencies | Yes | ⚠️ New dependencies | ✅ Justified below in Complexity Tracking |
| VII. Privacy by Default | Yes | ✅ No accounts, no tracking | ✅ Public chain data only; no visitor data collected |

**Plan-level gates for what the constitution doesn't cover:**
- **Security tests**:
  - Foundry fuzz tests cover every refusal reason, and the invariants (spend ≤ limits, no funds
    move on refusal, nonce used once) must pass in CI;
  - every operator function has an agent-must-revert test.
- **Testnet guard**: every script and the Worker check chain ID 84532 or exit.
- **Key handling**: the operator key stays local only. The agent key is a GitHub secret added by
  the owner.
- **Cost ceiling**: free tiers only; any paid service needs an explicit owner decision.

**Result**: PASS. No unjustified violations.

## Project Structure

### Documentation (this feature)

```text
specs/002-agent-wallet-demo/
├── plan.md  research.md  data-model.md  quickstart.md
├── contracts/
│   ├── policy-wallet.md   paid-service.md   agent-cli.md   dashboard.md
├── checklists/requirements.md
└── tasks.md            # /speckit-tasks
```

### Source Code (new repo `edxzh/agent-wallet`)

```text
contracts/                    # Foundry project
├── src/PolicyWallet.sol  src/PolicyWalletFactory.sol  src/Reason.sol
├── test/PolicyWallet.t.sol  test/Refusals.fuzz.t.sol  test/Invariants.t.sol  test/Erc1271.t.sol
└── script/Deploy.s.sol       # aborts unless chainid == 84532
packages/
├── agent/                    # SDK (createPolicyWalletSigner) + CLI (agent-wallet)
│   └── src/{signer,cli,scenario,chainGuard}.ts  test/
└── service/                  # Cloudflare Worker: x402 paid /quote (Hono)
    └── src/index.ts  wrangler.toml
apps/
└── dashboard/                # Astro static site, en / zh
    └── src/{pages,components,i18n,data/history.json,scripts/live-tail.ts}
scripts/
├── snapshot.ts               # incremental getLogs (500-block chunks) → history.json
└── spike-x402-1271.ts        # task 1: Design A vs B test
config/payees.json            # payee labels
.github/workflows/
├── ci.yml                    # forge test, vitest, dashboard checks
└── agent-run.yml             # cron every 6h: run-scenario → snapshot → commit history.json
```

**Structure decision**: an npm-workspaces monorepo in a **new public repo**, as the spec
assumes, so the website stays a static brand site and the Work section can link to the code.
Deploys:
- dashboard: Cloudflare Pages Git integration, rebuilt when `history.json` is committed;
- Worker: Cloudflare Workers Builds (Git integration), so no API token is in CI.

Superseded by constitution 1.1.0 (2026-10-10): the dashboard deploys from GitHub Actions with a
Pages-only token after CI passes, and the owner deploys the Worker with `wrangler deploy`.

## Risks & Follow-ups

- **Design A depends on the facilitator accepting ERC-1271** (R2c, documented but not yet tested
  end to end). Task 1 decides; Design B is designed and costs about the same.
- **Faucet limits**: test USDC and ETH faucets rate-limit. Small amounts (0.01 USDC per call)
  keep 20 USDC good for months. The owner tops up.
- **Public RPC limits** (500-block `getLogs`, rate limits): handled by the incremental snapshot.
  A free-tier RPC key is optional later.
- **Follow-ups**:
  - create the repo and move these specs;
  - ratify a product constitution;
  - owner funding and secrets;
  - update the website's Work section (feature 001) when shipped.

## Complexity Tracking

| New dependency | Why needed | Simpler alternative rejected because |
| --- | --- | --- |
| Foundry + OpenZeppelin (`ECDSA`, `Clones`, `IERC1271`) | Contracts need fuzz and invariant tests to prove SC-001/002; audited signature and clone code | Hand-rolled ECDSA/1271 is a security risk; Hardhat-only testing is slower and weaker at invariants |
| viem | Typed RPC, ABI encoding and event decoding for SDK, snapshot and live feed | Raw JSON-RPC plus hand ABI decoding is error-prone. viem is lazy-loaded in the dashboard |
| `@x402/fetch`, `@x402/evm`, `@x402/hono` | The x402 protocol itself (FR-008): 402 negotiation, EIP-3009 payloads, facilitator calls | Re-implementing x402 would make it non-standard |
| Hono on Cloudflare Workers | The paid service needs a server (402 responses, settlement) | No static alternative; Workers' free tier keeps it $0 |
