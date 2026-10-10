---

description: "Task list for Trusted Payees (Reputation-Gated Spending)"
---

# Tasks: Trusted Payees (Reputation-Gated Spending)

**Input**: Design documents from `specs/002-trusted-payees-erc8004/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Builds on feature 001.** Paths are relative to the repo root of `edxzh/agent-wallet`. The
files named here are created by feature 001's tasks, and this feature extends them:
- `contracts/src/PolicyWallet.sol`, `contracts/src/Reason.sol`, `packages/agent/src/signer.ts`
  and `cli.ts`;
- `packages/agent/src/scenario.ts`, `packages/service/src/index.ts`, `scripts/snapshot.ts`;
- the dashboard components and `.github/workflows/agent-run.yml`.

**Tests**: included. Constitution III makes fuzz, invariant and operator-revert tests a merge
gate, and the quickstart scenarios are the acceptance checks. Write each story's tests first and
watch them fail.

**Owner tasks**: tasks marked **(owner)** need Edward:
- generating and funding keys;
- running scripts that use local-only keys;
- Cloudflare and GitHub settings.

Claude prepares everything around them. No new key ever goes to CI (constitution IV).

**Design A / B**: follow whatever feature 001's T010 recorded in its `research.md` R2.
- Where a task says "(B: …)", the Design B variant replaces it.
- The only real difference is how `rate` decides that a payment is "settled".

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: The user story (US1–US6 in spec.md)

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: confirm the prerequisites, and add the configuration and keys this feature needs.

- [X] T001 Confirm feature 001's MVP is done. Record the result at the top of `specs/002-trusted-payees-erc8004/tasks.md` (Notes section). Check:
  - 001 tasks T010–T040 are checked;
  - Design A or B is recorded in `specs/001-agent-wallet-demo/research.md` R2;
  - `forge test` passes in `contracts/`.

  If not, stop: this feature can't start.
- [X] T002 [P] Add empty entries to `.env.example`, each commented "local only, never in CI (constitution IV)":
  - `SERVICES_OWNER_PRIVATE_KEY=`, `PAYEE_RELIABLE_PRIVATE_KEY=`, `PAYEE_FLAKY_PRIVATE_KEY=`, `PAYEE_NEWCOMER_PRIVATE_KEY=`;
  - `SERVICE_PAYEE_PRIVATE_KEY=`, with the comment "used once by register-services to give 001's /quote an identity";
  - `PAYEE_IMPOSTOR=`, with the comment "address only".
- [X] T003 [P] Create `config/erc8004.json` with:
  - `chainId: 84532`;
  - `identity: { proxy: "0x8004A818BFB912233c491871b3d84c89A494BD9e", implementation: "0x7274e874CA62410a93Bd8bf61c69d8045E399c02" }`;
  - `reputation: { proxy: "0x8004B663056A597Dffe9eCcC1965A193B7388713", implementation: "0x16e0FA7f7C56B9a767E34B192B51f921BE31dA34" }`;
  - `version: "2.0.0"`;
  - `implementationSlot: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"`;
  - `forkBlock`: the current Base Sepolia block number at the time of the task (`cast block-number --rpc-url https://sepolia.base.org`).

  Values are from research R1 and R8.
- [X] T004 [P] Create `config/services.json` with one entry per service: `quote`, `reliable`, `flaky`, `newcomer`, `impostor` and `anonymous`. Each entry has:
  - `key`, `route` (`/quote`, `/s/reliable/quote`, `/s/flaky/quote`, `/s/newcomer/quote`, `/s/impostor/quote`, `/s/anonymous/quote`);
  - `agentId: null`, `payTo: null`;
  - `label: { en, zh }`, for example `{ "en": "Reliable quotes", "zh": "可靠报价" }`;
  - `claims`: `"self"` for quote, reliable, flaky and newcomer; `"reliable"` for impostor; `null` for anonymous;
  - `degradeAt: null` (flaky only) and `opensAt: null` (newcomer only).

  Shape per data-model.md, "Service identity".
- [X] T005 **(owner)** Generate keys and fund the services owner:
  - run `cast wallet new` 4 times (services-owner, reliable payee, flaky payee, newcomer payee), plus one more and use only its address for the impostor;
  - put them in `.env`, never in chat;
  - fund the **services-owner** with Base Sepolia ETH (0.01 ETH is plenty; the payees need none);
  - have 001's `SERVICE_PAYEE` private key ready in `.env` as `SERVICE_PAYEE_PRIVATE_KEY`.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: the shared types, the ERC-8004 interfaces, a faithful mock registry and the pinned-registry check that every story uses.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T006 [P] Create `contracts/src/interfaces/IERC8004.sol`. It holds `IERC8004Identity` (`getAgentWallet`) and `IERC8004Reputation` (`getSummary`, `giveFeedback`, `getLastIndex`), with signatures exactly as in contracts/policy-wallet-reputation.md, plus a comment with the pinned proxy addresses and "v2.0.0, verified 2026-10-08".
- [X] T007 [P] Extend `contracts/src/Reason.sol` **by appending only**: `PAYEE_IDENTITY_UNVERIFIED` (8), `PAYEE_IDENTITY_MISMATCH` (9), `REPUTATION_UNAVAILABLE` (10), `NOT_ENOUGH_TRUSTED_REVIEWS` (11), `PAYEE_REPUTATION_TOO_LOW` (12).
  - Add a test to `contracts/test/PolicyWallet.t.sol` asserting `uint8(Reason.INSUFFICIENT_FUNDS) == 7` and `uint8(Reason.PAYEE_REPUTATION_TOO_LOW) == 12`, so 001's values can't shift.
  - Create `contracts/src/IPolicyWalletReputation.sol` with the events and functions from contracts/policy-wallet-reputation.md.
  - Done: the value-stability test is `test_reasonValuesAreStable` in `contracts/test/Reputation.t.sol` (with the other 002 tests) rather than `PolicyWallet.t.sol`.
