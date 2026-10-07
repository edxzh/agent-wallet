<!--
Sync Impact Report
==================
Version change: (unversioned template) → 1.0.0
Bump rationale: First ratification. Every placeholder replaced with concrete principles.

Principles (template slot → adopted title):
  - [PRINCIPLE_1_NAME] → I. Testnet Only (NON-NEGOTIABLE)
  - [PRINCIPLE_2_NAME] → II. Rules Enforced On-Chain, Refusals on the Record
  - [PRINCIPLE_3_NAME] → III. Proven Contracts (NON-NEGOTIABLE)
  - [PRINCIPLE_4_NAME] → IV. Keys Stay Where They Belong
  - [PRINCIPLE_5_NAME] → V. Zero Running Cost
Added principles:
  - VI. Standards Over Inventions
  - VII. A Dashboard Anyone Can Read
Added sections:
  - Technology & Deployment Constraints
  - Development Workflow & Quality Gates

Templates requiring updates:
  ✅ .specify/templates/plan-template.md: Constitution Check is filled at plan time; no edit
  ✅ .specify/templates/spec-template.md: no mandatory section added; no edit
  ✅ .specify/templates/tasks-template.md: tests optional by default; Principle III makes
     contract tests mandatory, which feature 001's tasks already include; no edit
  N/A README / agent guidance files: none to update

Follow-up TODOs: none. specs/001-agent-wallet-demo/plan.md was checked against the yunshu.ai
website constitution plus plan-level gates. Those gates are now Principles I–V here, so the
plan's Constitution Check still holds.
-->

# Agent Wallet Constitution

## Core Principles

### I. Testnet Only (NON-NEGOTIABLE)

- All code MUST run only on Base Sepolia (chain id 84532) with test funds of no real-world
  value.
- Every script, CLI command, deploy script and service MUST check the chain id first and refuse
  to run on any other network.
- Every public surface (README, dashboard, API) MUST say "test network only, no real money".
- Moving to mainnet is a MAJOR amendment and needs its own security review and an explicit
  owner decision.

**Rationale**: This is a public demo. A configuration slip must never be able to touch real
funds.

### II. Rules Enforced On-Chain, Refusals on the Record

- Spending rules (per-payment cap, daily budget, task budgets, allowed payees, pause) MUST be
  enforced by the wallet contract at the moment of authorization, not by an off-chain service
  the agent could bypass.
- A policy refusal MUST NOT revert. It MUST emit an event with exactly one reason and move no
  funds, so refusals are publicly verifiable.
- Only the operator may change rules. The agent's key MUST NOT be able to raise its own limits.
- Contract events are the public record. Their shapes are a public interface, and changing one
  is a breaking change.

**Rationale**: The product's promise is that limits can't be bypassed and that everything is
traceable, including what was blocked.

### III. Proven Contracts (NON-NEGOTIABLE)

- Every refusal reason MUST have a fuzz test showing no funds move and the right reason is
  emitted.
- Invariant tests MUST show spend never exceeds any limit and no nonce is used twice, across
  random call sequences.
- Every operator-only function MUST have a test showing it reverts for the agent and for
  strangers.
- Use audited library code (OpenZeppelin) for signatures, clones and interfaces. No hand-rolled
  cryptography.
- Contract changes merge only with these tests passing in CI.

**Rationale**: Tests are the only evidence a reader can check that the safety claims hold.

### IV. Keys Stay Where They Belong

- The operator key MUST stay on the owner's machine. It MUST never appear in CI, logs, commits,
  issues or chat.
- The agent key may live only in a local `.env` (git-ignored) and in GitHub Actions secrets
  added by the owner.
- Code MUST never print, log or send a private key. Errors show addresses, never keys.
- `.env` files are git-ignored. Only `.env.example` with empty values is committed.

**Rationale**: Even on testnet, leaked keys teach bad habits, and the same code may one day hold
real funds.

### V. Zero Running Cost

- Running the demo MUST cost $0 a month: free tiers only (Cloudflare Pages and Workers, GitHub
  Actions for public repos, public RPC, free facilitator).
- No paid API, RPC plan, database or hosted indexer without an explicit owner decision recorded
  as an amendment.
- Schedules and polling MUST stay well inside free-tier limits (scheduled runs no more often
  than hourly, dashboard polling no faster than every 10 s).

**Rationale**: The demo should be able to run indefinitely without anyone paying for it.

### VI. Standards Over Inventions

- Payments MUST use the x402 protocol, preferring its standard `exact` scheme. A custom scheme is
  allowed only when a recorded test shows the standard one can't work, as in research R2.
- Prefer established standards and libraries: EIP-3009, ERC-1271, EIP-1167, viem and the
  official `@x402/*` packages.
- Every new dependency is justified in the plan's Complexity Tracking.

**Rationale**: A demo built on standards proves something about the real ecosystem. A bespoke
protocol only proves itself.

### VII. A Dashboard Anyone Can Read

- The dashboard MUST be public, need no sign-in or wallet, and work on phone and desktop.
- It MUST be in English (`/`) and Chinese (`/zh/`), with identical content keys, matching
  yunshu.ai.
- It MUST render its history without JavaScript. Live updates are an enhancement.
- Refusal reasons and limits MUST be in plain language a non-technical visitor understands.
- It keeps yunshu.ai's budgets: Lighthouse ≥ 90, first-screen JS ≤ 50 KB gzip, reduced motion
  respected.

**Rationale**: The audience is prospective clients and investors, not only developers.

## Technology & Deployment Constraints

- **Network**: Base Sepolia (84532), Circle test USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e`,
  x402.org facilitator.
- **Stack**:
  - contracts: Solidity ^0.8.24 with Foundry and OpenZeppelin Contracts;
  - agent and scripts: TypeScript on Node 22 with viem and `@x402/*`;
  - paid service: Hono on Cloudflare Workers;
  - dashboard: Astro static on Cloudflare Pages.
- **Hosting**: dashboard at `demo.yunshu.ai`, API at `api.demo.yunshu.ai`. Deploys use
  Cloudflare's Git integrations, so no Cloudflare token is in CI.
- **Data**: on-chain state and events are the source of truth. The dashboard's `history.json`
  is a rebuildable cache, committed by the scheduled job.

## Development Workflow & Quality Gates

- **CI on every push and PR**:
  - contract build and tests (unit, fuzz, invariant);
  - TypeScript tests;
  - dashboard build, content-parity check, size budget and smoke tests.
- **On-chain steps** (deploys, scenario runs) only after the contract tests pass.
- **Security review** of `contracts/src/` before the demo is announced, and after any change to
  `authorize`, `isValidSignature` or `release`.
- **Owner steps** (faucet funding, adding secrets, Cloudflare setup, making things public) are
  never done without the owner. Claude prepares them and the owner performs or approves them.

## Governance

- This constitution supersedes conflicting guidance in specs, plans and tasks. A conflict is
  resolved by amending one of them explicitly, never by silently diverging.
- **Amendments**: propose the change with its rationale, update this file with
  `/speckit-constitution`, record a Sync Impact Report, and propagate it to affected templates
  and specs in the same commit.
- **Versioning** (semantic):
  - MAJOR: removing or redefining a principle, mainnet, or a change of chain or core stack.
  - MINOR: a new principle or materially expanded guidance.
  - PATCH: clarifications.
- **Compliance**: every `/speckit-plan` passes the Constitution Check against Principles I–VII
  before research and after design. Violations go in Complexity Tracking with a justification,
  or the plan is rejected.

**Version**: 1.0.0 | **Ratified**: 2026-10-07 | **Last Amended**: 2026-10-07
