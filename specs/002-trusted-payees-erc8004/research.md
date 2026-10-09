# Research: Trusted Payees (Reputation-Gated Spending)

Facts were checked on 2026-10-08 against Base Sepolia (chain 84532) and the installed `@x402/*`
2.28 packages. "Verified" means read from chain state, verified source, or package code, not
from docs.

## R1. The deployed ERC-8004 registries (pinned interface)

| Registry | Proxy (what we call) | Implementation (verified source, Blockscout) | Version |
| --- | --- | --- | --- |
| Identity | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | `0x7274e874CA62410a93Bd8bf61c69d8045E399c02` `IdentityRegistryUpgradeable` | `getVersion() = "2.0.0"` |
| Reputation | `0x8004B663056A597Dffe9eCcC1965A193B7388713` | `0x16e0FA7f7C56B9a767E34B192B51f921BE31dA34` `ReputationRegistryUpgradeable` | `getVersion() = "2.0.0"` |

Both are **ERC-1967 UUPS proxies**, compiled with solc 0.8.24 and OpenZeppelin 5.4.0. Verified
facts that shape the design:

**Identity registry** (ERC-721 "AgentIdentity" / `AGENT`):
- `register(string agentURI)` mints the next id. **Ids start at 0** (`agentId = _lastId++`), so
  0 is a real agent and can't mean "no identity".
- The payment address is the reserved metadata key `agentWallet`:
  - `register` sets it to `msg.sender`;
  - `setAgentWallet(agentId, newWallet, deadline, sig)` changes it only with an EIP-712
    `AgentWalletSet(agentId, newWallet, owner, deadline)` signature **from `newWallet`**
    (ECDSA, or ERC-1271 for a contract), with `deadline ≤ now + 5 min`;
  - transferring the NFT **clears** it.
- `getAgentWallet(agentId)` returns `address(bytes20(data))`. For an unknown id or a cleared
  wallet that is `address(0)`. It does not revert.
- `tokenURI` holds the registration file. On-chain examples use
  `data:application/json;base64,…` with `type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1"`,
  `name`, `description`, `image`, `endpoints[]` (including an `x402` entry), `x402Support`,
  `active` and `supportedTrust: ["reputation"]`.