- [X] T008 [P] Create `contracts/test/mocks/MockErc8004.sol`, implementing both interfaces with the **same algorithm as the deployed v2.0.0 source** (research R1):
  - ids starting at 0;
  - `agentWallet` defaults to the registrant;
  - a self-feedback ban for the owner and approved operators;
  - an empty client list reverts;
  - revoked entries are skipped;
  - normalisation to 18 decimals, a truncating average, and the mode of decimals.

  Add test-only modes `setFailure(Mode)` with `NONE | REVERT | BURN_GAS | GARBAGE | HUGE_RETURN`:
  - `GARBAGE` returns 32 bytes of `0xff`;
  - `HUGE_RETURN` returns 1 MB.
  - Done: separate `setIdentityFailure` / `setSummaryFailure`. `HUGE_RETURN` leads with a plausible *passing* answer, so only an exact `returndatasize()` check refuses it; the identity read returns 4 KB instead of 1 MB because its 100k gas budget can't build 1 MB (the call would just fail). Mutation-checked: a `>=` size check now fails the tests.
- [X] T009 [P] Create `packages/agent/src/registries.ts`:
  - viem ABIs for the five registry functions and the `NewFeedback` and `FeedbackRevoked` events;
  - the addresses loaded from `config/erc8004.json`;
  - `assertRegistriesPinned(client)`, which reads both proxies' implementation slot with `getStorageAt` and calls `getVersion()`, then throws `RegistryChangedError { registry, expected, actual }` on any mismatch.

  Test it in `packages/agent/test/registries.test.ts` with a mocked client: a match passes; a changed slot or version throws.
- [X] T010 Create `contracts/test/fork/Erc8004.fork.t.sol` using `vm.createSelectFork("base_sepolia", forkBlock)`, with `forkBlock` read from `config/erc8004.json` via `vm.readFile` and `vm.parseJson`. Assert:
  - both proxies' implementation slots equal the pins, and `getVersion() == "2.0.0"`;
  - **mock parity**: register a fresh agent on the fork from a test owner, `giveFeedback` from 3 EOAs (values 90, 40, 75 with decimals 0, and one with decimals 2), revoke one, then run the same sequence on `MockErc8004`. `getSummary` must return identical `(count, value, decimals)`.

  Add `--match-path test/fork/*` as a separate step in `.github/workflows/ci.yml`, using `RPC_URL=https://sepolia.base.org` (public, no secret).
  - Done: the public RPC serves archive state (checked 30 days back), so the pinned `forkBlock` works. No separate CI step was added: `ci.yml` already runs the whole suite, fork tests included, with `RPC_URL` set.
- [X] T011 Extend `scripts/export-abi.ts` to also export the `IPolicyWalletReputation` events and functions into `packages/agent/src/abi/PolicyWallet.ts`. Extend the `Reason` mapping in `packages/agent/src/reasons.ts` with codes 8–12 and their en/zh text from contracts/dashboard.md, so the CLI and dashboard share one source.
  - Done: the generated file is `packages/agent/src/abi.ts` (one file, as in 001), not `abi/PolicyWallet.ts`. Reason text for 8–12 is `REPUTATION_REASON_TEXT` in `reasons.ts`.

**Checkpoint**: interfaces, the mock (proven equal to the real registry) and the pin check are ready. User stories can begin.

---

## Phase 3: User Story 1 - Only pay services with a good reputation from trusted reviewers (Priority: P1) 🎯 MVP

**Goal**: the wallet refuses non-allowlisted payees unless they have a matching ERC-8004 identity and enough good ratings from trusted reviewers. This is checked on-chain inside authorisation, and every refusal is recorded.

**Independent Test**: with the rule at "≥ 70 from ≥ 3 trusted", using the mock and then the forked real registry:
- a service at 85 from 5 trusted reviews passes;
- a service at 40 is refused with `PAYEE_REPUTATION_TOO_LOW`;
- a service with 1 review is refused with `NOT_ENOUGH_TRUSTED_REVIEWS`;
- high scores only from untrusted reviewers are refused with `NOT_ENOUGH_TRUSTED_REVIEWS`;
- an allowlisted payee passes regardless.

In every refusal the wallet balance is unchanged (quickstart scenarios 1 and 6).

### Tests for User Story 1 ⚠️ (write first, must fail)

- [X] T012 [P] [US1] Write `contracts/test/Reputation.t.sol` against `MockErc8004`. Cover:
  - **Setters**:
    - `setReputationRule` and `setTrustedReviewer` revert for the agent and for a stranger;
    - enabling with 0 reviewers, `minAverage` 101, or enabling with `minCount` 0 reverts;
    - zero address, a duplicate, a 6th reviewer, or removing the last reviewer while enabled reverts;
    - each change emits `RuleChanged` with the field names from data-model.md.
  - **Check order** (data-model.md), one test per row:
    - allowlisted with low reputation → pass;
    - allowlisted with an identity mismatch → 9;
    - allowlisted with the identity registry failing → pass and `hasIdentity == false`;
    - rule off and not allowlisted → 3;
    - no identity → 8;
    - mismatch, including an unknown id and `address(0)` → 9;
    - summary failure → 10;
    - count < min → 11;
    - average < min → 12;
    - pass → `PaymentAuthorized` followed by `PayeeIdentityVerified`, with `attempt(nonce)` returning `(true, agentId, false)`.
  - **Decimals**: a summary with decimals 2 (value 7000) passes a minimum of 70.
  - **Registry failures**: each failure mode (`REVERT`, `BURN_GAS`, `GARBAGE`, `HUGE_RETURN`) gives 10, never a revert and never a pass.
  - **Low gas**: `authorizeWithIdentity` called with gas below the guard **reverts**.
  - **001 compatibility**: 001's `authorize` behaves exactly as before when the rule is disabled.
  - **`checkPayee` agrees**: it returns the same reason as `authorizeWithIdentity` in every case above.
- [X] T013 [P] [US1] Write `contracts/test/Reputation.fuzz.t.sol`:
  - **One fuzz per reason 8–12**, with fuzzed amount, payee, agentId, number and values of ratings, minimums and timestamps, bounded so each case lands on that reason. Each asserts:
    - `authorizeWithIdentity` returns `false`;
    - exactly that `Reason` in `PaymentRefused`;
    - no revert;
    - the USDC balance, `spentOn(today)` and the task `spent` are unchanged.
  - **SC-002**: for a fixed trusted set, add 1–20 random **untrusted** reviewers with arbitrary scores 0–100. The `checkPayee` result and reason are identical to the run without them.
  - Set `[fuzz] runs = 1000` (already in `foundry.toml`).
