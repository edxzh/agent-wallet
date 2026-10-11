# Feature Specification: An Agent Hires an Agent (Escrow)

**Feature Branch**: `004-agent-hires-agent` (built on `main`)

**Created**: 2026-10-12

**Status**: Contract and tests done; on-chain steps pending (owner)

**Input**: User description: "Agent-to-agent payments: one agent hires another for a sub-task,
holds the money until the work is checked, then pays or refuses, all on-chain." Owner decisions
2026-10-12: the hirer checks the work and the operator settles disputes; this round is spec,
contract and tests, stopping before anything on-chain.

## Context

001 stops an agent overspending; 002 decides whom it may pay. Both assume the agent pays for
something it gets at once (an API answer). Hiring another agent is different: the work comes
later and may be bad. This feature adds an escrow, so the hirer's money is held until the work is
checked, and every step (hired, delivered, accepted, disputed, settled) is on the public record.

The story: "The agent can't overspend, and it only pays for work that was actually delivered."

## User Scenarios & Testing

### User Story 1 - Hire, deliver, accept (Priority: P1)

The hiring agent (`research-bot-01`) opens a job for a worker agent: the price, a deadline, a
review window and a hash of what it asked for. The money moves from its wallet into the escrow,
**through the wallet's normal rules** (cap, daily budget, task budget, allowed payees). The worker
delivers a result (its hash goes on-chain); the hirer checks it and accepts; the worker is paid.

**Acceptance Scenarios**:

1. **Given** a job within the wallet's rules, **When** the hirer opens it, **Then** the escrow
   holds exactly the price, and the wallet's spending counts it like any payment.
2. **Given** a job over the per-payment cap (or any other rule), **When** the hirer tries to open
   it, **Then** the wallet refuses it as today (`PaymentRefused`), and no job exists.
3. **Given** a worker the wallet may not pay (not allowed, no identity with the reputation rule on,
   an impostor identity), **When** the hirer opens the job, **Then** the escrow records
   `JobRefused` with the wallet's reason and no money moves.
4. **Given** a delivered job, **When** the hirer accepts, **Then** the worker receives the price
   and the job closes as `ACCEPTED`.

### User Story 2 - A dispute, settled by the operator (Priority: P1)

The hirer rejects a delivery within the review window. The job becomes **disputed** and only the
job's arbiter (the operator) can settle it: pay the worker or refund the hirer.

**Acceptance Scenarios**:

1. **Given** a delivered job, **When** the hirer rejects it with a reason hash, **Then** neither
   side can move the money; only the arbiter can.
2. **Given** a disputed job, **When** the arbiter rules, **Then** the money goes to the side they
   chose, and the record says it was the arbiter.

### User Story 3 - Nobody is stuck (Priority: P1)

Every job ends, whoever goes silent, and even if the token refuses to pay one side (the payout
is then owed, not stuck; security review F1).

1. Worker misses the deadline → anyone can refund the hirer (`DELIVERY_TIMEOUT`).
2. Hirer doesn't answer within the review window → anyone can pay the worker (`REVIEW_TIMEOUT`).
3. Arbiter doesn't rule within the dispute window → anyone can refund the hirer
   (`ARBITER_TIMEOUT`): money that was never agreed to be owed goes back to the payer.

### Edge Cases

- Someone submits the hirer's signed transfer before the hirer opens the job (front-running):
  the money lands in the escrow without a job. No job's money is affected; the escrow's owner can
  return such unattributed money (`recoverSurplus`), never money held for a job. The wallet's
  reservation counts as settled, so `release` won't return that budget.
- A refused `open` also publishes the funding signature (it is in the calldata), which anyone can
  then submit the same way. So the agent asks the wallet's `checkPayee` for free **before** it
  authorizes or signs anything (`hireAgent`), and the check inside `open` is the enforcement for a
  buggy or compromised agent.
- The hirer's wallet changes its agent key: the new agent controls the hirer's side from then on.
- The worker can't be the arbiter or the escrow itself (security review F2).
- The arbiter is the hiring wallet's operator at the time the job opens. In this demo one owner
  runs both the hiring wallet and the worker, so the arbiter is not independent of the worker:
  a real deployment would need separately operated workers.
- A refund returns money to the wallet but does not lower the day's spending (conservative: the
  budget counts what the agent committed, as with any payment).

## Requirements

- **FR-001**: Money enters the escrow only through the hiring wallet's `authorize` +
  EIP-3009 transfer, so the 001 limits (cap, daily and task budgets, pause) apply to the price.
  The wallet's payee rules would only ever see the escrow, so `open` also asks the hiring wallet
  whether it may pay the **worker** (`checkPayee`: allowlist, identity, reputation). If not, it
  emits `JobRefused` with the wallet's reason and moves no money; the wallet's reservation expires
  and `release` gives the budget back. A wallet that can't answer (no `checkPayee`) is a refusal.
  `PolicyWallet` is unchanged.
- **FR-002**: Only the hiring wallet's current agent can open a job and accept or reject it; only
  the worker (or, if the worker is a PolicyWallet, its current agent) can deliver; only the job's
  arbiter can settle a dispute, and `open` requires the arbiter to be the hiring wallet's
  operator, so a hirer can't judge its own dispute.
- **FR-003**: Each job closes exactly once, with one outcome (`ACCEPTED`, `REVIEW_TIMEOUT`,
  `ARBITER_PAID`, `DELIVERY_TIMEOUT`, `ARBITER_REFUNDED`, `ARBITER_TIMEOUT`), and its full price
  goes to exactly one side: paid at once, or, if the token refuses that payout (e.g. a
  blacklisted address), owed to that side and paid by `withdrawOwed` once the token allows.
- **FR-004**: Every step emits an event; the record is enough to replay each job.
- **FR-005**: The escrow never pays out more than it holds for jobs; surplus recovery can't touch
  held money.
- **FR-006**: Base Sepolia only (chain id checked in the constructor, as `PolicyWallet` does).

## Success Criteria

- **SC-001**: Unit, fuzz and invariant tests (constitution III) cover every transition, every
  permission and every timeout; invariants: held = sum of open jobs ≤ balance, no job paid twice.
- **SC-002**: The agent package can drive a full job (open, deliver, accept / reject) against a
  local chain.

## Out of scope (this round)

Testnet deploy, the worker's key and funding, the scheduled scenario and the dashboard section:
owner steps and a later round. Partial payments and multi-milestone jobs.
