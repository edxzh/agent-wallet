# Data Model: Trusted Payees (Reputation-Gated Spending)

Extends [feature 001's data model](../001-agent-wallet-demo/data-model.md). Everything there
still holds. This file lists only what's new or changed.

The sources of truth are on-chain:
- the `PolicyWallet` state and events;
- the ERC-8004 Identity and Reputation registries (research R1).

`history.json` stays a derived, rebuildable cache.

## Entities

### Reputation rule (per `PolicyWallet`, new)
| Field | Type | Rules |
| --- | --- | --- |
| `enabled` | bool | Can only be set `true` while `trustedReviewers` is non-empty (edge case "no trusted reviewers") |
| `minAverage` | uint8 | 0–100. Compared against the registry average, normalised to its returned decimals |
| `minCount` | uint64 | ≥ 1 while enabled. Number of non-revoked trusted ratings required |
| `trustedReviewers` | address[] | ≤ `MAX_TRUSTED_REVIEWERS` (5), no duplicates, no zero address. Passed to `getSummary` as the client list |

- Only the operator can change it (FR-006). Every change emits `RuleChanged`:
  - field `"repEnabled"`, `"repMinAverage"` or `"repMinCount"`;
  - or field `"trustedReviewer"`, with key = the reviewer address and value 0/1.
- Removing a reviewer takes effect from the next check (edge case).
- Disabling the rule while reviewers remain is allowed.
- Removing the last reviewer while the rule is enabled **reverts**. The operator must disable the
  rule first, so the rule can never be on with zero reviewers.

### Trusted reviewer (new)
- An address in `trustedReviewers`.
- In the demo it's one of the three demo `PolicyWallet`s (research R5).
- It must never own, or be approved for, a service identity. The registry enforces this on every
  rating.

### Service identity (external: ERC-8004 Identity Registry)
| Field | Source | Rules |
| --- | --- | --- |
| `agentId` | `register()` return value | **Starts at 0**, so "no identity" is a separate flag, never id 0 |
| `owner` | `ownerOf(agentId)` | The services-owner account. Never a reviewer |
| `agentWallet` | `getAgentWallet(agentId)` | Must equal the service's x402 `payTo` (FR-007). Reads `address(0)` for an unknown id or after a transfer |
| `agentURI` | `tokenURI(agentId)` | `data:application/json;base64` registration file: `name`, `description`, x402 endpoint, `supportedTrust: ["reputation"]` |

Off-chain mirror: `config/services.json`, one entry per demo service:
- `key` (`quote` | `reliable` | `flaky` | `newcomer` | `impostor` | `anonymous`);
- `agentId`, `payTo`, `route`, `label` (en and zh);
- `opensAt` and `degradeAt` where they apply.

### Rating (external: ERC-8004 Reputation Registry, written through the wallet)
| Field | On-chain value | Rules |
| --- | --- | --- |
| reviewer | `clientAddress` = the `PolicyWallet` | FR-012 |
| `agentId` | taken from the attempt record, never from the caller | research R4 |
| `value` / `valueDecimals` | `score` / `0` | `score` ∈ 0–100 |
| `tag1` | reason tag | One of `accurate`, `stale`, `wrong-data`, `malformed`. ≤ 32 bytes |
| `tag2` | `"agent-wallet/v1"` | Lets anyone filter this demo's ratings |
| `endpoint` | the paid URL | ≤ 200 bytes, display only |
| `feedbackURI` | `""` | Unused |
| `feedbackHash` | the payment `nonce` | Links the rating to its payment (FR-009) |
| `feedbackIndex` | returned in the `NewFeedback` event | Echoed in the wallet's `PaymentRated` event |
| `isRevoked` | registry | Revoked ratings are excluded from summaries (FR-004) |

### Payment attempt (extended from 001)
New fields stored by `authorizeWithIdentity` (Design A) or `payWithIdentity` (Design B):

| Field | Type | Rules |
| --- | --- | --- |
| `hasIdentity` | bool | `true` only if an identity was claimed **and** the identity check passed |
| `payeeAgentId` | uint256 | Valid only when `hasIdentity` |
| `rated` | bool | Set by `rate`. A nonce is rated at most once |

### Reputation snapshot (derived, `history.json`)
One per service per scheduled run:

```text
{ service: key, agentId, block, time, count, average, decimals,
  payableByGated: bool, reasonIfNot?: Reason }
```

- `count` and `average` are copied verbatim from `getSummary(agentId, trustedReviewers, "", "")`
  at `block` (FR-015).
- `payableByGated` comes from a dry-run of the gated wallet's checks at the same block, through
  the `checkPayee` view.

### Record entry (extended from 001, derived)
New `kind`s:
- `rated`, with `wallet`, `nonce`, `agentId`, `score`, `tag`, `feedbackIndex` and `txHash`;
- `statusChanged`, with `service`, `from`, `to` and `time`, derived from consecutive snapshots.

Reputation refusals use 001's `refused` kind with the new reasons.

## Refusal reasons (spec FR-005 → contract code)

The new values are **appended** after 001's, so 001's event values stay stable:

| Spec reason | `Reason` | When |
| --- | --- | --- |
| payee identity unverified | `PAYEE_IDENTITY_UNVERIFIED` = 8 | Not allowlisted, rule on, no identity claimed |
| payee identity mismatch | `PAYEE_IDENTITY_MISMATCH` = 9 | Identity claimed and `getAgentWallet(agentId) ≠ payee` (including `address(0)`). Applies **even if allowlisted** |
| reputation unavailable | `REPUTATION_UNAVAILABLE` = 10 | Not allowlisted, rule on, and a registry call failed (call failed, bad return, or gas budget exhausted) |
| not enough trusted reviews | `NOT_ENOUGH_TRUSTED_REVIEWS` = 11 | `count < minCount` |
| payee reputation too low | `PAYEE_REPUTATION_TOO_LOW` = 12 | `count ≥ minCount` and `average < minAverage` |

## Check order (replaces 001's step 3, "payee allowed")

Steps 1–2 (`PAUSED`, `INVALID_AMOUNT`) and 4–7 (cap, task, daily, funds) are unchanged. Step 3
becomes:

```text
3a. identity claimed?
      ├─ read getAgentWallet(agentId) (staticcall, fixed gas)
      │    ├─ call failed ─▶ allowlisted? continue without identity : REFUSE REPUTATION_UNAVAILABLE
      │    └─ wallet ≠ payee ─▶ REFUSE PAYEE_IDENTITY_MISMATCH
      └─ ok ─▶ hasIdentity = true
3b. payee allowlisted? ─▶ pass (go to 4)
3c. rule disabled?     ─▶ REFUSE PAYEE_NOT_ALLOWED            (001 behaviour)
3d. no identity?       ─▶ REFUSE PAYEE_IDENTITY_UNVERIFIED
3e. getSummary(agentId, trustedReviewers, "", "") (staticcall, REGISTRY_GAS)
      ├─ call failed / malformed ─▶ REFUSE REPUTATION_UNAVAILABLE
      ├─ count < minCount         ─▶ REFUSE NOT_ENOUGH_TRUSTED_REVIEWS
      ├─ average < minAverage     ─▶ REFUSE PAYEE_REPUTATION_TOO_LOW
      └─ pass (go to 4)
```

- **Before 3a**: if `gasleft() < (IDENTITY_GAS + REGISTRY_GAS) × 64/63 + margin`, the call
  **reverts** (`IDENTITY_GAS = 100_000`, `REGISTRY_GAS = 5_000_000`). Too little gas
  isn't a policy outcome, and this stops an agent from forcing a fake `REPUTATION_UNAVAILABLE`
  entry onto the record (research R2).
- **Exactly one reason**: the first failing check sets the reason, as in 001.
- **No identity claimed**: if the caller uses 001's `authorize` (no identity), 3a is skipped. 001
  behaviour is identical whenever the rule is disabled.

## State machine: payment attempt (extended)

```text
authorize / authorizeWithIdentity ── check fails ──▶ Refused(reason)                [final]
        │ pass
        ▼
   Authorized ──▶ Settled ──(hasIdentity, agent calls rate)──▶ Settled+Rated          [final]
        └──▶ Expired (release, as 001)                                                 [final]
```

`rate(nonce, …)` reverts unless all of these hold:
- the caller is the agent;
- the attempt `hasIdentity`;
- it settled: Design A `USDC.authorizationState(this, nonce) == true`, Design B a settled
  `pay()` record;
- it isn't already `rated`;
- `score ≤ 100`, and the tag and endpoint are within their length limits.

Reverting is right here: a rating attempt isn't a policy outcome that needs recording.

## Validation rules (summary)

| Rule | Source | Proven by |
| --- | --- | --- |
| Non-allowlisted payees that fail the rule move no funds, for each new reason | FR-002, SC-001 | Fuzz, one per reason (≥ 50 cases total) |
| Ratings from untrusted reviewers never change a decision | FR-004, SC-002 | Fuzz: random untrusted feedback added to a mock registry → same outcome |
| A rating exists only for a settled, identity-checked, own payment, once | FR-009/010, research R4 | Unit + invariant: `rated ⇒ settled ∧ hasIdentity`, and no nonce rated twice |
| Registry failure means refusal, never a revert or a pass | Edge case, research R2 | Unit tests with a reverting, gas-burning or garbage-returning mock |
| Only the operator edits the rule and reviewers | FR-006 | Unit: agent and stranger revert for every setter |
| The rule can't be on with zero reviewers | Edge case | Unit + invariant |
| Real-registry behaviour matches the mocks | R1, R8 | Fork test at a pinned block: register, rate, summary, self-feedback revert |