- [X] T014 [P] [US1] Write `packages/agent/test/identity.test.ts` (Vitest, mocked viem and x402 client):
  - the `onBeforePaymentCreation` hook reads `selectedRequirements.extra.erc8004`;
  - a decimal-string `agentId` is parsed to bigint, including `"0"`;
  - a wrong `agentRegistry`, a missing key or a malformed id is treated as unclaimed;
  - `extra.name` and `extra.version` are untouched;
  - the signer calls `authorizeWithIdentity(…, agentId)` when an identity is claimed, and 001's `authorize(…)` when not;
  - a `PaymentRefused` receipt with reasons 8–12 throws `PolicyRefusedError` with that reason.

### Implementation for User Story 1

- [X] T015 [US1] Add the reputation state to `contracts/src/PolicyWallet.sol`:
  - immutables `identityRegistry` and `reputationRegistry`, set in the **implementation constructor**, so clones share them;
  - storage for the rule (`enabled`, `minAverage`, `minCount`) and `address[] trustedReviewers`, with a membership mapping and `MAX_TRUSTED_REVIEWERS = 5`;
  - `setReputationRule` and `setTrustedReviewer` (`onlyOperator`, validations as in T012, emitting `RuleChanged`);
  - views `reputationRule()` and `trustedReviewers()`.

  Depends on T006 and T007.
- [X] T016 [US1] Implement the scope check in `contracts/src/PolicyWallet.sol`:
  - **Shared check**: refactor 001's step 3 into `function _checkScope(address payee, bool hasClaim, uint256 agentId) internal view returns (Reason, bool hasIdentity)`, implementing data-model.md's steps 3a–3e exactly. 001's `authorize` calls it with `hasClaim = false`.
  - **Registry reads**: add `_readAgentWallet(agentId)` and `_readSummary(agentId)`. Each is an **assembly `staticcall`** with a fixed gas budget (`IDENTITY_GAS = 100_000`, `REGISTRY_GAS = 5_000_000`) and a fixed output buffer (32 and 96 bytes). Each:
    - checks `success` and `returndatasize()`;
    - range-checks the words: the address's upper 12 bytes are zero, `count ≤ type(uint64).max`, `value` fits `int128`, `decimals ≤ 18`;
    - returns `ok = false` on any failure.
  - **Gas guard**: at the top of `authorizeWithIdentity`, `require(gasleft() >= (IDENTITY_GAS + REGISTRY_GAS) * 64 / 63 + 50_000)`.
  - **`authorizeWithIdentity(nonce, payee, amount, validAfter, validBefore, taskId, payeeAgentId)`**: runs 001's checks with the new scope step. On success it stores `attempt.hasIdentity` and `attempt.payeeAgentId` and emits `PayeeIdentityVerified` after `PaymentAuthorized`. (B: `payWithIdentity` with the same checks.)
  - **Views**: `checkPayee(payee, hasClaim, agentId)`, using the same `_checkScope`, and `attempt(nonce)`.

  Depends on T015. T012 and T013 pass.
  - Done: registry reads require `returndatasize()` to be **exactly** 32 / 96 bytes. Internally `authorize` and `authorizeWithIdentity` share `_authorize(Request)` (a memory struct, to stay within the stack limit). PolicyWallet is 12.3 KB (limit 24 KB). The gas guard's margin is `GAS_GUARD_MARGIN = 200_000` (the task's "+ 50_000" was measured as barely enough): `test_lowGas_minimumPassingGasStillFundsTheRegistry` binary-searches the least gas that passes the guard and shows a registry needing its full 5 M still answers (a 20k margin fails it).
- [X] T017 [US1] Update `contracts/src/PolicyWalletFactory.sol` and `contracts/script/Deploy.s.sol`:
  - the implementation is constructed with the two registry proxy addresses, read from `config/erc8004.json`;
  - the deploy script keeps `require(block.chainid == 84532)`, and also `require(identity.code.length > 0 && reputation.code.length > 0)`;
  - print the new factory address;
  - document in `contracts/README.md` that **existing 001 wallets are clones of the old implementation** and must be recreated (see T042).
- [X] T018 [US1] Implement `packages/agent/src/identity.ts`:
  - `erc8004Hook(config)` returns an `onBeforePaymentCreation` hook that stores the claimed `agentId` per request;
  - `createPolicyWalletClient(opts)` in `packages/agent/src/signer.ts` registers the hook and makes the signer call `authorizeWithIdentity` or `authorize`, as specified in contracts/agent-cli.md.

  T014 passes.
  - Done: the signer sends `authorizeWithIdentity` with an explicit gas limit (`AUTHORIZE_WITH_IDENTITY_GAS = 6_000_000`), because a gas estimate would land under the contract's ~5.38 M guard. `onAuthorized` reports `agentId` only when `PayeeIdentityVerified` was emitted.
