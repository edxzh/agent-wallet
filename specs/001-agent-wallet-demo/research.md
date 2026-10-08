# Phase 0 Research: Agent Wallet Demo

Facts below were checked on **2026-10-07** with live commands (`npm view`, JSON-RPC calls to Base
Sepolia, reading the published package types) or official docs, as noted. Items marked
**unverified** depend on the end-to-end test in task 1 (R2).

## R1. Network, token and costs

- **Decision**: Base Sepolia (chain id **84532**) with Circle's test USDC at
  `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (6 decimals).
- **Checked**:
  - The address is listed in Circle's USDC contract docs.
  - On-chain `name()` = "USDC" and `decimals()` = 6. `eth_chainId` on `https://sepolia.base.org`
    returns `0x14a34` (84532).
  - The USDC implementation (`0xd74c…c5b5`) contains the **bytes-signature overloads**
    `transferWithAuthorization(…, bytes)` and `receiveWithAuthorization(…, bytes)` plus
    `authorizationState`. This is the FiatToken version that validates **ERC-1271** smart-contract
    signatures.
- **Cost**: $0. Test ETH (gas) and test USDC come from faucets. Every on-chain action is paid
  with test ETH.
- **Alternatives**: Solana devnet and NEAR testnet were ruled out in the cost discussion, because
  x402 is most mature on Base with USDC.

## R2. Payment design: how a policy wallet pays through x402 (deciding test first)

The x402 standard `exact` scheme on EVM works like this:
1. The client signs an **EIP-3009** `TransferWithAuthorization`.
2. The service forwards it to a **facilitator**.
3. The facilitator verifies it and submits it to USDC, which moves funds `from → to`.

For our **policy wallet contract** to be `from`, three things must hold:

| # | Requirement | Status |
| --- | --- | --- |
| a | USDC accepts ERC-1271 signatures from a contract payer | **Verified** on-chain (R1) |
| b | The client lets `from` (wallet) differ from the signing key (agent) | **Verified in the package types**: `@x402/evm` 2.28's `ClientEvmSigner` is `{ address, signTypedData() }`, so we pass the wallet address and sign with the agent key |
| c | The facilitator verifies contract signatures | **Docs say yes.** `@x402/evm` ships ERC-1271/6492 verification that routes by `code.length` and calls `isValidSignature`, and the x402.org facilitator lists EIP-1271 support. **Unverified end to end.** |

- **Decision: Design A (standard x402 `exact`), confirmed by a test in task 1.**
  1. The agent's custom signer intercepts `signTypedData(TransferWithAuthorization)`.
  2. It first calls `wallet.authorize(nonce, to, value, validAfter, validBefore, taskId)`
     on-chain.
  3. `authorize` checks every rule. On a violation it emits `PaymentRefused(reason)` and
     **returns without reverting**, so the refusal is on the public record. On success it
     reserves the amount against the task and daily budgets, stores the EIP-712 digest and emits
     `PaymentAuthorized`.
  4. Only if authorized does the signer return the agent's ECDSA signature. Then:
     - `isValidSignature(digest, sig)` returns valid only if the digest is reserved **and** the
       signature recovers to the agent key;
     - the facilitator settles through USDC;
     - the wallet learns of settlement through `authorizationState` (see `release`).
  5. `release(nonce)` (callable by anyone after `validBefore`) returns the reserved budget if
     USDC shows the authorization was never used, and emits `PaymentExpired`. Without it,
     abandoned payments would slowly eat the budget.

  Benefit: the agent can pay **any** x402 service on Base Sepolia, not only ours.
- **Fallback: Design B (custom scheme)**, if the test shows the facilitator rejects contract
  signatures:
  - `wallet.pay(paymentId, to, value, taskId)` checks the rules and transfers USDC directly,
    emitting `PaymentSettled` or `PaymentRefused`.
  - Our paid service answers `402` with a custom scheme `policy-wallet-onchain` and accepts
    `X-PAYMENT` carrying the transaction hash. It verifies the `PaymentSettled` event (payee,
    amount, paymentId bound to the 402 nonce).

  Same contract rules, same events, same dashboard. The agent can then pay only services that
  understand the custom scheme.
- **Both designs meet the spec.** A is preferred because it uses the standard x402 scheme.
- **The test (task 1)**: deploy a minimal 1271 wallet on Base Sepolia, have the x402 client
  (custom signer) pay a local `@x402/hono` endpoint through the x402.org facilitator, and confirm
  the settlement transaction. Pass means Design A; fail means Design B, recorded here.

