# Contract: Dashboard additions (`demo.yunshu.ai`)

Extends [001's dashboard](../../001-agent-wallet-demo/contracts/dashboard.md):
- the same routes, both languages, no-JS rendering and live tail;
- all new text lives in `src/i18n/{en,zh}.json` with identical keys (FR-016).

## New page sections

1. **Trust rule** (gated wallet):
   - the rule in plain words, e.g. "Pays unknown services only with an average of 70+ from at
     least 3 trusted reviewers" / "仅向获得至少 3 条可信评价、平均分 70 以上的未知服务付款";
   - the trusted reviewers with labels.
2. **Services**, one identity card each (US3):
   - name and description (from `agentURI`), the agent id linked to the registry, and the
     registered payment address;
   - trusted average and count, plus a trend sparkline from the snapshots;
   - **Payable** or **Not payable** with a plain-language reason;
   - "since" for the last status change.
3. **Timeline**: 001's rows, plus:
   - `rated` rows ("research-bot-01 rated Reliable quotes 90 · accurate"), linked to the
     `giveFeedback` transaction;
   - reputation refusals in plain language;
   - `statusChanged` rows.

**Reason text** (`reason.*`):

| Code | English | Chinese |
| --- | --- | --- |
| `PAYEE_IDENTITY_UNVERIFIED` | Service has no verified identity | 服务没有经过验证的身份 |
| `PAYEE_IDENTITY_MISMATCH` | Service claimed someone else's identity | 服务冒用了他人的身份 |
| `REPUTATION_UNAVAILABLE` | Couldn't read reputation, so it didn't pay | 无法读取信誉，因此未付款 |
| `NOT_ENOUGH_TRUSTED_REVIEWS` | Not enough reviews from trusted reviewers yet | 可信评价数量还不够 |
| `PAYEE_REPUTATION_TOO_LOW` | Trusted reviewers rate this service too low | 可信评价方给这个服务的评分太低 |

## `history.json` additions

```jsonc
{
  "erc8004": { "identity": "0x8004A818…", "reputation": "0x8004B663…",
               "implementations": { "identity": "0x7274e874…", "reputation": "0x16e0FA7f…" },
               "pinnedOk": true },
  "reputationRule": { "wallet": "0x…", "enabled": true, "minAverage": 70, "minCount": 3,
                      "trustedReviewers": [{ "address": "0x…", "label": "scout-02" }] },
  "services": [{
    "key": "flaky", "agentId": "8", "name": "…", "description": "…", "payTo": "0x…",
    "registeredWallet": "0x…",
    "summary": { "count": 14, "average": 61, "decimals": 0, "block": 47900000 },   // verbatim getSummary (FR-015)
    "payable": false, "reason": "PAYEE_REPUTATION_TOO_LOW", "since": "2026-10-10T06:00:00Z",
    "snapshots": [{ "time": "…", "count": 5, "average": 90, "payable": true }]     // one per run, capped at 400
  }],
  "wallets": [ /* 001, events now include kind "rated" and "statusChanged" */ ]
}
```

## Consistency (FR-015, SC-005)

- `summary` is copied verbatim from `getSummary(agentId, trustedReviewers, "", "")` at
  `summary.block`.
- Averages are never recomputed client-side.
- A CI check (`scripts/check-reputation.ts`) re-reads `getSummary` at the snapshot block for every
  service and fails on any difference.
- The live tail adds `NewFeedback` logs filtered by `agentId` for the demo services and by
  `clientAddress` ∈ the demo wallets.
- It refreshes `summary` with one `getSummary` call per service each poll, no faster than every
  30 s for these calls.