- [X] T019 [US1] Add these CLI commands to `packages/agent/src/cli.ts` (all with the chain guard first, JSON lines, no keys printed):
  - `set-reputation --wallet <w> --min-avg <0-100> --min-count <n> [--off]` (operator);
  - `trust-reviewer --wallet <w> <addr> [--remove]` (operator);
  - `reputation [--service <key>]` (read-only). Per service in `config/services.json` it prints `ownerOf`, `getAgentWallet`, `getSummary(agentId, trustedReviewers, "", "")` and `checkPayee` for the gated wallet.
  - Done, built and unit-tested only; not run against any live wallet (the live `research-bot-01` is a clone of 001's implementation and has none of these functions until T043).
- [X] T020 [US1] Extend `contracts/test/fork/Erc8004.fork.t.sol` against the **real** registries at `forkBlock`:
  - deploy a `PolicyWallet` implementation and clone;
  - register a service identity from a test owner;
  - `setAgentWallet` to a payee using an EIP-712 `AgentWalletSet` signature made with `vm.sign` by the payee key (`deadline = block.timestamp + 60`);
  - trust 3 EOAs and have them `giveFeedback`.

  Assert:
  - 5 × 85 passes;
  - 2 ratings give 11;
  - 3 × 40 give 12;
  - 10 untrusted × 100 give 11;
  - `checkPayee` equals the `authorizeWithIdentity` result each time.

**Checkpoint**: the rule is enforced on-chain, proven with the mock and with the real registries. US1 is complete and testable on its own.

---

## Phase 4: User Story 2 - The agent publicly rates every service it pays (Priority: P1)

**Goal**: after each settled paid call, the wallet (as reviewer) publishes a deterministic 0–100 rating with a reason tag to the ERC-8004 Reputation Registry, linked to the payment nonce. Ratings are impossible without a settled, identity-checked payment of that wallet.

**Independent Test**:
- on the fork, after a settled payment the wallet's `rate` produces a `NewFeedback` with `clientAddress = wallet`, the right score and tag, and `feedbackHash = nonce`;
- rating a refused, foreign or already-rated nonce reverts;
- `scoreQuote` gives ≥ 80 `accurate` for a fresh fixture and < 50 `stale` for a stale one.

These are quickstart scenarios 4, 10 and 11.

### Tests for User Story 2 ⚠️ (write first, must fail)

- [X] T021 [P] [US2] Write `contracts/test/Rate.t.sol` against `MockErc8004`:
  - `rate` reverts for a non-agent, an attempt without identity, an unsettled payment (A: `authorizationState` false; B: no settled `pay` record), an already-rated nonce, score 101, an empty tag, a 33-byte tag or a 201-byte endpoint;
  - a settled rate calls `giveFeedback(agentId, score, 0, tag, "agent-wallet/v1", endpoint, "", nonce)` with the `agentId` **from the attempt record**, and emits `PaymentRated` with the registry's `feedbackIndex`;
  - when the registry rejects the call (the wallet is the identity's owner), `rate` reverts and `attempt.rated` stays false.
- [X] T022 [P] [US2] Write `contracts/test/Reputation.invariant.t.sol`. Its handler performs random `authorize`, `authorizeWithIdentity`, simulated settlement, `rate`, `setReputationRule`, `setTrustedReviewer`, `setPayee` and `release`. Invariants:
  - `attempt.rated ⇒ attempt.hasIdentity ∧ settled`;
  - at most one mock `giveFeedback` per (wallet, nonce);
  - the rule is never enabled with zero reviewers;
  - all of 001's invariants (spend ≤ limits, nonce used once) still hold.

  Uses `[invariant] runs = 256, depth = 50`.
- [X] T023 [P] [US2] Write `packages/agent/test/scoring.test.ts` with fixtures in `packages/agent/test/fixtures/quotes/`. Cases:
  - not JSON → 10 `malformed`;
  - a missing `asOf` → 10 `malformed`;
  - a wrong pair → 20 `wrong-data`;
  - `price` "0" → 20 `wrong-data`;
  - `asOf` 301 s old → 40 `stale`;
  - fresh → 90 `accurate`;
  - the same input twice gives the same output (FR-011).
- [X] T024 [P] [US2] Write `packages/agent/test/rate.test.ts` with a mocked viem client:
  - `ratePayment` waits for the **settlement tx receipt** before sending `rate`;
  - it parses `PaymentRated` and returns `feedbackIndex` and `txHash`;
  - `pay --rate` never calls `rate` for a refused payment or one without identity.

### Implementation for User Story 2

- [X] T025 [US2] Implement `rate(nonce, score, tag, endpoint)` in `contracts/src/PolicyWallet.sol` per contracts/policy-wallet-reputation.md:
  - check the agent, `hasIdentity`, the settlement (A: `IERC3009(token).authorizationState(address(this), nonce)`; B: the `pay` record), not rated, and the bounds;
  - set `attempt.rated = true` **before** calling `giveFeedback` (checks-effects-interactions);
  - read `getLastIndex(agentId, address(this))` for `feedbackIndex`;
  - emit `PaymentRated`.

  T021 and T022 pass.
- [X] T026 [P] [US2] Implement `packages/agent/src/scoring.ts` `scoreQuote(res, req)` exactly as the table in research R6, as a pure function with no I/O. T023 passes.
- [X] T027 [US2] Implement `packages/agent/src/rate.ts` `ratePayment({ wallet, agentKey, nonce, settlementTx, score, tag, endpoint })`. In `signer.ts`/`identity.ts`, capture the settlement tx hash from the x402 payment response header and the nonce of the request. T024 passes.
- [X] T028 [US2] Add `--rate` to `pay <url>` in `packages/agent/src/cli.ts`. After a 200 with a settled payment that had an identity, it scores the response, calls `ratePayment` and prints a `rated` JSON line with `score`, `tag`, `feedbackIndex` and `txHash`.
  - Done: the eligibility decision is `rateOutcome` in `rate.ts`, so `pay --rate` never rating a refused or identity-less payment is unit-tested.
- [X] T029 [US2] Extend `contracts/test/fork/Erc8004.fork.t.sol`:
  - fund the clone with USDC via `deal`;
  - authorise with identity;
  - settle by calling USDC `transferWithAuthorization(…, signature)` with the agent's signature (A; B: `payWithIdentity`);
  - `rate(nonce, 90, "accurate", "https://api.demo.yunshu.ai/s/reliable/quote")`.

  Assert:
  - the real registry's `NewFeedback` has `clientAddress == wallet`, `value 90`, `tag1 "accurate"`, `tag2 "agent-wallet/v1"` and `feedbackHash == nonce`;
  - `getSummary` includes it;
  - a wallet that is approved for the identity can't rate it (revert).

**Checkpoint**: ratings work end to end against the real registry and can't be forged (research R4).

---

## Phase 5: User Story 3 - Visitors see who the agent trusts and why (Priority: P1)

**Goal**: the dashboard shows the trust rule, the trusted reviewers, an identity card per service (trusted average, count, trend, payable status with reason, since when), and ratings and reputation refusals in the timeline. Every number matches the registry exactly.

**Independent Test**: built from recorded fixtures:
- `/` and `/zh/` show the rule in plain words, the reviewers and a card per service with average, count and payable status;
- a rated row links to its transaction;
- the page works without JS;
- `check-reputation` reports no difference from `getSummary`.

These are quickstart scenarios 13 and 14.

### Tests for User Story 3 ⚠️ (write first, must fail)

- [X] T030 [P] [US3] Extend `scripts/snapshot.test.ts` with recorded fixtures in `scripts/fixtures/erc8004/`:
  - `services[].summary` is copied verbatim from the `getSummary` result;
  - `NewFeedback` and `PaymentRated` logs are joined by nonce into `rated` rows;
  - `statusChanged` rows come from consecutive snapshots with a different `payable`;
  - snapshots are capped at 400 per service;
  - `erc8004.pinnedOk` is false when the implementation slot differs.
- [X] T031 [P] [US3] Extend `apps/dashboard/tests/dashboard.spec.ts` (Playwright):
  - the trust-rule sentence is present in en and zh;
  - one card per service has an average, a count and a Payable / Not payable badge with reason text;
  - a rated row has a Basescan link;
  - the page renders with JS disabled;
  - the content-parity check still passes.

### Implementation for User Story 3

- [X] T032 [US3] Extend `scripts/snapshot.ts` to fill these `history.json` sections per contracts/dashboard.md:
  - **`erc8004`**: run `assertRegistriesPinned` and set `pinnedOk`.
  - **`reputationRule`**: from the gated wallet's views.
  - **`services`**:
    - from `config/services.json`, plus `tokenURI` decoded for `name` and `description`, and `getAgentWallet`;
    - `summary` from `getSummary(agentId, trustedReviewers, "", "")` at the snapshot block;
    - `payable` and `reason` from `checkPayee` at the same block;
    - one appended snapshot.
  - **New logs**: `NewFeedback` logs fetched in 500-block chunks, filtered by demo `agentId`s and `clientAddress` ∈ the demo wallets, joined with `PaymentRated` into `rated` rows. `statusChanged` rows are derived from the snapshots.

  T030 passes.
  - Done, with one simplification: `rated` rows come from the wallet's own `PaymentRated` events (they carry nonce, agentId, score, tag and the registry's feedbackIndex), so no join with the registry's `NewFeedback` logs is needed. Logs use 200-block chunks (the RPC's current limit). Every card's summary and payable status are read at one block. Pure helpers in `scripts/lib/trust.ts`. `history.json` was rebuilt once from the wallets' creation blocks so the first ratings were included.
