# Implementation Plan: Trusted Payees (Reputation-Gated Spending)

**Branch**: `002-trusted-payees-erc8004` (spec directory; work happens on `main` of
`edxzh/agent-wallet`) | **Date**: 2026-10-08 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/002-trusted-payees-erc8004/spec.md`

## Summary

Feature 001 stops the agent overspending. This feature decides **who it may pay**.

- **The rule**: `PolicyWallet` gains a reputation rule, enforced inside the same authorisation
  call as 001's rules. A payee that isn't allowlisted is paid only if:
  - it claims an ERC-8004 identity whose registered payment address matches;
  - and the live ERC-8004 Reputation Registry on Base Sepolia gives it an average of at least X
    from at least N **operator-trusted reviewers**.
- **Fail closed**: failures are refused as recorded events with five new reasons, never as
  reverts. Registry errors count as refusals.
- **Ratings**: after a settled paid call, the wallet itself is the reviewer. It publishes a
  deterministic 0–100 rating via `giveFeedback`, linked to the payment nonce. Ratings can only
  be made for the wallet's own settled, identity-checked payments, so the agent key can't
  manufacture reputation.
- **The demo story**: two scout wallets keep reputation fresh. The services are:
  - **reliable**;
  - **flaky**, which is always stale after 12 h;
  - **newcomer**, which opens after 36 h;
  - **impostor**.

  The flaky service is cut off for good within about 24 h. The newcomer becomes payable after
  about 2 days. 001's `/quote` also gets an identity, so every settled payment is rated.
- **The dashboard** shows identity cards, trusted averages that match the registry exactly, and
  a score trend from per-run snapshots.

## Technical Context

**Language/Version**: Solidity ^0.8.24 (contracts); TypeScript on Node 22 (agent, service,
scripts, dashboard). Same as 001.

**Primary Dependencies**: no new packages. Reused from 001:
- Foundry with OpenZeppelin 5.6.1;
- viem 2.57;
- `@x402/fetch`, `@x402/evm`, `@x402/hono` 2.28 (the `onBeforePaymentCreation` hook and
  `extra`);
- Hono and Astro.

ERC-8004 is integrated through two vendored minimal interfaces (research R1, R11).

**Storage**: on-chain. That's the `PolicyWallet` state and events, plus the external ERC-8004
Identity and Reputation registries, which are public and shared. `history.json` gains services,
the rule and reputation snapshots as a rebuildable cache. `config/services.json` and
`config/erc8004.json` hold the ids and pins.

**Testing**:
- Foundry unit, fuzz (each new reason, untrusted-review noise) and invariant tests (`rated ⇒
  settled ∧ identity`), with a mock registry;
- **fork tests** against the real registries at a pinned Base Sepolia block;
- Vitest for `scoreQuote`, the identity hook, `ratePayment` and `assertRegistriesPinned`;
- `check-reputation.ts` for dashboard consistency;
- the quickstart end-to-end on Base Sepolia.

**Target Platform**: Base Sepolia (84532), Cloudflare Workers and Pages, GitHub Actions. Same
as 001.

**Project Type**: extends 001's monorepo (contracts, SDK/CLI, Worker, static dashboard). No new
package.

**Performance Goals**:
- authorisation, including the registry reads, fits in about 3–5 M gas for at least 5 months of
  ratings (research R7);
- dashboard rule: 001's budgets (Lighthouse ≥ 90, first-screen JS ≤ 50 KB gzip);
- reputation polling no faster than every 30 s.

**Constraints**:
- testnet only, with chain guards;
- $0 a month;
- refusals are events, never reverts; registry failure fails closed;
- the registries are third-party upgradeable, so implementations are pinned and checked every
  run;
- new keys are local-only;
- 001's interface and `Reason` values are unchanged (append-only).

**Scale/Scope**:
- 3 wallets (1 gated, 2 scouts); 4 identities (001's quote, reliable, flaky, newcomer), plus impostor and anonymous routes;
- about 9 paid calls and 9 ratings per 6-hour run;
- 3–5 new contract functions, 5 Worker routes, 3 dashboard sections.

**Unknowns**: none open. The deployed ERC-8004 v2.0.0 ABI is verified (R1). The x402 hook and
`extra` handling are verified in the installed packages (R3).

**Dependency on 001**:
- This feature is implemented after 001's MVP (US1–US3);
- it works under either payment design from 001 (R2: Design A or B). Only `rate`'s settlement
  check differs.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*
Against **Agent Wallet Constitution v1.0.0**.

| Principle | Pre-research | Post-design |
| --- | --- | --- |
| I. Testnet only | ✅ Registries used only on Base Sepolia | ✅ Chain guard on every new command. Registry addresses are pinned for 84532 only. Dashboard banner unchanged |
| II. Rules on-chain, refusals on the record | ✅ FR-003 puts the check in authorisation | ✅ Check inside `authorizeWithIdentity`. 5 reasons appended to `Reason`, emitted via 001's `PaymentRefused`. Registry failure becomes a recorded refusal, not a revert (low-level `staticcall`). Only the operator sets the rule and reviewers (`RuleChanged`). New events added; 001's event shapes unchanged, so nothing breaks |
| III. Proven contracts | ✅ | ✅ Fuzz per new reason; fuzz with untrusted noise (SC-002); invariants for ratings; operator-only revert tests; registry-failure mocks; fork tests at a pinned block. registry reads use an assembly `staticcall` with a fixed-size output (no OZ `Address`, which reverts on failure); no hand-rolled crypto. Fork tests at a pinned block were checked against the public RPC: it serves historical state |
| IV. Keys stay where they belong | ⚠️ New keys needed (services owner, payees) | ✅ All new keys are local-only, used by owner-run `register-services`. CI still holds only the agent key. `.env.example` gains empty entries with a "never in CI" note |
| V. Zero running cost | ✅ | ✅ Shared public registries (no hosting), on-chain `data:` registration files, routes on the same Worker, the same 6-hour cron. Gas in test ETH only (about 0.00002 ETH per authorisation) |
| VI. Standards over inventions | ✅ ERC-8004 is the standard for agent identity and reputation | ✅ with one justified extension: the identity travels in x402 `extra.erc8004`, because x402 has no identity extension yet. It uses ERC-8004's own `{agentRegistry, agentId}` format. Recorded in Complexity Tracking |
| Workflow: security review | ✅ | ⚠️ Gate: `authorizeWithIdentity`, `rate` and the changed check order are new authorisation code. The constitution requires a security review of `contracts/src/` before this feature's contract changes deploy |
| VII. A dashboard anyone can read | ✅ | ✅ Rule and reasons in plain en/zh, identity cards rendered from `history.json` without JS, averages verbatim from the registry |

**Result**: PASS. One item is justified below (VI). There's one owner step (new local keys, IV) and one gate before deploy (security review).

## Project Structure

### Documentation (this feature)

```text
specs/002-trusted-payees-erc8004/
├── spec.md  plan.md  research.md  data-model.md  quickstart.md
├── contracts/
│   ├── policy-wallet-reputation.md   paid-services.md   agent-cli.md   dashboard.md
├── checklists/requirements.md
└── tasks.md            # /speckit-tasks
```

### Source Code (changes to 001's layout)

```text
contracts/
├── src/
│   ├── PolicyWallet.sol            # + reputation rule, authorizeWithIdentity, rate, checkPayee
│   ├── Reason.sol                  # + reasons 8–12 (appended)
│   └── interfaces/IERC8004.sol     # vendored minimal Identity + Reputation interfaces
└── test/
    ├── mocks/MockErc8004.sol       # identity + reputation mock (configurable revert / gas burn / garbage)
    ├── Reputation.t.sol            # unit: setters, check order, rate preconditions
    ├── Reputation.fuzz.t.sol       # one fuzz per new reason + untrusted-noise fuzz
    ├── Reputation.invariant.t.sol  # rated ⇒ settled ∧ identity; rule never on with 0 reviewers
    └── fork/Erc8004.fork.t.sol     # real registries at a pinned block