**Reputation registry:**
- `giveFeedback(agentId, int128 value, uint8 valueDecimals, tag1, tag2, endpoint, feedbackURI, bytes32 feedbackHash)`:
  - the reviewer is `msg.sender`;
  - **no pre-authorisation or signature from the service is needed** (earlier drafts required
    `feedbackAuth`; v2.0.0 doesn't);
  - it reverts if the sender is the agent's owner or an approved operator
    (`isAuthorizedOrOwner`), and for a nonexistent agent.
- `revokeFeedback(agentId, index)` is author-only. Revoked entries are skipped by summaries.
- `getSummary(agentId, address[] clients, tag1, tag2) → (uint64 count, int128 value, uint8 decimals)`:
  - **reverts if `clients` is empty**;
  - averages **all-time** non-revoked feedback from the listed clients, with no time window;
  - an empty tag matches everything;
  - values are normalised to 18 decimals, averaged with truncating integer division, and
    returned at the most common `valueDecimals`;
  - **gas grows linearly** with the number of matching entries (one cold storage read each).
- Events:
  - `NewFeedback(agentId indexed, client indexed, index, value, decimals, tag1 indexed, tag1, tag2, endpoint, feedbackURI, feedbackHash)`;
  - `FeedbackRevoked(agentId, client, index)`.
- Usage is real: agent #1 has feedback from 12 clients.

**Decision**: integrate against exactly this ABI. Vendor minimal interfaces
(`IERC8004Identity`, `IERC8004Reputation`) containing only the functions above. Pin the two
implementation addresses in `config/erc8004.json`.

**Alternatives considered**:
- **Deploy our own copy of the registries**: rejected by FR-008. The point is the shared public
  record.
- **Use the reference repo's interface**: rejected. Drafts differ, so the deployed bytecode is
  the source of truth.

## R2. Where the reputation check runs (on-chain, inside `authorize`)

**Decision**: the scope check in `PolicyWallet` is extended, and still runs inside the same
authorisation call as feature 001's rules (FR-003). The wallet reads the registries directly. No
off-chain oracle, no attestation signed by our own service.

- **Getting the reputation numbers**:
  - `count` and `average` come from `getSummary(agentId, trustedReviewers, "", "")` using the
    wallet's own trusted-reviewer list;
  - untrusted reviewers are never passed, so fake reviews can't count (FR-004, SC-002);
  - revoked entries are already excluded by the registry.
- **Comparing against the minimum**: `average ≥ minAverage × 10^decimals`, normalised from the
  returned decimals. Our reviewers always write `decimals = 0`, so in practice this is a plain
  integer compare.
- **Fail closed, without reverting**: registry calls use an **assembly `staticcall` with a
  fixed gas budget and a fixed-size output buffer**: 96 bytes for `getSummary`, 32 for
  `getAgentWallet`. Three alternatives were rejected:
  - Solidity `try/catch` doesn't catch a failure to decode the return data;
  - a plain `address.staticcall` copies *all* return data into memory, so an upgraded, hostile
    registry returning a huge payload could exhaust gas and make `authorize` revert;
  - OpenZeppelin `Address.functionStaticCall` reverts on failure.

  The wallet:
  1. checks `success` and `returndatasize() ≥` the expected size;
  2. reads the words from the fixed buffer and range-checks them by hand: `count` fits `uint64`,
     `value` fits `int128`, `decimals ≤ 18`, and the address's upper 12 bytes are zero;
  3. maps any failure to `REPUTATION_UNAVAILABLE` (refused, recorded, no revert, as constitution
     II requires).
- **No forced outages**: before the calls, `authorize` checks `gasleft() ≥ (IDENTITY_GAS + REGISTRY_GAS) × 64/63 + margin`
  and **reverts** if not. Otherwise an agent sending too little gas could force a false "reputation
  unavailable" entry onto the public record. With this check, that reason only ever means a
  genuine registry failure.
- **Allowlisted payees**: the allowlist still passes regardless of reputation (spec US1 #5).
  - A claimed identity is still checked when it can be read: a mismatch is refused.
  - If the identity registry is unreachable for an allowlisted payee, the payment proceeds
    without an identity. That payment simply can't be rated (R4).

**Alternatives considered**:
- **Off-chain check in the agent SDK**: bypassable, so it violates constitution II.
- **The service signs its own reputation**: self-attestation, not trust.
- **`readAllFeedback` plus our own averaging, to drop out-of-range scores**: several times the
  gas (string arrays), and it would diverge from the standard's summary. Out-of-range scores
  can't come from trusted reviewers anyway, because the wallet's `rate` bounds them (R4).

## R3. How a payee claims an identity (x402 `extra`)

`@x402/extensions` 2.28 ships `bazaar`, `sign-in-with-x`, `offer-receipt`, `payment-identifier`
and `builder-code`. There is **no ERC-8004 extension** (verified in the package exports).

**Decision**: each demo service puts its identity in the selected payment requirement's `extra`:

```json
"extra": { "name": "USDC", "version": "2",
           "erc8004": { "agentRegistry": "eip155:84532:0x8004A818BFB912233c491871b3d84c89A494BD9e",
                        "agentId": "7" } }
```

- **Merge, don't replace**: the `exact` EVM scheme reads `extra.name` and `extra.version` for
  USDC's EIP-712 domain (verified in `@x402/evm`), so the new keys are added next to them.
- **How the agent reads it**:
  1. The agent's `onBeforePaymentCreation` hook (verified:
     `(ctx: { paymentRequired, selectedRequirements }) → void | { abort, reason }`) reads
     `selectedRequirements.extra.erc8004`.
  2. It checks that `agentRegistry` is the pinned registry; otherwise it treats the identity as
     unclaimed.
  3. It hands the `agentId` to the policy signer for that request.
- **Which authorize call is used**:
  - with a claimed identity, the signer calls `authorizeWithIdentity(…, agentId)`;
  - without one, it calls feature 001's `authorize(…)` unchanged.

**Why a custom key is acceptable (constitution VI)**:
- `extra` is the scheme's own free-form field;
- x402 has no standard way to carry an identity yet;
- the format reuses ERC-8004's own `{agentRegistry, agentId}` pair, so it maps onto a future
  extension mechanically.

It's recorded in the plan's Complexity Tracking.

**Alternatives considered**:
- **Look up the identity by `payTo`**: the registry has no reverse index.
- **An HTTP header**: outside the signed requirements and non-standard.
- **A new x402 extension package**: overkill for a demo. We can contribute one upstream later.

## R4. Ratings are unforgeable: only settled payments can be rated (trust argument)

**Threat**: one agent key drives all demo wallets. If a rating function accepted any
`agentId` and score, a stolen agent key could rate an impostor highly from every trusted
reviewer wallet, then get the gated wallet to pay it. SC-002 covers only untrusted reviewers.

**Decision**: the wallet itself is the reviewer (FR-012). It exposes
`rate(bytes32 nonce, uint8 score, string tag, string endpoint)`, callable only by its agent,
which calls `giveFeedback`:
- `agentId` is **not a parameter**. It's taken from the attempt record that
  `authorizeWithIdentity` stored after the identity check passed. Without an identity-checked
  attempt, there's nothing to rate.
- The payment must have **settled**:
  - Design A: `USDC.authorizationState(this, nonce) == true`;
  - Design B: the `pay()` record is settled.
- Each nonce can be rated **once**.
- `score ≤ 100` and `decimals = 0`; `tag` ≤ 32 bytes; `endpoint` ≤ 200 bytes.
- `feedbackHash = nonce` and `tag2 = "agent-wallet/v1"`, so every rating links to its payment
  on the public record (FR-009).
- It sets `rated = true` **before** the external `giveFeedback` call (checks-effects-interactions),
  then emits `PaymentRated(nonce, agentId, score, tag, feedbackIndex)`.
- The SDK calls `rate` only after the settlement transaction's receipt is confirmed. The
  facilitator's tx hash comes back in the x402 payment response. This way a lagging public RPC
  node can't make the settlement check revert.

**Resulting guarantee**: a trusted rating exists only if the operator's rules let that wallet
pay that identity, and the payment settled.
- **What a stolen agent key can still do**: pay real, rule-passing services (bounded by every
  feature 001 limit) and give them any score from 0 to 100.
- **What it can't do**: create ratings for identities the wallet never paid.
- **What follows for the gated wallet**: pushing an impostor's score up requires first paying the
  impostor from a wallet whose rules allow it. Every demo allowlist holds only operator-chosen
  payees: the scouts' demo services and the gated wallet's 001 `/quote` payee. An identity is
  only ever recorded after its registered wallet matches the payee. So an impostor (a different
  payee claiming someone else's id) can't gain trusted ratings at all.

The trust root is the operator's allowlists and reviewer list.

**Alternatives considered**:
- **The agent's EOA as reviewer**: forgeable, as in the threat above, and FR-012 requires the
  wallet.
- **Off-chain scoring signed by the operator**: puts the operator key in CI, which constitution
  IV forbids.

## R5. Demo cast, schedule and why the story plays out with all-time averages

`getSummary` has no time window. Two traps follow:
- once the gated wallet stops paying a service, its own ratings freeze;
- a newcomer with no reviews can never be paid by the gated wallet, so it would never earn any.

**Decision**: three wallets, all controlled by the one agent key (as in feature 001), with
different rules:

| Wallet | Role | Allowlist | Reputation rule | Rates |
| --- | --- | --- | --- | --- |
| `research-bot-01` | **gated agent** (the story) | only 001's `SERVICE_PAYEE` (`/quote`); none of the new services | **on**: avg ≥ 70 from ≥ 3 trusted reviews | every service it pays, including `/quote` |
| `scout-02`, `scout-03` | **scouts** that keep reputation fresh | reliable, flaky, newcomer payees | off | every demo service they pay |

- Trusted reviewers for `research-bot-01`: all three wallets.
- The services are owned by a separate **services-owner** account, so the registry's
  self-feedback ban never trips (FR-012).
- **Each scheduled run** (every 6 h, 4 per day, as in 001):
  1. both scouts pay and rate each open service;
  2. then the gated wallet tries each service.

  So a service gets 2 scout ratings per run, plus 1 more if the gated wallet pays it.

**The services** (one Worker, separate routes, separate payees, separate identities). Each
service's behaviour depends only on server time. The agent chooses the payment nonce, so nothing
it controls can steer a service's quality:

| Service | Behaviour (deterministic, configured at deploy) | Score it earns (R6) |
| --- | --- | --- |
| quote (001's `/quote`) | always fresh. Now also has an identity, so the gated wallet's payments to it are rated (FR-009) | 90 |
| reliable | always fresh, well-formed | 90 |
| flaky | fresh until `FLAKY_DEGRADE_AT` (launch + 12 h), then **always** stale (`asOf` 1 hour old). In the spec's words it "sometimes returns stale data": good at first, then not | 90, then 40 |
| newcomer | answers 503 (no 402, so nothing to pay or rate) until `NEWCOMER_OPENS_AT` (launch + 36 h), then always fresh | none, then 90 |
| impostor | claims reliable's `agentId` with its own `payTo` (US6) | never paid |

**Arithmetic** (rule: avg ≥ 70, count ≥ 3; 2 scout ratings per run, plus 1 from the gated
wallet when it pays):

- **Reliable**:
  - after run 1: 2 ratings, so the gated wallet is refused for `NOT_ENOUGH_TRUSTED_REVIEWS` in
    that run (scouts go first);
  - from run 2 there are 4 or more ratings at 90, so it's payable.
- **Flaky**, worst case:
  - **Most healthy history**: GitHub cron drift could fit 3 runs into the first 12 h (launch run
    plus two cron runs), giving at most 2 + 3 + 3 = 8 ratings at 90 (sum 720).
  - **Crossing**: after degrading, every rating is 40. The average falls below 70 when
    (720 + 40n) / (8 + n) < 70, i.e. n > 5.3. That's 6 ratings, at most 2 runs (the gated wallet
    adds its own 40s while it still pays).
  - **Timing**: the crossing comes **no later than about 24 h after launch** (12 h, plus 2 runs
    of 6 h), and about 18 h in the expected case. That's well inside SC-004's 3 days, even with
    a run or two missed.
  - **No flip-back**: every rating after `FLAKY_DEGRADE_AT` is 40 < 70, so the all-time average
    falls with every new rating and can never climb back over 70. The gated wallet is refused
    `PAYEE_REPUTATION_TOO_LOW` on **every** later attempt (SC-004).
- **Newcomer**:
  - before it opens, its 503 means no payment attempt and no refusal event;
  - in the **first run after it opens**, the scouts rate it twice. The gated wallet, trying it
    next in the same run, is refused `NOT_ENOUGH_TRUSTED_REVIEWS` (count 2 < 3), which covers
    US4 #2;
  - from the next run it has 4 ratings at 90 and is payable, about 42–48 h after launch;
  - the dashboard shows the status flip.
- **Quote** (001): allowlisted, so it's always payable. Its ratings come only from the gated
  wallet, and they never affect any decision.

**Effect on feature 001's scenario**: with the rule on, an unlisted payee with no identity is
refused `PAYEE_IDENTITY_UNVERIFIED` (8) by the gated wallet, not `PAYEE_NOT_ALLOWED` (3). So:
- 001's "payee not allowed" probe moves to `scout-02`, where the rule is off and it is still
  refused with 3, so that reason stays visible on the dashboard;
- every outcome the scenario expects is now computed from `checkPayee` just before each attempt,
  instead of being hard-coded.

001's quickstart still passes. Its scenario 2 runs the payee probe on a rule-off wallet.

Times are set by environment variables in the Worker. They're recorded at launch in
`config/services.json`, so the timeline can be explained.

**Alternatives considered**:
- **Operator edits allowlists by hand to bootstrap the newcomer**: violates FR-017 (no manual
  steps).
- **Time-window via `tag2 = "2026-W41"`**: adds string reads per entry, which costs more gas,
  and doesn't bound the loop. Revisit only if the scale limit (R7) bites.

## R6. Deterministic scoring (FR-011)

The response of a quote call is `{ pair, price, asOf, source }`. The score is a pure function of
the response and the request time. Tags are fixed.

| Check, in order | Score | `tag` |
| --- | --- | --- |
| Not JSON, a missing field, or the wrong types | 10 | `malformed` |
| `pair` ≠ the requested pair, or `price ≤ 0` | 20 | `wrong-data` |
| `now − asOf > 300 s` | 40 | `stale` |
| otherwise | 90 | `accurate` |

- Results ≥ 80 or < 50 match the spec's acceptance scenarios.
- It lives in `packages/agent/src/scoring.ts` and is unit-tested with fixtures: same input, same
  score.
- The agent only calls `rate` after a settled payment (on-chain enforced, R4). Refused attempts
  are never rated (US2 #3).

## R7. Gas and scale of the on-chain check

- **Per-entry cost**: `getSummary` costs about 2.6k gas per matching entry (one cold storage read
  plus loop overhead), plus a fixed ~30k.
- **Growth**: in the busiest case, flaky gets 3 ratings per run, 4 runs a day, about 360 a month.
- **Gas budget**: `REGISTRY_GAS = 5_000_000` (Base Sepolia block gas limit is 1.2 B, verified).
  That covers about 1,900 entries per service, **about 5 months** at this schedule.
- **Cost**: about 0.006 gwei × 3 M gas ≈ 0.00002 test ETH per authorisation. It stays $0.
- **When we near the limit**:
  - the scheduled job reads `count` every run, and the dashboard shows a warning above 1,500;
  - the operator then rotates in fresh scout wallets as trusted reviewers and retires the old
    ones (their old ratings stop counting, as the spec's edge case allows), or reduces the
    schedule;
  - past the limit, the check fails **closed** (`REPUTATION_UNAVAILABLE`), never open.
- **Bounded reviewer list**: `MAX_TRUSTED_REVIEWERS = 5` keeps the per-reviewer overhead
  bounded.

## R8. Third-party upgradeable registries

The registries' owner can upgrade them at any time (UUPS). A silent upgrade could change
`getSummary` semantics.

**Decisions**:
- `config/erc8004.json` pins proxy and implementation addresses (R1) and `getVersion() = "2.0.0"`.
- **Every scheduled run checks for upgrades**:
  1. it reads the ERC-1967 implementation slot
     (`0x360894a1…382bbc`) of both proxies and compares it with the pin;
  2. on a mismatch it **stops before paying** (exit 4), and the dashboard shows "registry
     changed, demo paused for review".
- **Fork tests** run against Base Sepolia at a **pinned block**, so CI stays deterministic.
- Accepting a new implementation is an explicit, recorded owner decision: update the pin and
  re-run the fork tests.

## R9. Registering the services (owner steps, keys)

- **Gas**: a separate **services-owner** key registers each service, so it needs test ETH.
- **Payment address**: each identity's `agentWallet` must equal the service's `payTo`.
  - This needs an `AgentWalletSet` signature **from each payee key**, valid for at most 5
    minutes. A payee needs no ETH for that, only its key, once, locally.
  - Alternatively, register from the payee account itself, but then every payee needs ETH and
    becomes the owner.
  - **Decision**: the services-owner registers, and each payee key signs once.
- **New local-only keys** (constitution IV: never in CI):
  - `SERVICES_OWNER_PRIVATE_KEY`;
  - `PAYEE_RELIABLE_PRIVATE_KEY`, `PAYEE_FLAKY_PRIVATE_KEY`, `PAYEE_NEWCOMER_PRIVATE_KEY`;
  - **001's `SERVICE_PAYEE` key**, which the owner already holds. It signs once so that 001's
    `/quote` gets an identity too, which makes the gated wallet's `/quote` payments ratable
    (FR-009, SC-003).

  The reliable payee must **not** be 001's `SERVICE_PAYEE`. That address stays allowlisted for
  001's `/quote`, and reusing it would let the gated wallet pay "reliable" through the allowlist,
  which would bypass the story.
- **The impostor** claims reliable's identity, so it needs no registration and no key. Its
  payee is any fresh address.
- **Where the scripts run**: `register-services` and `set-agent-wallet` run on the owner's
  machine only. CI never needs these keys.
- **Registration file**: each `agentURI` (four identities: quote, reliable, flaky, newcomer) is a `data:application/json;base64` registration file
  (R1 shape) with `name`, `description`, the x402 endpoint, `x402Support: true` and
  `supportedTrust: ["reputation"]`. It's fully on-chain, no hosting, $0.

## R10. Dashboard numbers equal the registry (FR-015)

- **Current averages and counts**: read with `getSummary(agentId, trustedReviewers, "", "")`,
  the same call and arguments the wallet uses, not recomputed from logs. The registry truncates
  its integer division, so recomputing could be off by one.
- **Score history**: `getSummary` is all-time and has no history.
  - The scheduled job records a **reputation snapshot per service per run** in `history.json`;
  - the trend line is those snapshots;
  - status flips are derived from consecutive snapshots and from the gated wallet's `Refused`
    and `Authorized` events.
- **Individual ratings**: rebuilt from `NewFeedback` logs (filtered by `agentId` and by
  `clientAddress` ∈ the demo wallets), joined with the wallet's `PaymentRated` events. Each links
  to its Basescan transaction.
- **Without JavaScript**: everything above is in `history.json`, so the page renders without
  JS. The live feed only adds new rows.

## R11. Dependencies and versions

No new runtime dependencies. This feature reuses feature 001's stack:
- Foundry and OpenZeppelin 5.6.1 (`Address`, `ECDSA`);
- viem 2.57 (`signTypedData` for `AgentWalletSet`, `getLogs` and `readContract`);
- `@x402/*` 2.28 (hooks and `extra`);
- Hono and Astro.

The ERC-8004 interfaces are vendored as two small Solidity interfaces plus viem ABIs, so no
package is needed.

## R12. Security review (T042, 2026-10-09)

Scope: `contracts/src/` (PolicyWallet reputation changes, `IPolicyWalletReputation`,
`interfaces/IERC8004`, `Reason`, `Deploy.s.sol`) and the agent SDK (`signer`, `identity`, `rate`,
`registries`, `pay`, `cli`). Method: `/security-review` plus the T042 checklist.

**Result: no high-confidence vulnerabilities.**

| Check | Result |
| --- | --- |
| Assembly bounds (`_readAgentWallet`, `_readSummary`) | Fixed gas, fixed 32/96-byte buffers, `returndatasize()` exactly 32/96, every word range-checked; failures → `REPUTATION_UNAVAILABLE`. Mutation-tested |
| Gas guard | Before any state change. `test_lowGas_minimumPassingGasStillFundsTheRegistry` proves the minimum passing gas still gives the summary read its full 5 M; margin raised to 200k (20k fails the test) |
| Checks-effects-interactions in `rate` | `rated = true` before `giveFeedback`; a registry revert reverts `rate` and leaves it unrated (tested) |
| `agentId` never caller-supplied in `rate` | Read from the attempt record, written only after the identity check passed |
| Allowlist never skips the mismatch check | 3a runs before 3b; tested on mock and fork. Only a *failed* identity read lets an allowlisted payee pass, without identity (so not ratable) |
| Append-only `Reason` | 0–7 unchanged; a test pins 7 and 12 |

Attack paths ruled out: forged reputation with a stolen agent key (needs an identity-checked,
settled payment to an operator-allowlisted or already-reputable payee); a false "settled" via
FiatToken `cancelAuthorization` (its digest is never reserved, so ERC-1271 rejects it);
impersonation (other wallet, unknown id, transferred NFT, old address after a wallet change);
a hostile service's `extra.erc8004` (only chooses which id the contract verifies).

Noted, not fixed (no security impact): `rateOutcome` truncates the endpoint to 200 characters while
the contract limits 200 bytes, so a non-ASCII URL could make `rate` revert (no rating).
