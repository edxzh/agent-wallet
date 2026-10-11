# Security Review: JobEscrow (T008)

**Scope**: `contracts/src/JobEscrow.sol`, `contracts/src/IJobEscrow.sol` as of commit `c0bc294`
(branch `004-agent-hires-agent`), and how they use `PolicyWallet` (unchanged) and Base Sepolia
USDC (FiatToken v2.2). **Date**: 2026-10-12. **Reviewer**: Claude, who also wrote the
contract: a self-review, not an independent audit. An independent review is recommended before
any real-money use (constitution I already forbids mainnet without one).

**Method**: line-by-line read of every external function against the spec's requirements
(FR-001 – FR-006), the constitution (I – IV), and these attacker models: a compromised hiring
agent key, a hostile worker, a hostile "client" contract posing as a wallet, a front-runner who
sees signatures in the mempool or in calldata, a silent party (worker, hirer, arbiter), and the
token itself refusing a transfer (blacklist, pause).

## Findings

| # | Severity | Finding | Status |
|---|---|---|---|
| F1 | High (liveness) | A payout the token refuses freezes the job for ever | Fixed, tested (mock and real USDC) |
| F2 | Medium | The worker can be the arbiter, or the escrow itself | Fixed, tested |
| F3 | Low | The arbiter is fixed at open; an operator change doesn't move it | Accepted, documented |
| F4 | Low | `recoverSurplus` trusts the owner to return front-run money to the right wallet | Accepted, documented |
| F5 | Info | A compromised hiring-agent key can pay allowed workers for junk | Accepted (same as the wallet) |
| F6 | Info | A silent arbiter refunds the hirer even if the work was good | Accepted (spec US3) |

### F1. A payout the token refuses freezes the job for ever (High, liveness)

`_close` pays with `safeTransfer`, which reverts if USDC refuses the transfer: Circle can
blacklist an address, and FiatToken can be paused. Then:

- a delivered job whose worker is blacklisted can't be accepted, settled for the worker, or timed
  out (`REVIEW_TIMEOUT` always pays the worker), so after the review window it is stuck: nobody
  can ever close it, and the hirer can't get a refund either;
- the same for refunds to a blacklisted hiring wallet.

This breaks US3 ("every job ends, whoever goes silent") and FR-003.

**Fix**: close first, pay second, and never let a refused payment undo the close. `_close` marks
the job closed with its outcome and tries the transfer (`trySafeTransfer`). If the token refuses,
the amount is credited to the recipient (`owed[to]`) and `PaymentDeferred(jobId, to, amount)` is
emitted; anyone can later call `withdrawOwed(to)` to send it once the token allows
(`OwedWithdrawn`), and while it still refuses that call reverts and keeps the credit. Owed money
stays in `held`, so it is never surplus. A `JobClosed` followed by a `PaymentDeferred` in the same
transaction means "decided, not yet paid".

A caller can't force a deferral by starving the transfer of gas: a starved call leaves only 1/64
of its gas, too little for the deferral's storage write, so the whole call reverts and the job is
unchanged. A floor (`gasleft() ≥ 50 000` after a refusal) keeps this true even if the token's
transfer became very expensive.

**Tests**: `JobEscrow.deferred.t.sol` closes along all six outcomes with the recipient
blacklisted (closed, deferred, held unchanged, not recoverable as surplus, withdrawal reverts
while blocked, pays once after), sweeps `claimTimeout` gas from 20k to 400k, and adds up owed
money across jobs. The invariant handler blacklists and unblacklists recipients at random and
withdraws; `held == unclosed prices + owed` holds. `Escrow.fork.t.sol` does the same on Circle's
real FiatToken with its blacklister (impersonated on the fork; nothing broadcast).

### F2. The worker can be the arbiter, or the escrow itself (Medium)

`open` checks `worker != client` but not:

- `worker == arbiter` (the operator): the operator would judge a dispute about paying itself;
- `worker == address(this)`: the escrow is an allowed payee of the hiring wallet, so
  `checkPayee` passes; "paying the worker" then moves nothing, `held` drops, and the price turns
  into surplus that only the owner can move.

**Fix**: both are `InvalidTerms` (`JobEscrow.deferred.t.sol`, `test_WorkerCantBeTheArbiterOrTheEscrow`).

### F3. The arbiter is fixed at open (Low)

`open` requires `arbiter == client.operator()` at that moment and stores it. If the operator key
is rotated later, the old key still settles that job's dispute. **Accepted**: terms must not
change under a worker after it agreed by delivering; documented in the spec. The operator should
let open jobs close before rotating.

**Not independent in this demo**: one owner operates both the hiring wallet and, later, the worker
wallet (T010), so the arbiter settles disputes about paying a wallet it also runs. That is
unavoidable with a single owner and is stated in the spec; a real deployment needs workers
operated by someone else.

### F4. `recoverSurplus` trusts the owner (Low)

Money that arrives without a job (a front-run `transferWithAuthorization`, or a plain transfer)
can be sent anywhere by the owner (the deployer, which is the operator). It can never touch `held`
(invariant-tested). **Accepted**: the escrow can't tell which wallet a front-run payment came from
without trusting that wallet's own records, which a fake wallet could forge (plan R3). Documented:
the owner returns such money to the wallet whose nonce was used, visible on the record.

### F5. A compromised hiring-agent key (Info)

With the agent key, an attacker can open jobs to workers the wallet allows, deliver junk from a
worker it also controls, and accept. That is bounded exactly as a compromised key is in 001/002:
the cap, the budgets, the payee rules (now also for the worker), and the operator's pause.

### F6. A silent arbiter refunds the hirer (Info)

After a dispute, if the arbiter doesn't rule within the window, the hirer is refunded
(`ARBITER_TIMEOUT`), even if the worker was right. This is the spec's choice (money not agreed to
be owed goes back to the payer); the worker is protected by choosing to work only for operators it
trusts.

## Checked, no issue

- **Reentrancy**: every function that moves money is `nonReentrant`; state is written before the
  transfer in `_close`; `deliver` and `reject` make only `staticcall`s. USDC calls the hiring
  wallet's `isValidSignature` with `staticcall` (SignatureChecker), so a hostile wallet can't
  re-enter there either.
- **Permissions**: `open`, `accept`, `reject` need the hiring wallet's current agent (read with a
  bounded `staticcall`; an account with no code, a revert, or a malformed answer is address(0),
  which never matches a caller); `deliver` the worker or its wallet's agent; `resolve` the stored
  arbiter; `recoverSurplus` the immutable owner. Unit tests cover the agent, the worker, the
  operator and strangers for each.
- **Funding**: the escrow pulls exactly `amount` (balance delta checked) with the wallet's own
  reserved digest, so it can't be made to credit more than arrived; a fake wallet can only fund a
  job with its own real tokens.
- **Front-running**: `open` requires the hiring agent as caller, so seeing the signature lets an
  attacker at most submit the transfer early (F4), never open a job with other terms.
- **Time**: one boundary per window (fuzz-tested at every moment); every timestamp fits in its
  type (deliverBy ≤ now + 30 days, windows ≤ 30 days).
- **Arithmetic**: `amount ≤ uint128`; `held` only grows by what arrived and shrinks by what closed
  (invariant-tested); `balance − held` can't underflow while the invariant holds.
- **Job ids**: `keccak256(client, nonce)`; an EIP-3009 nonce is single-use per authorizer, and a
  second `open` for the same id reverts before any transfer.
- **Chain**: the constructor refuses any chain but Base Sepolia (and 31337 for tests).
