# Data Model: Agent Wallet Demo

The state lives **on-chain** in each `PolicyWallet`. The public record is the contract's events
plus USDC's own `AuthorizationUsed` and `Transfer` events. The dashboard's `history.json` is a
derived, rebuildable cache (see [contracts/dashboard.md](./contracts/dashboard.md)).

Amounts are USDC base units (6 decimals: `10000` = 0.01 USDC). Times are block timestamps in UTC.

## Entities

### Operator
| Field | Type | Rules |
| --- | --- | --- |
| `address` | address | Owner of every wallet the factory creates. The only account allowed to change rules (FR-003). Key held locally, never in CI |

### Agent wallet (`PolicyWallet`, one per agent)
| Field | Type | Rules |
| --- | --- | --- |
| `operator` | address | Set at creation, immutable |
| `agent` | address | The agent's signing key. Can only call `authorize`. The operator can rotate it (`setAgent`) |
| `token` | address | Base Sepolia USDC, immutable |
| `name` | string | Display name, e.g. `research-bot-01` |
| `paused` | bool | When `true`, every `authorize` is refused with `PAUSED` |
| `policy` | SpendingPolicy | See below |

### Spending policy
| Field | Type | Rules |
| --- | --- | --- |
| `perPaymentCap` | uint | > 0. A payment strictly above it is refused (`OVER_PER_PAYMENT_CAP`) |
| `dailyBudget` | uint | > 0. Sum of reserved amounts in the current UTC day must stay ≤ it |
| `allowedPayees` | mapping(address ⇒ bool) | Payee must be `true`, else `PAYEE_NOT_ALLOWED` |
| `spentToday` | (day ⇒ uint) | `day = block.timestamp / 86400`. Increases on authorize, decreases on release |

Lowering a limit below what's already spent is allowed. Further attempts are then refused until
the day rolls over or the limit is raised (edge case).

### Task
| Field | Type | Rules |
| --- | --- | --- |
| `taskId` | bytes32 | Created by the operator (`setTask`). Id `0x0` means "no task", which skips the task check |
| `label` | string | Shown on the dashboard, e.g. `market-research` |
| `budget` | uint | Sum of reserved amounts for this task must stay ≤ it |
| `spent` | uint | Increases on authorize, decreases on release |

An unknown non-zero `taskId` is refused as `OVER_TASK_BUDGET` (its budget is 0).

### Payee
| Field | Type | Rules |
| --- | --- | --- |
| `address` | address | Receives USDC |
| `label` | string | Off-chain display name from `config/payees.json` (e.g. "Yunshu demo quote API") |

### Payment attempt
Identified by `(wallet, nonce)`, where `nonce` is the EIP-3009 nonce (bytes32) from the x402
payment requirements, generated fresh per request.

| Field | Type | Notes |
| --- | --- | --- |
| `nonce` | bytes32 | Unique per wallet. Reuse **reverts** (replay; USDC also rejects reused nonces) |
| `payee`, `amount`, `taskId` | | From the authorization being signed |
| `validAfter`, `validBefore` | uint | From the authorization. `validBefore` is used by `release` |
| `digest` | bytes32 | EIP-712 digest of the USDC `TransferWithAuthorization`. `isValidSignature` accepts only reserved digests (Design A) |
| `status` | enum | See the state machine below |
| `reason` | enum | Set only when `Refused` |

### Record entry (derived, dashboard)
One row per event, ordered newest-first:

```text
{ kind: authorized | settled | refused | expired | ruleChange | paused | unpaused,
  wallet, nonce?, payee?, amount?, taskId?, reason?, ruleField?, oldValue?, newValue?,
  block, txHash, time }
```

`txHash` links to `https://sepolia.basescan.org/tx/<hash>` (FR-012).

## Refusal reasons (spec FR-007 → contract code)

| Spec reason | Contract `Reason` (uint8) | Raised by | Checked in order |
| --- | --- | --- | --- |
| agent paused | `PAUSED` = 1 | `authorize` | 1 |
| invalid amount | `INVALID_AMOUNT` = 2 | `authorize` (amount = 0, or validBefore ≤ now) | 2 |
| payee not allowed | `PAYEE_NOT_ALLOWED` = 3 | `authorize` | 3 |
| over per-payment cap | `OVER_PER_PAYMENT_CAP` = 4 | `authorize` | 4 |
| over task budget | `OVER_TASK_BUDGET` = 5 | `authorize` | 5 |
| over daily budget | `OVER_DAILY_BUDGET` = 6 | `authorize` | 6 |
| insufficient funds | `INSUFFICIENT_FUNDS` = 7 | `authorize` (`token.balanceOf(wallet) < amount`) | 7 |

The first failing check sets the reason, so each refusal carries exactly one (FR-007).

The funds check uses the current balance only. The wallet isn't called when USDC settles, so it
can't track outstanding reservations exactly. If two authorized payments together exceed the
balance, USDC rejects the second at settlement. It stays `Authorized` and becomes `Expired`
through `release`, returning its budget. Funds still can't move without authorization. Negative
amounts can't be expressed (`uint`), so the client rejects them before any transaction.

Not a refusal (it reverts): wrong caller, duplicate nonce. These are programming or replay
errors, not policy outcomes.

## State machine: payment attempt

```text
               authorize() ── any check fails ──▶ Refused(reason)            [final]
                   │
                   ▼ all checks pass (budget reserved, digest stored)
               Authorized ── USDC AuthorizationUsed(wallet, nonce) ──▶ Settled   [final]
                   │
                   └── now ≥ validBefore AND USDC authorizationState == unused
                         └── release(nonce) ──▶ Expired (budget returned)      [final]
```

- **Settled** comes from the token's own `AuthorizationUsed` event, not from a wallet call.
  Settlement goes through USDC, so the dashboard joins the two event streams by `nonce`.
- Under Design B, `pay()` moves straight from checks to `Settled` or `Refused`. There is no
  `Authorized` or `Expired`.

## State machine: agent wallet

```text
Active ⇄ Paused        (operator: pause / unpause; emits Paused / Unpaused)
Active: rules editable (setPolicy, setPayee, setTask, setAgent; each emits RuleChanged)
```

## Validation rules (summary)

- Spend can never exceed any limit, including under concurrent attempts (FR-005). Proven by a
  Foundry invariant (SC-002).
- No funds move on any refusal (FR-002). Proven by fuzzing every reason (SC-001).
- Only the operator changes rules, and the agent's calls to rule setters revert (FR-003).
- Each nonce is authorized at most once per wallet, and USDC settles it at most once (FR-010).
- Every authorize outcome and rule change emits exactly one event (FR-011), and events can't be
  removed (FR-013).