### Result of the test (T010, 2026-10-08): **Design A confirmed**

The x402.org facilitator settles standard `exact` payments **from a contract wallet** that
validates the agent's signature through ERC-1271. Run with `scripts/spike-x402-1271.ts` against
`contracts/src/spike/SpikeWallet1271.sol`:

| Item | Observed |
| --- | --- |
| Test wallet | `0xb2dDeFFD49ab0a6254f4B1db3b26aaeE607F7727` (agent = `0x1F19…C3DB`), [deploy](https://sepolia.basescan.org/tx/0x86ed31026dc8e2ed1f43fa6817461cd0401bf9ac4635c98c86ee14726a775cd4), 357k gas |
| Payment 1 | 200 OK, [settlement](https://sepolia.basescan.org/tx/0xe733dc33b67f89295fd6c8c04e8c375356aa1c06562e44456faaa7f3f54b5005): USDC `AuthorizationUsed(authorizer = wallet)` and `Transfer(wallet → payee, 0.01)`, 105k gas |
| Payment 2 | 200 OK, [settlement](https://sepolia.basescan.org/tx/0x899b7ca024d528cdb7ed69643df7b4be92ad9f40af689975252d878a96b08184), the same wallet again |
| Balances | wallet 0.05 → 0.03 USDC, payee 0 → 0.02 USDC |
| Who pays gas | The facilitator (`0xd407…f1bf`) submits the settlement. The agent needs no ETH to pay, only to call `authorize` |

**How it works**:
- The agent signs the EIP-3009 typed data as a normal 65-byte ECDSA signature with
  `from = wallet`.
- The facilitator's `@x402/evm` code checks the payer's code. For a contract it verifies through
  `isValidSignature`, then calls USDC's `transferWithAuthorization(…, v, r, s)`.
- USDC (FiatToken v2.2) routes that through `SignatureChecker`, which calls the wallet's
  ERC-1271 check.

So `PolicyWallet.isValidSignature` is the single gate: it accepts only reserved digests (R2,
step 4).

**Observed x402 v2 wire format (`@x402/*` 2.28)**:
- **Unpaid**: status `402`, with the requirements in the `PAYMENT-REQUIRED` response **header**
  (base64 JSON: `x402Version: 2`, `resource`, `accepts[]` with `scheme`, `network`, `amount`,
  `asset`, `payTo`, `maxTimeoutSeconds` and `extra: { name: "USDC", version: "2" }`). The body
  is `{}`. contracts/paid-service.md's "body" example therefore lives in this header.
- **Paying**: the client sends the payload in the `PAYMENT-SIGNATURE` request header.
- **Paid**: the response carries `PAYMENT-RESPONSE` (base64 JSON
  `{ success, payer, transaction, network }`).
- **Legacy names**: v1 used `X-PAYMENT` and `X-PAYMENT-RESPONSE`, and the libraries still
  recognise them.

**Practical note**: right after a receipt, `https://sepolia.base.org` sometimes answered
`balanceOf` from a node that was one block behind. Verify by events, or read at the receipt's
block, never "latest" immediately after.

**Consequence**: Design B (`pay()`, the custom scheme) is not needed. Tasks marked "(B: …)"
are dropped.

## R3. Rules on-chain: refusals are events, not reverts

- **Decision**: policy refusals **never revert**. A reverted transaction leaves no log, but
  FR-011 and FR-012 require refused attempts on the public record. Every refusal emits
  `PaymentRefused(agentWallet, nonce, payee, amount, taskId, reason)` and returns `false`.
- **Exceptions that do revert** (programming errors, not policy outcomes):
  - a caller that isn't the agent or operator;
  - a **duplicate nonce**, which is a replay attempt. This is safe because USDC itself also
    refuses to reuse an EIP-3009 nonce, so FR-010 holds.
- **Consequence**: every attempt, refused or not, is one transaction paid in test ETH by the
  agent key. That's acceptable on testnet. A future mainnet version could keep refusals
  off-chain.
- **Concurrency (FR-005)**: `authorize` writes state, and Base orders transactions one by one, so
  reservations can never total more than a limit.
- **Daily window (FR-006)**: `day = block.timestamp / 1 days`, which is UTC midnight. Spend is
  tracked per day.

## R4. Contract structure and tooling

- **Decision**:
  - `PolicyWalletFactory` deploys one `PolicyWallet` per agent as an EIP-1167 minimal-proxy
    clone (FR-001).
  - The operator is the owner. The agent key can only call `authorize`.
  - Built with **Foundry** (`forge`): fast unit, fuzz and **invariant** tests, which are how we
    prove SC-001 and SC-002.
  - **OpenZeppelin Contracts** for `ECDSA`, `Clones` and `IERC1271` only (audited, no custom
    crypto).
- **Alternatives**:
  - ERC-4337 smart account plus a session-key module: far more moving parts, plus a bundler and
    paymaster.
  - Coinbase Spend Permissions: per-period allowance only, with no payee allowlist, task budgets
    or refusal records.

## R5. Agent and SDK

- **Decision**: TypeScript on Node 22 with **viem 2.57** and **`@x402/fetch` + `@x402/evm`
  2.28** (the current v2 family; the un-scoped `x402-*` 1.x packages are the older v1).
  - `packages/agent` exposes `createPolicyWalletSigner()` (the custom signer from R2) and a CLI.
  - The scripted agent runs a fixed scenario of allowed payments plus deliberate violations
    (FR-019).
- **Testnet guard**: every script refuses to run unless `eth_chainId` returns 84532. The operator
  key is **never** used in CI.

## R6. Paid service

- **Decision**:
  - A tiny Cloudflare **Worker** using `@x402/hono` 2.28 at `api.demo.yunshu.ai`, with endpoint
    `GET /quote?pair=…` (a deterministic sample "market quote") priced at **0.01 USDC**,
    settled by the **x402.org facilitator**.
  - Free tier: 100,000 requests a day (FR-009, FR-021).
  - Under Design B it verifies the on-chain event instead (R2).
- **Constitution note**: Principle I ("no server") governs the main site. A product on a
  subdomain may have a backend (Principle I, last bullet).

## R7. Dashboard data: snapshot plus live tail

- **Checked**:
  - The public RPC `https://sepolia.base.org` **accepts browser requests** (it reflects the
    request's `Origin` in `access-control-allow-origin`).
  - It **limits `eth_getLogs` to a 500-block range**, which is about 16 minutes at Base's
    2-second blocks.
- **Decision**:
  - **Snapshot**: `scripts/snapshot.ts` reads only new blocks since the last snapshot, in
    500-block chunks, decodes events and writes `apps/dashboard/src/data/history.json`. The
    dashboard pages are built from it at build time, so the full history renders **without JS**
    (constitution III).
  - **Live tail**: after first paint, a lazy-loaded script polls `eth_getLogs` every 10 s from
    the snapshot's last block (SC-003 ≤ 30 s). If the gap exceeds 500 blocks, for example after a
    tab sleeps, it fetches in chunks up to a cap and otherwise shows "refresh for full history".
  - **Unavailable network**: keep the snapshot and show the "network unavailable" notice (edge
    case).
- **How the snapshot is published (decided)**: the scheduled GitHub Actions job runs the agent,
  regenerates `history.json` and **commits it** to the repo. Cloudflare Pages' Git integration
  rebuilds the dashboard. $0, and no Cloudflare token in CI.
- **Alternatives**:
  - Browser-only full scan: too many 500-block calls.
  - Block explorer API: needs a key and its browser access is unverified.
  - Hosted indexer such as The Graph: extra service.

## R8. Dashboard app

- **Decision**: an Astro static site in `apps/dashboard`, matching yunshu.ai (same tokens and
  fonts, English `/` and Chinese `/zh/`, key-parity check). viem's `decodeEventLog` and the RPC
  client load **only** in the lazy live-tail chunk, keeping first-screen JS within the main
  site's 50 KB budget.
- **Hosting**: Cloudflare Pages project `agent-wallet-demo` at `demo.yunshu.ai`. Free.

## R9. Schedule, funding and secrets (owner steps)

- **Schedule**: GitHub Actions cron **every 6 hours**, free for public repos. A run makes about 3
  allowed payments (0.01 each) and 4 deliberate violations. That's about 0.12 USDC and a few
  hundred thousand gas of test ETH a day.
- **Owner-only steps** (Claude can't do these: faucets use CAPTCHAs or sign-ins, and secrets are
  credentials):
  - fund the operator and agent addresses from the Base Sepolia ETH faucet and Circle's USDC
    faucet;
  - add `AGENT_PRIVATE_KEY` and `WALLET_ADDRESS` as GitHub Actions secrets;
  - keep the **operator key local only**.
- **Low funds**: the run stops with "insufficient funds" (edge case, US5 scenario 2) and the
  dashboard shows the balance.

## R10. Governance

- The repo constitution (v1.0.1) governs the yunshu.ai website. For this product it is applied
  where it carries over (see the plan's Constitution Check).
- **Follow-up**: ratify a **product constitution** in the new repo, covering contract security,
  testnet-only use, the $0 cost ceiling and key handling, before `/speckit-implement`.

## R11. Security review of `contracts/src/` (T054, 2026-10-08)

Manual review of `PolicyWallet.sol` and `PolicyWalletFactory.sol` against the constitution's
gates, with the test suite as evidence (33 contract tests: unit, 1,000-run fuzz per reason,
invariants over 12,800 random calls, and a fork test against the real Base Sepolia USDC).

| Area | Finding | Evidence |
| --- | --- | --- |
| Signature gate | `isValidSignature` returns the magic value only for a **reserved** digest that recovers to the current agent. Every other use of a 1271 signature from this wallet (USDC `permit`, `cancelAuthorization`, `receiveWithAuthorization`, any other contract) has an unreserved digest and fails. OpenZeppelin `ECDSA.tryRecover` rejects malleable (high-s) signatures | `test_isValidSignature_*`, fork test `unauthorizedPaymentIsRejectedByUsdc` |
| Digest binding | The digest includes `from = address(this)`, USDC's domain separator, payee, amount, validity window and nonce, so a reservation can't be used by another wallet, token or amount | `test_settlement_*` |
| Refusals | Every rule failure emits `PaymentRefused` with one reason and returns `false`; no state besides `nonceUsed` changes and no funds move | `Refusals.fuzz.t.sol` (one fuzz per reason + precedence) |
| Replay | A nonce is attempted once (reused → revert, even after a refusal); USDC marks it used on settlement | `test_authorize_revertsOnReusedNonce_evenAfterRefusal`, `Handler.replay` invariant |
| Limits | Spend never exceeds the daily or task budget at authorization time across random sequences of authorize, settle, release, rule changes and time | `invariant_noLimitBreachedAtAuthorization` |
| Funds | USDC leaves the wallet only through settled authorizations (and operator `withdraw`) | `invariant_balanceChangesOnlyBySettlement` |
| Access | Every operator function reverts for the agent and strangers; the agent can only call `authorize`; `release` is open but only returns budget for expired, unsettled reservations | `test_operatorOnly_revertsForAgentAndStranger`, live `cast call --from agent` (quickstart scenario 3) |
| Release | `release` requires `now ≥ validBefore` and `authorizationState == false`; USDC rejects settlement at `now ≥ validBefore`, so a released reservation can never settle afterwards; its digest is deleted | `test_release_*` |
| Reentrancy | External calls are only views on the immutable USDC address (`DOMAIN_SEPARATOR`, `balanceOf`, `authorizationState`) and `safeTransfer` in operator-only `withdraw` | code review |
| Initialization | The implementation disables initializers; clones are created and initialized in one factory call, so they can't be front-run | `test_clone_cannotBeReinitialized` |
| Testnet guard | Constructor accepts only chain 84532 (and 31337 for local tests); the deploy script and every CLI command check 84532 | `chainGuard.test.ts`, `Deploy.s.sol` |

**Accepted limitations (documented, not fixed)**:
- `INSUFFICIENT_FUNDS` compares against the current balance, not balance minus outstanding
  reservations. Overlapping authorizations beyond the balance fail at settlement and are
  released later (data-model.md).
- The agent can hold its own budget hostage with a far-future `validBefore` on an unsettled
  authorization. Only the agent's own spending is affected; the operator can rotate the agent.
- The operator can `withdraw` funds behind an outstanding reservation; that payment then fails at
  settlement. Intended: the operator owns the funds.
- Not audited by a third party. Test network only.

**Off-chain checks**: the SDK signer refuses any typed data other than a
`TransferWithAuthorization` from its own wallet, before any transaction; no command prints a
private key (output is built only from addresses, amounts and hashes); the scheduled workflow
holds only the agent key; the paid API validates input before charging.