packages/agent/src/
├── identity.ts                     # onBeforePaymentCreation hook → agentId for the signer
├── scoring.ts                      # scoreQuote (research R6)
├── rate.ts                         # ratePayment
├── registries.ts                   # pinned addresses, ABI, assertRegistriesPinned
└── cli.ts                          # + register-services, set-reputation, trust-reviewer, reputation; scenario extended
packages/service/src/
└── services.ts                     # reliable / flaky / newcomer / impostor / anonymous routes, extra.erc8004
apps/dashboard/src/
├── components/{TrustRule,ServiceCard,Sparkline}.astro
└── i18n/{en,zh}.json               # + rule, service and reason.* strings
scripts/
├── snapshot.ts                     # + services, summaries, snapshots, rated/statusChanged rows
└── check-reputation.ts             # FR-015 consistency check (CI)
config/
├── erc8004.json                    # proxies, pinned implementations, version
└── services.json                   # ids, payees, routes, labels, opensAt/degradeAt
```

**Structure decision**: extend 001's packages in place, with no new workspace.
- The wallet changes stay in `PolicyWallet` (one contract, one check order) rather than a
  separate module contract, so the "one place enforces every rule" guarantee holds.
- The demo services share 001's Worker.

## Risks & Follow-ups

- **Third-party upgradeable registries** (R8): pinned implementations, a per-run slot check
  (exit 4) and fork tests at a pinned block. Accepting an upgrade is an explicit owner decision.
- **Gas growth of `getSummary`** (R7): it reaches the 5 M budget after about 1,900 ratings per
  service, roughly 5 months. The dashboard warns above 1,500. The fix is rotating scout
  reviewers. It fails closed.
- **The story's timing depends on the schedule** (R5): GitHub cron can be late. The arithmetic
  has margin: crossing is expected around 24 h against a 3-day target.
- **Compatibility with 001's scenario**: with the rule on, the gated wallet refuses an
  unlisted, identity-less payee with reason 8, not 3. 001's "payee not allowed" probe therefore
  moves to `scout-02` (rule off), and every expected outcome is computed from `checkPayee`
  (research R5). 001's contract interface is unchanged.
- **Scout funding**: each scout spends about 0.12 USDC a day. Funded with 10 USDC, each lasts
  about 80 days. Top up monthly from the Circle faucet; the run stops cleanly with exit 3 if
  funds run out.
- **ERC-8004 is a draft**: the spec may move. We depend only on the five verified functions and
  two events.
- **Owner steps**:
  1. generate and fund the services-owner key, and generate 3 payee keys. Have 001's
     `SERVICE_PAYEE` key ready to sign once;
  2. run `register-services`;
  3. set the Worker vars;
  4. create and fund 2 scout wallets with 10 USDC each;
  5. run the security review before deploying the contract changes.
- **Constitution drift, outside this feature**: the constitution says deploys use Cloudflare
  Git integrations, but `demo.yunshu.ai` is currently a manual upload (project
  `agent-wallet-demo`). Move it to a Git-connected project before this feature's dashboard work
  ships. **Resolved 2026-10-10 by amending the constitution (1.1.0)** instead: the dashboard
  deploys from GitHub Actions with a Pages-only token, gated on CI (T054).

## Complexity Tracking

| Item | Why needed | Simpler alternative rejected because |
| --- | --- | --- |
| Custom `extra.erc8004` key in x402 payment requirements (constitution VI) | The wallet must know which identity a payee claims in order to verify its address and reputation, and x402 has no identity extension (`@x402/extensions` 2.28 has none) | A reverse lookup by `payTo` doesn't exist in the registry. An HTTP header sits outside the payment requirements. Writing a new upstream extension is out of scope for a demo. The format uses ERC-8004's own `{agentRegistry, agentId}` fields so it can migrate mechanically |
| Assembly `staticcall` with a fixed-size output buffer and manual decoding for registry reads | Constitution II needs "refuse, never revert", even against a hostile registry upgrade | `try/catch` reverts on malformed return data. A plain `staticcall` copies unbounded return data, so a huge payload could exhaust gas. OZ `Address` reverts on failure. Each would remove the refusal from the public record |
| Two extra demo wallets (scouts) | All-time averages need continued ratings after the gated wallet stops paying. A newcomer needs reviews before it can be paid (R5) | Manual allowlist edits break FR-017. A single wallet would freeze the flaky service's score and could never bootstrap the newcomer |