- [X] T033 [P] [US3] Create `scripts/check-reputation.ts`. For every service in `history.json` it re-reads `getSummary` at `summary.block` and exits 1 on any difference. Add it to `.github/workflows/ci.yml` after the dashboard build, and to `agent-run.yml` after the snapshot (FR-015, SC-005).
- [X] T034 [P] [US3] Add strings to `apps/dashboard/src/i18n/en.json` and `zh.json`, with identical keys:
  - the rule sentence template;
  - section headings;
  - Payable / Not payable, "since", and the count warning;
  - the `reason.*` texts for 8–12 from contracts/dashboard.md;
  - `rated` and `statusChanged` row templates.
- [X] T035 [US3] Create the components and add them to `apps/dashboard/src/pages/index.astro` and `zh/index.astro` above the timeline:
  - `apps/dashboard/src/components/TrustRule.astro`;
  - `ServiceCard.astro`: name, description, agent id linked to the registry on Basescan, registered address, average and count, badge with reason, since;
  - `Sparkline.astro`: inline SVG from the snapshots, no JS, with an `aria-label` summary.

  Extend `Timeline.astro` for `rated` and `statusChanged` rows. T031 passes.
- [X] T036 [US3] Extend `apps/dashboard/src/scripts/live-tail.ts`:
  - add the `NewFeedback` logs for the demo services to the existing 10 s log poll;
  - refresh each card's `summary` with `getSummary`, no faster than every 30 s;
  - keep the first-screen JS budget ≤ 50 KB gzip (viem stays in the lazy chunk).
  - Done: the live tail decodes `PaymentRated` and re-reads each card's `getSummary` and `checkPayee` every 30 s. Scouts' ratings aren't live rows (they're the scouts' events); they show up through the cards' numbers. First-screen JS stays ~1 KB gzip; the lazy chunk is 17 KB gzip.
- [X] T037 [US3] In `ServiceCard.astro`, show "Approaching the on-chain check limit" when `summary.count > 1500` (research R7). Add a fixture case in T030's tests.

**Checkpoint**: the dashboard explains trust, both languages, without JS, with numbers matching the registry.

---

## Phase 6: User Story 4 - Demo services with real public identities (Priority: P2)

**Goal**: quote, reliable, flaky and newcomer each have a public ERC-8004 identity whose registered wallet equals the address it asks to be paid at. The impostor and anonymous routes exist for US6. The upgraded wallets are deployed.

**Independent Test**: `reputation` shows each identity with `registeredWallet == payTo`, and each route's 402 carries the right `payTo` and `extra.erc8004` (quickstart scenarios 2–5 and 9).

### Tests for User Story 4 ⚠️ (write first, must fail)

