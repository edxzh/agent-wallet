# Quickstart results: Trusted Payees (live, Base Sepolia)

Results of the [quickstart](./quickstart.md) scenarios on the live network. Transactions link to
`https://sepolia.basescan.org/tx/<hash>`.

Setup recorded in [tasks.md](./tasks.md) T043/T044:
- research-bot-01 (gated) `0xC788272Fe9c76810ef1bA2539B56822405eDb0Fc`;
- scout-02 `0x1dAb793c0dBF670bd03935A54Ab9833A20cb704B`;
- scout-03 `0x3E8441303A46c56FD2E0492Bd41838A14d57C438`;
- rule: average ≥ 70 from ≥ 3 reviews by those three wallets.

## US4: scenarios 2, 3, 4, 5 and 9 (T045)

Run 2026-10-10, 09:26–09:29 UTC, from the CLI (`pay … --wallet <w> [--rate]`). The moment
"right after setup, before any reviews" had passed by then (the first scheduled trust run rated
at 01:02 UTC), so scenarios 2 and 3 are checked against the chain **as it was** at that time:
reads pinned to a past block, and the refusal the scheduled run already made.

### Scenario 2: identities right after setup

Read at block **47912910** (01:01:48 UTC), the last block before the first rating:

| Service | Identity | `getAgentWallet` == `payTo` | Trusted count | `checkPayee` (gated) |
| --- | --- | --- | --- | --- |
| quote | #9613 | ✓ `0xD0cf…E1B6` | 0 | `NONE` (allowlisted, identity matches) |
| reliable | #9614 | ✓ `0x9c88…9b3A` | 0 | `NOT_ENOUGH_TRUSTED_REVIEWS` |
| flaky | #9615 | ✓ `0x3e7d…2f70` | 0 | `NOT_ENOUGH_TRUSTED_REVIEWS` |
| newcomer | #9616 | ✓ `0x61AD…1D6B` | 0 | `NOT_ENOUGH_TRUSTED_REVIEWS` |

**Pass.** Each identity is found and registered to the service's `payTo`, with no reviews.

### Scenario 3: the gated wallet pays reliable before it has enough reviews

