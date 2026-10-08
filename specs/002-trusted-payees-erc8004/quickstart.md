# Quickstart: Trusted Payees (validation guide)

How to prove feature 002 works end to end on Base Sepolia. Run it after **001's MVP** (user
stories 1–3) is deployed and its quickstart passes.

Interfaces:
- [contracts/policy-wallet-reputation.md](./contracts/policy-wallet-reputation.md)
- [contracts/paid-services.md](./contracts/paid-services.md)
- [contracts/agent-cli.md](./contracts/agent-cli.md)
- [contracts/dashboard.md](./contracts/dashboard.md)

Rules and reasons: [data-model.md](./data-model.md).

## Prerequisites

- 001 deployed: factory, `research-bot-01` funded with USDC, the Worker live at
  `api.demo.yunshu.ai`, the dashboard live.
- **New local-only keys in `.env`** (owner step, constitution IV):
  - `SERVICES_OWNER_PRIVATE_KEY`, funded with a little Base Sepolia ETH;
  - `PAYEE_RELIABLE_PRIVATE_KEY`, `PAYEE_FLAKY_PRIVATE_KEY`, `PAYEE_NEWCOMER_PRIVATE_KEY`, which
    need no ETH;
  - `PAYEE_IMPOSTOR`, an address only;
  - 001's `SERVICE_PAYEE` key, used once, so `/quote` gets an identity.

  None of these go to CI.
- **Two scout wallets**, `scout-02` and `scout-03`:
  - created with 001's `create-wallet` (same agent key), funded with 10 USDC each. Each scout
    spends about 0.12 USDC a day (3 services × 0.01 × 4 runs), so that lasts about 80 days. Top
    up monthly;
  - allowlisted for the reliable, flaky and newcomer payees.

## Setup

```bash
npx agent-wallet register-services            # ids → config/services.json
npx agent-wallet reputation                    # each service: registered wallet == payTo
# set Worker vars (AGENT_ID_*, PAYEE_*, FLAKY_DEGRADE_AT=+12h, NEWCOMER_OPENS_AT=+36h) and deploy
npx agent-wallet trust-reviewer --wallet research-bot-01 <research-bot-01>
npx agent-wallet trust-reviewer --wallet research-bot-01 <scout-02>
npx agent-wallet trust-reviewer --wallet research-bot-01 <scout-03>
npx agent-wallet set-reputation --wallet research-bot-01 --min-avg 70 --min-count 3
```

## Scenarios

| # | Do | Expect | Covers |
| --- | --- | --- | --- |
| 1 | `forge test` (unit, fuzz, invariant) and `forge test --match-path test/fork/*` | All pass. Fuzz runs ≥ 1,000 per new reason; fork tests run at the pinned block | SC-001, SC-002, constitution III |
| 2 | `reputation` right after setup | Each of quote, reliable, flaky and newcomer: identity found, `registeredWallet == payTo`, count 0 | US4 #1, FR-007/008 |
| 3 | `pay …/s/reliable/quote` from `research-bot-01` before any reviews | Refused `NOT_ENOUGH_TRUSTED_REVIEWS`, balance unchanged | US1 #3 |
| 4 | Scouts: `pay --rate …/s/reliable/quote` twice each | 4 `PaymentRated` + `NewFeedback` events, score 90 `accurate`, `feedbackHash` = nonce. `reputation` shows count 4, avg 90 | US2 #1, FR-009 |
| 5 | `pay --rate …/s/reliable/quote` from `research-bot-01` | Settled, then rated. `PayeeIdentityVerified` emitted | US1 #1 |
| 6 | Give 5 ratings of 100 to reliable from 5 **untrusted** fresh wallets, then compare `checkPayee` before and after | Identical result. Dashboard and `reputation` count unchanged | US1 #4, SC-002 |
| 7 | `pay …/s/impostor/quote` from `research-bot-01` | Refused `PAYEE_IDENTITY_MISMATCH`, no funds moved | US6 #1 |
| 8 | `pay …/s/anonymous/quote` from `research-bot-01` | Refused `PAYEE_IDENTITY_UNVERIFIED` | US6 #2 |
| 9 | `pay --rate …/quote` (001's allowlisted payee) with the rule on | Allowed, as in 001, then rated | US1 #5, FR-009 |
| 9b | 001's `run-scenario` probes | 001's "payee not allowed" probe on `scout-02` is refused with 3. On `research-bot-01` an unlisted, identity-less payee is refused with 8. Both match `checkPayee` | 001 compatibility |
| 10 | Try to call `rate` on a refused nonce, a nonce from another wallet, or an already-rated nonce | Each reverts. No `NewFeedback` | US2 #3, FR-010 |
| 11 | Scouts rate flaky after `FLAKY_DEGRADE_AT` (or call `scoreQuote` on a stale fixture) | Ratings < 50 tagged `stale` | US2 #2, FR-011 |
| 12 | Run the schedule (`agent-run.yml`) for 3 days | Flaky crosses below 70 by about 24 h after launch (worst case), then every later gated attempt is refused `PAYEE_REPUTATION_TOO_LOW`. In the first run after the newcomer opens, the gated wallet is refused `NOT_ENOUGH_TRUSTED_REVIEWS`; it becomes payable about 42–48 h after launch. Every settled call in every run has its rating | US4 #2, US5, SC-003, SC-004, FR-017 |
| 13 | Dashboard `/` and `/zh/` | Rule in plain words, reviewers, a card per service with average, count, payable status and since, trend, rated rows linked to Basescan. Works without JS | US3, FR-013/014/016 |
| 14 | `node scripts/check-reputation.ts` | Every service's `summary` equals `getSummary` at the snapshot block | FR-015, SC-005 |
| 15 | Temporarily edit `config/erc8004.json`'s pinned implementation, then run `run-scenario` | Exit 4 before any payment | research R8 |
| 16 | Unit test: a mock registry that reverts, burns gas, returns garbage or returns 1 MB | `REPUTATION_UNAVAILABLE`, never a revert or pass. Sending too little gas reverts | Edge cases, research R2 |
| 17 | Check the bills after a month | $0: Cloudflare free tier, test ETH only | SC-007, FR-018 |

## Not covered here

- SC-006, the 60-second test with 5 non-technical testers, is a manual usability session after
  launch.
- ERC-8004 validation registry, mainnet and AI judgement are out of scope (spec).
