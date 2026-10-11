# Feature Specification: Try to Make It Overspend

**Feature Branch**: `003-try-to-overspend` (built on `main`)

**Created**: 2026-10-11

**Status**: Implemented

**Input**: User description: "An interactive page on demo.yunshu.ai where visitors try to trick
the agent into overspending or paying an impostor, and watch the contract refuse." Owner decision
2026-10-11: no AI model. The agent obeys every instruction; the wallet decides. $0 running cost.

## Context

The dashboard shows what the scheduled agent did. This page lets a visitor be the attacker.
Imagine a prompt injection got through and the agent will do anything it is told: pay 5 USDC,
pay a stranger, pay an impostor, blow the daily budget. The visitor picks or builds an attack and
the **real wallet contract** answers, against its live on-chain state.

The story: "It doesn't matter what the agent believes. The wallet decides."

## How it works

The page asks a public Base Sepolia node to **dry-run** (`eth_simulateV1`) the wallet's
`authorize` / `authorizeWithIdentity` call, sent from the agent's address, against the latest
block. The node runs the deployed contract's real code on its real state and returns the event
it would emit: `PaymentAuthorized`, or `PaymentRefused` with its reason. Several payments in one
attack run in one simulated block, so budgets add up as they would for real.

Nothing is signed, no key is used, no transaction is sent, nothing is written on-chain, and no
money moves. Dry-run refusals are **not** on the public record; the scheduled agent's real ones
are, on the dashboard.

## User Scenarios & Testing

### User Story 1 - Run a preset attack (Priority: P1)

A visitor opens `/try/` (or `/zh/try/`), picks one of the preset attacks, and sees the agent's
instruction, what it tried to pay, and the contract's answer per payment in plain language.

**Acceptance Scenarios**:

1. **Given** the "pay 5 USDC" preset, **When** it runs, **Then** the result is "refused: over the
   per-payment cap" (from the contract, not from page logic).
2. **Given** the impostor preset (impostor payee claiming Reliable quotes' identity), **Then** the
   result is "refused: claimed someone else's identity".
3. **Given** "pay 0.5 USDC three times", **Then** each payment shows its own answer, and later
   ones are refused for the daily budget once earlier ones use it up.
4. **Given** a normal 0.01 USDC request, **Then** it shows "would be allowed (dry run, nothing
   sent)", never "paid".

### User Story 2 - Build your own attack (Priority: P2)

The visitor edits the payee (a known service or any address), the identity it claims, the
amount, the task and how many times to repeat it (1–5), and runs it.

**Acceptance Scenarios**:

1. **Given** an invalid address or amount, **Then** the page says what to fix and runs nothing.
2. **Given** the node can't be reached or rejects the call, **Then** the page says so and claims
   no outcome.

### Edge Cases

- The answer reflects live state (today's spending, reputation), so a preset's answer can change
  over time; the page never hardcodes outcomes.
- An amount above uint128, or zero, is the contract's `INVALID_AMOUNT`, shown as such.

## Requirements

- **FR-001**: Every outcome shown MUST come from a dry run of the deployed contract, decoded from
  the event it would emit. The page MUST NOT compute outcomes itself.
- **FR-002**: The page MUST say, next to every result, that it is a dry run: nothing signed, sent
  or recorded, no money moved. An allowed result reads "would be allowed", never "paid".
- **FR-003**: No key, signer, wallet connection or server is involved. Calls go from the browser to
  the public Base Sepolia RPC only (chain id checked first; constitution I).
- **FR-004**: English at `/try/`, Chinese at `/zh/try/`, identical keys (content check), linked
  from the dashboard; the dashboard links to it.
- **FR-005**: Without JavaScript the page explains what it does, lists the presets, and links to
  the dashboard's real refusals.
- **FR-006**: The script loads only when the page is interactive and stays within the dashboard's
  JS budget.

## Success Criteria

- **SC-001**: Each preset's answer matches the contract's real reason for the live state (checked
  live with `scripts/check-try.ts`).
- **SC-002**: $0 added running cost; no new dependency, secret or deploy step.