The 01:0x UTC trust run, after the scouts' first two ratings:
- At block 47912973, reliable had a trusted count of 2 (avg 90), so `checkPayee` gave `NOT_ENOUGH_TRUSTED_REVIEWS`.
- The attempt in the next block was refused with that reason:
  [`0x83393087…a20039`](https://sepolia.basescan.org/tx/0x83393087e46122cbc9834819a096a3e991fc1cd449c12182d64dfff0b4a20039).
  The transaction emits only the wallet's refusal event, with no USDC transfer.

**Pass**: the same refusal and the same "balance unchanged" result. The count was 2, not 0,
but the rule needs 3.

### Scenario 4: scouts pay reliable and rate it, twice each

| Wallet | Settlement | Rating (score, tag, feedbackIndex) |
| --- | --- | --- |
| scout-02 | [`0x40369d11…`](https://sepolia.basescan.org/tx/0x40369d1102aa283b1275f70d61f414321541f7e2380d23c997ee9488eddf7bb7) | [90 `accurate` #3](https://sepolia.basescan.org/tx/0x5feef5bd0c22c3bb75fc662cdb3f6850b34a6299783896bd01f0b466e18faa12) |
| scout-02 | [`0x987ea497…`](https://sepolia.basescan.org/tx/0x987ea497205aa3bafb01707d5dec566adfa2a633a4f1b2b4f7f22c6376e75ffe) | [90 `accurate` #4](https://sepolia.basescan.org/tx/0xe9fe7920944521b8b239f8e74db7c290f8a32c40b913ddea0e864c1d5ae068f8) |
| scout-03 | [`0x762d3f2c…`](https://sepolia.basescan.org/tx/0x762d3f2c44b518a1c738a2df6b536b7452c7d734dc376e9a4dba49d6c78e1db2) | [90 `accurate` #3](https://sepolia.basescan.org/tx/0x0aa12d719c1d76826eaf29639dad9286a90eec4cfbd3e41fda03481f28e38444) |
| scout-03 | [`0x60f228fe…`](https://sepolia.basescan.org/tx/0x60f228fe8afc034eb061a9c6a20d3c89ccf0af6f1aaaf953936b4d47185f38dd) | [90 `accurate` #4](https://sepolia.basescan.org/tx/0x525b12b0bc275bb883dfe5cf0a0e6685a19dd82cd4be729c1535923608955c5d) |

Each rating transaction emits the registry's `NewFeedback` and the wallet's `PaymentRated`.
In the first one, the payment nonce `0xd52a88f4…5cf7` is the `NewFeedback` `feedbackHash`
(in its data) and is the indexed `nonce` of `PaymentRated`. Afterwards, `reputation`
reports reliable with a trusted count of 10 at average 90:
- the scheduled runs had already rated it 5 times;
- this scenario adds 4 ratings;
- scenario 5 adds 1.

The quickstart's "count 4" assumed a fresh start.

**Pass.**

### Scenario 5: the gated wallet pays reliable, then rates it

- Authorize [`0x1db491b8…`](https://sepolia.basescan.org/tx/0x1db491b8fccfaef262b38259ce3b0330111037b0539c2730cd6a07a1a4ae73a0) emits `PayeeIdentityVerified(nonce, 9614, payee)` (topic `0xd37c2e8b…`).
- Settled [`0xf72d9c71…`](https://sepolia.basescan.org/tx/0xf72d9c71d9b28b722a11dc097bbbabc3952d87dd3241d5ce713f45f446e00235).
- Rated 90 `accurate` [`0x820ab231…`](https://sepolia.basescan.org/tx/0x820ab23128bbe09241fe93a06f29e47c255c4cb09e274d9703aa4fbebd89fad2).

**Pass.**

### Scenario 9: 001's allowlisted `/quote` with the rule on

- Authorized with identity #9613 [`0xfcddafe9…`](https://sepolia.basescan.org/tx/0xfcddafe975119c5cca2609299a26ac83fc564a9bf7076aca90f36b3a14db79d3).
- Settled [`0x29cb4784…`](https://sepolia.basescan.org/tx/0x29cb4784d16729582ff0435af10515b4be39d96d6ddd7d481fd32c4a1ea7cb5a).
- Rated 90 `accurate` [`0xd8341104…`](https://sepolia.basescan.org/tx/0xd8341104d6e3e3bb66c91388ee33d2dc8cf080a99f15036f30dd468d6445382f).

Quote's trusted average is below 70: it is 66 before this rating, because of the launch-run
bug's two 20 ratings (T044). The payment is still allowed, because the allowlist decides for an
allowlisted payee and the identity only has to match.

**Pass.**

### Also seen: the launch run's failed payment

In the 06:01 UTC scheduled run, scout-02's flaky payment was authorized and then answered with a
bare `402 {}`. It never settled, and the run exited 2. This is the intermittent failure from 001.
It is now narrowed to the facilitator's settle call throwing, and handled by resending the same
signed payment. See commit `c0887cc` and the T047 notes in [tasks.md](./tasks.md).

## US6: scenarios 7 and 8 (T051)

Run 2026-10-10 09:28 UTC from research-bot-01 with the CLI.

| # | Request | Claims | Result | Transaction |
| --- | --- | --- | --- | --- |
| 7 | `pay …/s/impostor/quote` | reliable's identity #9614; payTo `0x7bd4…eEb1` ≠ its registered `0x9c88…9b3A` | Refused `PAYEE_IDENTITY_MISMATCH` | [`0xaf200382…`](https://sepolia.basescan.org/tx/0xaf2003828af3d32e3d152ca2e3377e67256ef42f0c0ef551c75acdefcdf6efae) |
| 8 | `pay …/s/anonymous/quote` | no identity, payee not allowlisted | Refused `PAYEE_IDENTITY_UNVERIFIED` | [`0x5ec44e3b…`](https://sepolia.basescan.org/tx/0x5ec44e3b529df567c9eadfccd997d23f9fa809c1f106334343abd32b234de78c) |

Each transaction emits only the wallet's refusal event, with no USDC `Transfer`, so no funds
moved. The scheduled runs made the same two refusals at 01:04 and 06:03 UTC, each matching
`checkPayee`.

Dashboard: the live `https://demo.yunshu.ai/` lists those earlier refusals in plain language:
- "Service claimed someone else's identity";
- "Service has no verified identity".

`/zh/` shows them as "服务冒用了他人的身份" and "服务没有经过验证的身份". Both are in the static
HTML, so they show without JS. The 09:28 refusals will appear with the next snapshot (the
12:17 UTC scheduled run), or right away in a browser through the live tail.

**Pass.**

## Registry safety: scenarios 15 and 16 (T055)

### Scenario 15: a changed registry stops the run before any payment

2026-10-10 ~12:35 UTC, run locally with the live config:
1. Changed `reputation.implementation` in `config/erc8004.json` by one character
   (`…dA34` → `…dA35`).
2. Ran `run-scenario`. It printed `scenario-start` (`trust: true`), then:

   ```json
   {"event":"scenario-step","step":"stop","reason":"ERC-8004 registry changed: demo paused for review","registry":"reputation","expected":"0x16e0Fa7F7c56B9A767e34b192B51F921bE31da35","actual":"0x16e0FA7f7C56B9a767E34B192B51f921BE31dA34"}
   ```

   It exited with **4**.
3. The agent account's transaction count stayed at 106 before and after (blocks 47933907–47933909),
   so nothing was sent: no `authorize`, no payment, no rating.
4. Restored the pin with `git checkout config/erc8004.json` (no diff left).

**Pass.**

### Scenario 16: registry failure modes and the low-gas revert

`forge test --match-test "test_registryFailures|test_lowGas|test_order_summaryFailure|test_order_allowlistedPassesWhenIdentityRegistryFails"`:
6 passed, 0 failed.

| Test | What it shows |
| --- | --- |
| `test_registryFailures_identity` | `getAgentWallet` reverts, burns all gas, returns garbage, or returns 4 KB that starts with a passing answer: each is refused `REPUTATION_UNAVAILABLE`, never a revert or a pass |
| `test_registryFailures_summary` | The same four modes on `getSummary`, with a 1 MB return: each refused `REPUTATION_UNAVAILABLE` |
| `test_order_summaryFailure` | A failing summary read refuses a payee that isn't allowlisted, with 10 |
| `test_order_allowlistedPassesWhenIdentityRegistryFails` | An allowlisted payee is still paid when the identity read fails, as in 001 |
| `test_lowGas_reverts` | `authorizeWithIdentity` with 1 M gas reverts `InsufficientGas`, and the nonce is not used |
| `test_lowGas_minimumPassingGasStillFundsTheRegistry` | The least gas that passes the guard (found by binary search) still gives a registry needing almost all of its 5 M budget enough to answer, so an agent can't force a false refusal 10 |

The identity read's oversized return is 4 KB, not the quickstart's 1 MB: its 100 k gas budget
can't build 1 MB. The test leads that return with a passing answer, so only the exact-size check
refuses it.

**Pass.**
