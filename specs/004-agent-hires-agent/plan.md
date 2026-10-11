# Implementation Plan: An Agent Hires an Agent

**Spec**: [spec.md](spec.md) · **Date**: 2026-10-12

## Design (research)

### R1. Funding goes through the wallet's rules, unchanged

`PolicyWallet.isValidSignature` accepts only digests it reserved in `authorize`, and only for
USDC `TransferWithAuthorization(from = wallet)`. So the escrow is just a payee:

1. hirer agent: `wallet.authorize(nonce, payee = escrow, price, 0, validBefore, taskId)`: every
   rule runs; a refusal is a `PaymentRefused` event and nothing else happens;
2. hirer agent signs that digest;
3. hirer agent: `escrow.open(wallet, nonce, price, validBefore, signature, worker, worker claim,
   arbiter, deliverBy, reviewWindow, disputeWindow, specHash)`. The escrow first asks the wallet
   `checkPayee(worker, claim)` (002's free view): the wallet's payee rules only ever see the
   escrow, so without this an agent could "hire" anyone it may not pay. A refusal is a
   `JobRefused` event (constitution II) and no money moves. Otherwise the escrow calls
   `USDC.transferWithAuthorization(wallet → escrow)` itself and requires its balance to rise by
   exactly `price`.

The operator must allow the escrow as a payee (`setPayee(escrow, true)`).

### R2. Who may act for the hirer

`open`, `accept` and `reject` require `msg.sender == IPolicyWallet(client).agent()`, read at call
time. The signature only authorizes a transfer, not job terms, so without this check anyone who saw
the signature could open the job with their own worker. A fake "wallet" could name any agent, but
it can only control a job it really funded (the balance check), so it risks only its own money.

### R3. Front-running

If someone submits the signed transfer directly, the money arrives without a job and `open`
reverts. Nothing is stolen (it can only go wallet → escrow). `held` tracks money owed to jobs;
the owner (deployer = operator) can send `balance − held` anywhere, never more.

### R4. State machine

`Open → Delivered → (Closed | Disputed → Closed)`, `Open → Closed` on delivery timeout. Job id =
`keccak256(client, nonce)` (an EIP-3009 nonce is single-use per authorizer). Timeouts are per job,
bounded (deliver ≤ 30 days, review and dispute windows 1 hour to 30 days) so no job can be held
for ever. State errors revert (custom errors); the wallet's policy refusals stay events.

## Constitution Check

| Principle | Status |
|---|---|
| I. Testnet only | Pass. Constructor reverts unless chain id 84532 (or 31337 in tests). |
| II. Rules on-chain, refusals on record | Pass. Funding goes through `authorize`; every escrow step is an event. Escrow state errors revert: they are not policy refusals, and no money moves. |
| III. Proven contracts | Unit tests for every transition and permission, fuzz on amounts and timings, invariants on held vs balance and single close. OpenZeppelin SafeERC20 and ReentrancyGuard. |
| IV. Keys | Pass. No new key in this round; the worker key is a later owner step. |
| V. Zero cost | Pass. Same free testnet; a few transactions per scheduled run later. |
| VI. Standards | Pass. EIP-3009 + ERC-1271 as in 001; no new dependency. |
| VII. Dashboard | Later round. |

**Security review**: required before deploy (new contract that holds funds).

## Files

- `contracts/src/IJobEscrow.sol`, `contracts/src/JobEscrow.sol`
- `contracts/test/JobEscrow.t.sol`, `JobEscrow.fuzz.t.sol`, `JobEscrow.invariant.t.sol`
- `contracts/test/EscrowBase.t.sol`, `contracts/test/fork/Escrow.fork.t.sol` (real Base Sepolia
  USDC, nothing broadcast; passed 2026-10-12)
- `packages/agent/src/escrow.ts` + `test/escrow.test.ts` (mocked clients). CI's TypeScript job
  has no local chain and the chain guard rightly refuses 31337, so full jobs are driven in forge
  tests instead.

## Complexity Tracking

None. No new dependency.