- [X] T038 [P] [US4] Write `packages/service/test/services.test.ts` (Vitest with Hono's `app.request`):
  - each route's 402 has `payTo` and `extra.erc8004 = { agentRegistry: "eip155:84532:0x8004A818…", agentId }` **while keeping** `extra.name` and `extra.version`;
  - `/s/impostor/quote` claims reliable's `agentId` with `PAYEE_IMPOSTOR`;
  - `/s/anonymous/quote` has no `erc8004` key;
  - `/s/newcomer/quote` returns 503 `{error, opensAt}` before `NEWCOMER_OPENS_AT`;
  - `/s/flaky/quote`'s body has `asOf` = now − 1 h after `FLAKY_DEGRADE_AT`, and is fresh before;
  - the Worker refuses to start unless `NETWORK = eip155:84532`.
- [X] T039 [P] [US4] Write `packages/agent/test/registration.test.ts`:
  - `buildAgentURI(service)` produces a `data:application/json;base64` file whose decoded JSON matches research R9's shape;
  - `register-services` is idempotent: it skips an id whose `getAgentWallet` already equals `payTo`;
  - the `AgentWalletSet` typed data has domain `{ name: "ERC8004IdentityRegistry", version: "1", chainId: 84532, verifyingContract: identity proxy }`, type `AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)` and `deadline ≤ now + 300`.

### Implementation for User Story 4

- [X] T040 [US4] Implement `packages/service/src/services.ts`. It mounts the routes from contracts/paid-services.md on the existing Hono app in `packages/service/src/index.ts`, using `@x402/hono` per route:
  - each route's own `payTo` and `extra`;
  - 001's `/quote` gains `extra.erc8004` with `AGENT_ID_QUOTE`.

  Add the vars `PAYEE_RELIABLE`, `PAYEE_FLAKY`, `PAYEE_NEWCOMER`, `PAYEE_IMPOSTOR`, `AGENT_ID_QUOTE`, `AGENT_ID_RELIABLE`, `AGENT_ID_FLAKY`, `AGENT_ID_NEWCOMER`, `FLAKY_DEGRADE_AT` and `NEWCOMER_OPENS_AT` to `packages/service/wrangler.toml` (placeholders). Behaviour depends only on server time. T038 passes.
  - Done: `src/services.ts` + one shared paid-route helper in `app.ts` (001's `/quote` goes through it too). x402 merges a route's `extra` with USDC's `name`/`version` (checked). Unset or empty vars mean not configured: a 503 with no 402. `AGENT_ID_QUOTE` stays empty until T043 (see T044). Not deployed: the Worker gets these routes at T044.
- [X] T041 [US4] Implement `packages/agent/src/registration.ts` (`buildAgentURI`, `signAgentWalletSet`) and the CLI command `register-services` in `packages/agent/src/cli.ts`:
  - it uses the services-owner key to `register(agentURI)`;
  - each payee key, including `SERVICE_PAYEE_PRIVATE_KEY` for quote, signs `AgentWalletSet`;
  - it calls `setAgentWallet`;
  - it writes `agentId` and `payTo` into `config/services.json`;
  - it never prints keys.

  T039 passes.
  - Done: `registerServices` in `registration.ts` (injectable, unit-tested; the AgentWalletSet hash is checked against a by-hand keccak of the registry's formula) and `register-services` in the CLI. It refuses a reliable payee equal to `SERVICE_PAYEE` (R9) and checks `SERVICE_PAYEE_PRIVATE_KEY` belongs to `SERVICE_PAYEE`. Saves `services.json` after each step, so a rerun never registers twice.
- [X] T042 [US4] Security review gate (constitution workflow) **before** any deploy. Run `/security-review` on `contracts/src/`, plus a manual checklist:
  - assembly bounds in `_readAgentWallet` and `_readSummary`;
  - the gas guard;
  - checks-effects-interactions in `rate`;
  - `agentId` is never caller-supplied in `rate`;
  - an allowlist pass never skips the mismatch check;
  - the append-only `Reason` enum.

  Fix the findings and record the outcome in `specs/002-trusted-payees-erc8004/research.md` as "R12. Security review".
- [X] T043 [US4] **(owner-funded)** Deploy and migrate on Base Sepolia:
  1. deploy the new implementation and factory (`deploy-factory`);
  2. `withdraw` the USDC from 001's old `research-bot-01` to the operator;
  3. `create-wallet research-bot-01 --cap 1 --daily 5` (new address) and re-apply 001's payee and task rules, including allowlisting 001's `SERVICE_PAYEE`;
  4. `create-wallet scout-02` and `scout-03` with the same agent key;
  5. fund research-bot-01 with 20 USDC and each scout with 10 USDC;
  6. allowlist the reliable, flaky and newcomer payees on both scouts;
  7. `trust-reviewer` all three wallets on research-bot-01;
  8. `set-reputation --wallet research-bot-01 --min-avg 70 --min-count 3`.

  Record the addresses in `config/deployments.json`. Depends on T042.
  - Done 2026-10-10 with **smaller amounts** (owner choice (b): only 9.74 test USDC on hand): research-bot-01 7.70, each scout 1.00 (≈ 8 days at 0.12/day; top up later). Daily budget kept at 001's **1.00**, not 5, so the over-daily probe stays an honest over-daily refusal (a 5 budget makes it hit the per-payment cap first).
  - Implementation `0x0d0f43777c7572d77975011dc14791730ace64fd`, factory `0xad04a77c6170a5dee15ed61146f9232dfdc8b38c`; research-bot-01 `0xC788272Fe9c76810ef1bA2539B56822405eDb0Fc`, scout-02 `0x1dAb793c0dBF670bd03935A54Ab9833A20cb704B`, scout-03 `0x3E8441303A46c56FD2E0492Bd41838A14d57C438`. 001's wallet is recorded under `retired` in `config/deployments.json` after its 8.79 USDC was withdrawn.
  - The services owner was funded with 0.00002 test ETH from the operator (the Chrome extension wasn't connected for the faucet).
- [X] T044 [US4] **(owner)** Run `register-services` locally (it uses local-only keys). Then:
  - set the Worker vars from `config/services.json`, with `FLAKY_DEGRADE_AT` = launch + 12 h and `NEWCOMER_OPENS_AT` = launch + 36 h, where launch is the planned first scheduled run (record it in `config/services.json`);
  - redeploy the Worker through its Git integration;
  - commit `config/services.json` and `config/deployments.json` (public addresses only).
  - **Order matters**: don't give the live `/quote` an `extra.erc8004` before T043 has moved `research-bot-01` to the new implementation. The agent would then call `authorizeWithIdentity` on a wallet that doesn't have it, and every scheduled payment would revert.
  - Done 2026-10-10: quote #9613, reliable #9614, flaky #9615, newcomer #9616, each registered to its payTo. The newcomer's setAgentWallet first reverted `ERC721NonexistentToken` (the public RPC hadn't seen the mint yet); the idempotent rerun finished it, and `register-services` now waits until a new identity is visible.
  - Launch = the 06:17 UTC run on 2026-10-10: `FLAKY_DEGRADE_AT` 2026-10-10T18:17Z, `NEWCOMER_OPENS_AT` 2026-10-11T18:17Z. The Worker was deployed with `wrangler deploy` (no Git integration); all six routes checked live.
  - First live trust run (01:2x UTC, before launch): every outcome matched `checkPayee` (0 mismatches). It exposed a bug: 001's LINK-USDC and OP-USDC payments were scored against the ETH-USDC URL, so the gated wallet published two **20 "wrong-data"** ratings for quote #9613 that should have been 90. Fixed (rate against the URL actually paid) with a regression test. The two ratings stay on the public record (the wallet has no revoke function); quote is allowlisted, so they never affect a decision.
- [X] T045 [US4] Run quickstart scenarios 2, 3, 4, 5 and 9 on Base Sepolia with the CLI, and record the outputs and tx links in `specs/002-trusted-payees-erc8004/quickstart-results.md`.
  - Done 2026-10-10 09:26–09:29 UTC: all pass. Scenarios 2 and 3 were checked against the chain as it was before the first rating (block 47912910, and the scheduled run's `NOT_ENOUGH_TRUSTED_REVIEWS` refusal at 47912974), since the pre-review moment had passed.

**Checkpoint**: real identities are live, the upgraded wallets are deployed, and US1 and US2 are proven on the live network.

---

## Phase 7: User Story 5 - Trust is earned and lost over time (Priority: P2)

**Goal**: scheduled runs keep paying and rating, so the flaky service is cut off automatically (and permanently) and the newcomer earns its way in, with no manual steps.

**Independent Test**: after launch the schedule runs unattended for 3 days:
- the flaky service crosses below 70 (worst case about 24 h after launch), and every later gated attempt is refused with `PAYEE_REPUTATION_TOO_LOW`;
- the newcomer is refused with `NOT_ENOUGH_TRUSTED_REVIEWS` in the first run after it opens, then becomes payable;
- every settled call has its rating;
- the dashboard shows when each status changed.

These are quickstart scenario 12 and SC-003/004.

### Tests for User Story 5 ⚠️ (write first, must fail)

- [X] T046 [P] [US5] Extend `packages/agent/test/scenario.test.ts` (mocked chain, fetch and signer):
  - **order**: `assertRegistriesPinned`; then both scouts pay and rate every open service; then 001's scenario on research-bot-01, **with 001's payee-not-allowed probe running on scout-02** and expecting 3; then the gated wallet tries reliable, flaky, newcomer, impostor and anonymous;
  - **expectations**: every expected outcome comes from `checkPayee` just before its attempt;
  - **ratings**: every settled payment with identity is rated, `/quote` included;
  - **exit codes**: exit 4 on `RegistryChangedError` before any payment; exit 2 on any mismatch; exit 3 on insufficient funds.

### Implementation for User Story 5

- [X] T047 [US5] Implement the extended `run-scenario` in `packages/agent/src/scenario.ts` per T046 and contracts/agent-cli.md. Wallet addresses come from `config/deployments.json`, and services from `config/services.json`. T046 passes.
  - Done: `src/trustScenario.ts`. `run-scenario` runs it only when 002 is set up (both scouts in `deployments.json`, `research-bot-01` on the 002 implementation, `reliable` registered); otherwise 001's scenario exactly as before, checked live 2026-10-09 (`trust: false`, all 4 probes correct). Exit codes from T046 are tested.
  - That live run's 3rd payment failed with a bare `402 {}` after a successful authorize, as in 001's first GitHub run (both before any 002 code; 4 payments in a row then all settled). `pay` now logs `diagnostics` (response headers, decoded settlement and requirements) on such failures to find the cause.
  - It recurred in the 06:01 UTC launch run (scout-02 → flaky: authorized, never settled; exit 2). The trust scenario logged only `FAILED: {}` because it dropped `diagnostics`; it now logs the status, authorize tx and diagnostics. Cause narrowed from `@x402/hono`: a bare `402 {}` with no `PAYMENT-REQUIRED` is what it answers when the facilitator's settle call **throws** after verify passed. `pay` now resends the same signed payment up to twice (3 s apart) on exactly that answer; the EIP-3009 nonce settles at most once, so a resend can't pay twice.
- [X] T048 [US5] Update `.github/workflows/agent-run.yml`:
  - keep the 6-hour cron;
  - run `run-scenario`. On exit 4, skip payments but still run the snapshot, so the dashboard shows the "registry changed" banner from `pinnedOk: false`;
  - run `snapshot` and then `check-reputation`;
  - commit `history.json`.

  No new secrets: only `AGENT_PRIVATE_KEY`, from 001.
  - Done: `check-reputation` runs after the snapshot (and a mismatch stops the snapshot commit), and in CI after the dashboard build. Exit 4 already skips payments while the snapshot still runs.
- [ ] T049 [US5] After launch, let the schedule run for 3 days. Check against `history.json` and the dashboard:
  - quickstart scenario 12: the flaky crossing time, every later flaky attempt refused with 12, the newcomer refused with 11 and then payable, and ratings for every settled call;
  - quickstart scenario 14.

  Record the results in `specs/002-trusted-payees-erc8004/quickstart-results.md`.

**Checkpoint**: the story plays out on its own on the public record.

---

## Phase 8: User Story 6 - Impersonation is refused (Priority: P3)

**Goal**: a service claiming an identity whose registered wallet isn't its `payTo`, or claiming none, can't be paid by the gated wallet.

**Independent Test**: `pay …/s/impostor/quote` is refused with `PAYEE_IDENTITY_MISMATCH` and `pay …/s/anonymous/quote` with `PAYEE_IDENTITY_UNVERIFIED`. No funds move (quickstart scenarios 7 and 8).

- [X] T050 [P] [US6] Extend `contracts/test/fork/Erc8004.fork.t.sol`:
  - an impostor payee claiming a real, well-rated identity → 9;
  - after the owner transfers the identity NFT (`agentWallet` cleared) → 9;
  - after `setAgentWallet` to a new payee, paying the old address → 9;
  - an allowlisted payee claiming a mismatched identity → 9 (the mismatch check isn't skipped by the allowlist).
- [X] T051 [US6] Run quickstart scenarios 7 and 8 on Base Sepolia from research-bot-01. Confirm the refusals appear on the dashboard with the plain-language text, and record them in `specs/002-trusted-payees-erc8004/quickstart-results.md`.
  - Done 2026-10-10 09:28 UTC: 7 → `PAYEE_IDENTITY_MISMATCH`, 8 → `PAYEE_IDENTITY_UNVERIFIED`, no USDC moved; the page shows both in plain language (en and zh, no JS needed).

**Checkpoint**: all six user stories work.

---

## Phase 9: Polish & Cross-Cutting Concerns

- [X] T052 [P] Add a "Trusted payees (ERC-8004)" section to `README.md`, in English with a short Chinese summary. Cover:
  - the rule;
  - the trust argument (research R4);
  - the demo cast and timeline (research R5);
  - the pinned registries and the exit-4 behaviour;
  - the new owner keys (local-only);
  - a link to this spec.
- [X] T053 [P] Update `apps/dashboard/src/components/Dashboard.astro`'s project-page content and the `en.json`/`zh.json` "how it works" and refusal-reason lists, so the current public page at `demo.yunshu.ai` mentions trusted payees and the five new reasons.
  - Partly done: the page's refusal-reason list has the five new reasons in check order (en/zh), and the trust section explains the rule. "How it works" still describes 001 only.
- [X] T054 **(owner)** Fix the constitution drift noted in the plan:
  - allow Cloudflare's GitHub app access to `edxzh/agent-wallet`;
  - create a Git-connected Pages project (build `npm run build -w apps/dashboard`, output `apps/dashboard/dist`, `NODE_VERSION=22`);
  - move `demo.yunshu.ai` to it;
  - delete the hand-uploaded `agent-wallet-demo` project.
  - Resolved 2026-10-10 by owner decision, **not** by the steps above: constitution amended to 1.1.0. The dashboard keeps its CI-gated GitHub Actions deploy with a Pages-only token (Pages' Git builds would skip the scheduled snapshot commits and deploy pushes that fail CI); the owner deploys the Worker with `wrangler deploy`.
- [X] T055 Run quickstart scenarios 15 (edit the pin and get exit 4 before any payment, then restore it) and 16 (registry failure modes and the low-gas revert, from the T012 tests). Record them in `specs/002-trusted-payees-erc8004/quickstart-results.md`.
- [ ] T056 After 1 month:
  - check that the Cloudflare and GitHub billing pages show $0 (SC-007);
  - check that every scheduled run's settled calls were rated (SC-003);
  - hold a 60-second first-view session with 5 non-technical testers (SC-006, at least 4 of 5 can say which services are paid and why one is refused);
  - top up the scouts if they're below 2 USDC.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: T001 gates everything, because 001's MVP must be done. T002–T004 can run in parallel, and T005 is the owner's.
- **Foundational (Phase 2)**: depends on T001. T006–T009 are parallel. T010 needs T003 and T008. T011 needs T007.
- **US1 (Phase 3)**: depends on Phase 2.
- **US2 (Phase 4)**: depends on US1's T016 (attempt records). Its tests can be written alongside US1.
- **US3 (Phase 5)**: depends on Phase 2 and the event shapes (T007). It is built and tested on fixtures, so it can run in parallel with US1 and US2 and doesn't need the deploy.
- **US4 (Phase 6)**: the services (T038–T041) can run in parallel with US1–US3. The deploy (T043) needs US1 and US2's contract work plus the security review (T042). T044 needs T005 and T041.
- **US5 (Phase 7)**: needs US4's deploy (T043–T044) and US3's snapshot (T032).
- **US6 (Phase 8)**: T050 needs T020. T051 needs T044.
- **Polish (Phase 9)**: after the stories it touches. T054 can happen at any time.

### Within Each Story

- Tests first (they must fail), then implementation.
- `contracts/src/PolicyWallet.sol` is edited by T015 → T016 → T025, in that order and never in parallel.
- `packages/agent/src/cli.ts` is edited by T019 → T028 → T041, in that order.
- `contracts/test/fork/Erc8004.fork.t.sol` is extended by T010 → T020 → T029 → T050, in that order.

### Critical Path

T001 → T006/T007/T008 → T015 → T016 → T025 → T042 → T043 → T044 → T047/T048 → T049

---

## Parallel Example: User Story 1

```text
# Tests together (different files):
T012 contracts/test/Reputation.t.sol
T013 contracts/test/Reputation.fuzz.t.sol
T014 packages/agent/test/identity.test.ts

# Then: T015 → T016 (same file), while T018 and T019 proceed in packages/agent.
```

## Parallel Example: across stories after Phase 2

```text
Developer A: US1 contract work (T015–T016) then US2 (T025)
Developer B: US3 dashboard on fixtures (T030–T037)
Developer C: US4 services and registration (T038–T041)
```

---

## Implementation Strategy

### MVP first (US1 + US2, proven on fork)

1. Phase 1 and Phase 2. The mock is proven equal to the real registry (T010).
2. US1: the rule is enforced on-chain (T012–T020).
3. US2: ratings that can't be forged (T021–T029).
4. **Stop and validate**: `forge test` (unit, fuzz, invariant, fork) is green. The core safety claim, "only pays services it can trust", is now proven.

### Then go live

5. US4: security review → deploy and migrate → register identities → live scenarios (T038–T045).
6. US3: the dashboard on real data (built earlier on fixtures).
7. US5: launch the schedule and watch the story for 3 days.
8. US6 and Polish.

Each step adds value without breaking feature 001. 001's `authorize` and its reasons are
unchanged, and 001's scenario runs throughout, with its payee probe on a scout.

---

## Notes

- [P] tasks touch different files and don't depend on an incomplete task.
- Never put a key in a commit, log, CI or chat. `register-services` and the deploy run on the
  owner's machine.
- Commit after each task or logical group.
- If a registry implementation changes (exit 4), stop and get an owner decision before
  updating `config/erc8004.json` (research R8).
- T001 result (2026-10-09): **pass**. 001's T010–T040 are all checked; Design A is recorded in 001's research.md R2; `forge test` passed (31 passed, 2 fork tests skipped without `RPC_URL`; with it, all pass).
- MVP checkpoint (2026-10-09): Phase 1 (except owner task T005), Phase 2, US1 and US2 are done. `RPC_URL=https://sepolia.base.org forge test`: 83 passed (unit, fuzz 1,000 runs per case, invariants 256 × 50, fork against the real registries at `forkBlock`). Agent SDK: 44 Vitest tests. Nothing deployed. One live regression payment with the new client path (`pay …/quote --rate` on 001's `research-bot-01`): it called 001's `authorize` (selector `0x05da5c1d`), settled ([tx](https://sepolia.basescan.org/tx/0xf0ee22a7e624eccdd7c9535cb9473bf8d8d9d6a460d31d17d29deff08eb0c825)) and printed `not-rated` (no identity claimed yet). Next: the security review (T042) before T043.
