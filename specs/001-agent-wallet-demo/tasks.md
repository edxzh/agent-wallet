---

description: "Task list for the Agent Wallet Demo"
---

# Tasks: Agent Wallet Demo

**Input**: Design documents from `specs/002-agent-wallet-demo/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Repository**: all code paths are relative to the **new repo `edxzh/agent-wallet`** (created
in T001), not yunshu.ai, except T055–T056.

**Tests**: included. The plan makes Foundry fuzz and invariant tests a security gate (SC-001,
SC-002), and quickstart scenarios are the acceptance checks.

**Owner tasks**: tasks marked **(owner)** need Edward: faucet funding (CAPTCHAs and sign-ins),
adding secrets, approving the public repo, Cloudflare dashboard steps. Claude prepares
everything around them.

**Design A / B**: T010 decides. If it records **Design B**, the tasks marked "(A)" are replaced
by their "(B)" variant described in the same task.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: The user story (US1–US6 in spec.md)

---

## Phase 1: Setup (Shared Infrastructure)

- [X] T001 **(owner approval)** Create the public GitHub repo `edxzh/agent-wallet` (`gh repo create edxzh/agent-wallet --public`), initialise Spec Kit in it, and copy `specs/002-agent-wallet-demo/` from yunshu.ai to `specs/001-agent-wallet-demo/`. Add `README.md` (stub), `LICENSE` (MIT) and `.gitignore` (`node_modules/`, `out/`, `cache/`, `broadcast/`, `.env*`, `dist/`, `.astro/`, `.wrangler/`)
- [X] T002 Create the npm-workspaces root `package.json` (workspaces `packages/*`, `apps/*`; `engines.node >=22`; scripts `test`, `lint`, `snapshot`, `scenario`), a shared `tsconfig.base.json` (strict, ES2022, `moduleResolution: bundler`) and `.env.example` listing `RPC_URL=https://sepolia.base.org`, `OPERATOR_PRIVATE_KEY=`, `AGENT_PRIVATE_KEY=`, `FACTORY_ADDRESS=`, `WALLET_ADDRESS=`, `SERVICE_PAYEE=`, with a comment that the operator key must never go to CI
- [X] T003 [P] *(done without `forge init`: Foundry not installed on the dev machine. `foundry.toml`, remappings and OpenZeppelin via its official npm package are in place; `forge-std` is installed by `forge install` in CI and locally once Foundry is installed)* Initialise Foundry in `contracts/`: `forge init --no-commit`, `forge install OpenZeppelin/openzeppelin-contracts` pinned to a release tag, `contracts/foundry.toml` with `solc = "0.8.24"`, `optimizer_runs = 200`, `[fuzz] runs = 1000`, `[invariant] runs = 256, depth = 50`, and `[rpc_endpoints] base_sepolia = "${RPC_URL}"`
- [X] T004 [P] Scaffold `packages/agent/package.json` (name `agent-wallet`, `bin: { "agent-wallet": "dist/cli.js" }`; deps `viem@^2.57`, `@x402/fetch@^2.28`, `@x402/evm@^2.28`, `@x402/core@^2.28`, `dotenv`; devDeps `vitest`, `typescript`, `tsx`) and `packages/agent/tsconfig.json`
- [X] T005 [P] Scaffold `packages/service/` as a Cloudflare Worker: `package.json` (deps `hono`, `@x402/hono@^2.28`, `@x402/evm@^2.28`; devDeps `wrangler`, `vitest`), `wrangler.toml` (`name = "agent-wallet-api"`, `main = "src/index.ts"`, `compatibility_date` = today, vars `NETWORK = "eip155:84532"`, `PAYEE_ADDRESS`, `FACILITATOR_URL = "https://www.x402.org/facilitator"`)
- [X] T006 [P] Scaffold `apps/dashboard/` as an Astro 7 static site matching yunshu.ai. Copy from the yunshu.ai repo: `src/styles/tokens.css`, `fonts.css`, `global.css`, `src/lib/logo-geometry.mjs`, `src/components/Logo.astro`, `LangSwitch.astro` (adapted to `/` and `/zh/`), `scripts/check-i18n.mjs`, `scripts/check-budget.mjs`. Add `astro.config.mjs` (`site: 'https://demo.yunshu.ai'`, `output: 'static'`, `trailingSlash: 'always'`)
- [X] T007 [P] Create `.github/workflows/ci.yml`: on push/PR, Node 22 and `foundry-rs/foundry-toolchain`, then `forge build && forge test -vvv` in `contracts/`, then `npm ci`, `npm test -ws`, `npm run build -w apps/dashboard`, the budget check and Playwright smoke tests for the dashboard
- [X] T008 *(done 2026-10-08: operator 0.0001 ETH + 10 USDC, agent 0.0001 ETH, from the CDP faucet)* **(owner)** Generate keys locally with `cast wallet new` (operator, agent, service payee). Fund operator and agent with Base Sepolia ETH and the operator with test USDC from Circle's faucet. Fill `.env` (never committed)
- [X] T009 **(owner approval)** Run `/speckit-constitution` in the new repo to ratify a product constitution: testnet-only, contract security gates (fuzz + invariants must pass), key handling (operator key never in CI), $0 cost ceiling, bilingual accessible dashboard, minimal dependencies. Write it to `.specify/memory/constitution.md`

---

## Phase 2: Foundational (Blocking Prerequisites)

**⚠️ CRITICAL**: T010 decides the payment design for every later phase.

- [X] T010 *(done 2026-10-08: **Design A confirmed**, see research.md R2 "Result of the test")* Payment-design test (research R2, quickstart scenario 0):
  - write `contracts/src/spike/SpikeWallet1271.sol` (stores an owner key, returns `0x1626ba7e` from `isValidSignature` when the signature recovers to it, can `approve` nothing and holds USDC);
  - write `scripts/spike-x402-1271.ts`, which deploys it to Base Sepolia, funds it with 0.05 test USDC, starts a local `@x402/hono` endpoint priced 0.01 USDC using the x402.org facilitator, and pays it with `@x402/fetch` using a custom `ClientEvmSigner` (`address` = spike wallet, `signTypedData` = agent key);
  - log the 402 body, payment headers, facilitator response and settlement transaction hash;
  - write the outcome (**Design A confirmed** or **Design B**, with the facilitator's error) and the observed header names into `specs/001-agent-wallet-demo/research.md` §R2.

  Depends on T003–T005 and T008
- [X] T011 [P] Implement `packages/agent/src/chainGuard.ts`: `assertBaseSepolia(client)` throws `WrongNetworkError` unless `eth_chainId === 84532`; every CLI entry point calls it first (exit code 1). Unit test in `packages/agent/test/chainGuard.test.ts`
- [X] T012 [P] Create `contracts/src/Reason.sol` (the `Reason` enum with values exactly as in data-model.md) and `contracts/src/IPolicyWallet.sol` (events and function signatures exactly as in `contracts/policy-wallet.md`; Design B adds `pay` and `PaymentSettled`)
- [X] T013 [P] Create `packages/agent/src/config.ts` (USDC address `0x036CbD53842c5426634e7929541eC2318f3dCF7e`, chain id 84532, default RPC, BaseScan URL builder, loading `.env`) and `config/payees.json` (`[{ "address": "<SERVICE_PAYEE>", "label": "Yunshu demo quote API" }]`)
- [X] T014 Add `scripts/export-abi.ts`, which reads `contracts/out/PolicyWallet.sol/PolicyWallet.json` and `PolicyWalletFactory.json` after `forge build` and writes `packages/agent/src/abi.ts` (`as const` ABIs for viem). Wire it to the root `build` script after `forge build`. Depends on T012

**Checkpoint**: T010's verdict is recorded; the ABIs export; the chain guard is tested.

---

## Phase 3: User Story 1 - The agent pays on its own, within its limits (Priority: P1) 🎯 MVP

**Goal**: An agent with a funded PolicyWallet pays the demo API through x402. The payment
settles and is recorded.

**Independent Test**: Quickstart scenario 1. `agent-wallet pay …/quote` returns 200, with
`PaymentAuthorized` and then USDC `AuthorizationUsed` on BaseScan, and budgets drop by 0.01.

### Tests for User Story 1

- [X] T015 [P] [US1] Write `contracts/test/PolicyWallet.t.sol`:
  - `authorize` with all rules satisfied returns `true`, emits `PaymentAuthorized` with the EIP-712 digest, increases `spentOn(today)` and the task's `spent`;
  - `isValidSignature` returns the magic value only for a reserved digest signed by `agent`, and `0xffffffff` for an unreserved digest or a non-agent signer;
  - `createWallet` sets operator, agent and policy.
- [X] T016 [P] [US1] Write `contracts/test/Erc1271.fork.t.sol` (fork Base Sepolia via `vm.createSelectFork("base_sepolia")`): fund a `PolicyWallet` with USDC via `deal`, `authorize` a nonce, sign the `TransferWithAuthorization` digest with the agent key, call USDC's `transferWithAuthorization(…, bytes signature)` and assert the payee received the amount. Design B: test `pay()` moving USDC instead.

### Implementation for User Story 1

- [X] T017 [US1] Implement `contracts/src/PolicyWallet.sol` (initializer-based for clones):
  - storage (operator, agent, token, name, paused, perPaymentCap, dailyBudget, `spent[day]`, tasks, payees, `reservations[nonce]`, `reservedDigest[digest]`);
  - `authorize` success path computing the digest with `token.DOMAIN_SEPARATOR()` and the EIP-3009 `TRANSFER_WITH_AUTHORIZATION_TYPEHASH`;
  - `isValidSignature` via OpenZeppelin `ECDSA.recover`;
  - views from `contracts/policy-wallet.md`.

  (B) Implement `pay()`, transferring USDC with `SafeERC20` and emitting `PaymentSettled`.
- [X] T018 [US1] Implement `contracts/src/PolicyWalletFactory.sol` with OpenZeppelin `Clones.clone` of a PolicyWallet implementation, `createWallet(agent, name, cap, daily)` initialising with `msg.sender` as operator and emitting `WalletCreated`. Depends on T017
- [X] T019 [P] [US1] Write `contracts/script/Deploy.s.sol`: `require(block.chainid == 84532)`, deploy the implementation and factory, and print addresses. The CLI's `deploy-factory` uses the same guard
- [X] T020 [US1] Implement `packages/agent/src/signer.ts` `createPolicyWalletSigner({ wallet, agentKey, taskId, rpcUrl })`, returning a `ClientEvmSigner`:
  - `address` = wallet;
  - `signTypedData` validates that `primaryType === 'TransferWithAuthorization'` and `message.from === wallet`;
  - it sends `authorize(nonce, to, value, validAfter, validBefore, taskId)` with the agent key and waits for the receipt;
  - if the receipt has `PaymentRefused`, it throws `PolicyRefusedError(reason, nonce, txHash)`; otherwise it returns the agent's signature over the typed data.

  (B) Export `payWithPolicyWallet(url)`, implementing the custom-scheme flow from `contracts/paid-service.md`. Depends on T014
- [X] T021 [P] [US1] Write `packages/agent/test/signer.test.ts` (Vitest with a mocked viem client): refused receipt → `PolicyRefusedError` with the right reason and no signature produced; wrong `from` or `primaryType` → throws before any transaction; authorized → returns a signature that recovers to the agent key
- [X] T022 [US1] Implement `packages/service/src/index.ts` (Hono):
  - refuse to start unless `NETWORK === "eip155:84532"`;
  - `GET /health`;
  - `GET /quote?pair=` behind `@x402/hono` payment middleware (scheme `exact`, 10000 units USDC, `payTo = PAYEE_ADDRESS`, facilitator x402.org), returning the deterministic sample body from `contracts/paid-service.md`;
  - `400` for a bad pair.

  (B) Middleware that verifies `PaymentSettled` on-chain by tx hash and nonce. Add `packages/service/test/quote.test.ts` for 402 without payment and 400 for a bad pair
- [X] T023 [US1] Implement `packages/agent/src/cli.ts` commands `deploy-factory`, `create-wallet`, `set-payee`, `set-task`, `pay <url> [--task label]` and `status`, per `contracts/agent-cli.md`. Output JSON lines (`--pretty` for humans), use the exit codes listed there, and call `assertBaseSepolia` first. Depends on T011, T020
- [X] T024 [US1] **(owner-funded)** Deploy to Base Sepolia (`deploy-factory`, `create-wallet research-bot-01 --cap 1 --daily 5`, `set-payee`, `set-task market-research --budget 2`, fund the wallet with 20 USDC). Record the addresses in `config/deployments.json` and run quickstart scenario 1 against a local `wrangler dev` service

**Checkpoint**: one real x402 payment settled from a policy wallet on Base Sepolia.

---

## Phase 4: User Story 2 - Over-budget or out-of-scope payments are stopped (Priority: P1)

**Goal**: Every violation is refused before funds move, with one recorded reason. The agent
can't change rules.

**Independent Test**: Quickstart scenarios 2, 3, 5 and 6, plus `forge test` fuzz and invariant
suites green.

### Tests for User Story 2

- [X] T025 [P] [US2] Write `contracts/test/Refusals.fuzz.t.sol`: one fuzz test per `Reason` (PAUSED, INVALID_AMOUNT, PAYEE_NOT_ALLOWED, OVER_PER_PAYMENT_CAP, OVER_TASK_BUDGET, OVER_DAILY_BUDGET, INSUFFICIENT_FUNDS) with fuzzed amounts and timestamps. Each asserts `authorize` returns `false`, emits `PaymentRefused` with exactly that reason, doesn't revert, and leaves the USDC balance, `spentOn` and task `spent` unchanged. Add a precedence test where several rules fail and the first in data-model order wins
- [X] T026 [P] [US2] Write `contracts/test/Invariants.t.sol` with a `Handler` that randomly calls `authorize` (random amounts, payees, tasks, nonces), `release` after `vm.warp`, `setPolicy`, `setTask` and `vm.warp` across days. Invariants:
  - every successful authorization kept `spentOn(day) ≤ dailyBudget` and `task.spent ≤ task.budget` at the time it was made;
  - no nonce is authorized twice;
  - the wallet's USDC balance only changes through settled authorizations.
- [X] T027 [P] [US2] Add to `contracts/test/PolicyWallet.t.sol`: each operator-only function (`setPolicy`, `setPayee`, `setTask`, `setAgent`, `pause`, `unpause`, `withdraw`) reverts when called by the agent or a stranger; `authorize` reverts for non-agent callers and for a reused nonce

### Implementation for User Story 2

- [X] T028 [US2] In `contracts/src/PolicyWallet.sol`, implement the ordered rule checks in `authorize`, returning `false` and emitting `PaymentRefused` (never reverting) for: PAUSED, INVALID_AMOUNT (amount 0 or `validBefore <= block.timestamp`), PAYEE_NOT_ALLOWED, OVER_PER_PAYMENT_CAP, OVER_TASK_BUDGET (unknown task has budget 0), OVER_DAILY_BUDGET (`day = block.timestamp / 1 days`), INSUFFICIENT_FUNDS (`token.balanceOf(this) < amount`). Revert on a reused nonce and a non-agent caller. Depends on T017
- [X] T029 [US2] Implement the operator setters `setPolicy`, `setPayee`, `setTask` and `setAgent` with `onlyOperator`, each emitting `RuleChanged(field, key, old, new)`, plus `withdraw(to, amount)`, in `contracts/src/PolicyWallet.sol`
- [X] T030 [US2] Implement `release(nonce)` in `contracts/src/PolicyWallet.sol`: require `block.timestamp >= validBefore` and `!IUSDC(token).authorizationState(address(this), nonce)`, then return the amount to `spent[day-of-authorization]` and the task's spent, delete the reservation and digest, and emit `PaymentExpired`. (B) Not needed
- [X] T031 [US2] Add `release-expired` to `packages/agent/src/cli.ts`. It scans this wallet's `PaymentAuthorized` events without a matching USDC `AuthorizationUsed` whose `validBefore` has passed, and calls `release` for each
- [X] T032 *(2026-10-08: scenarios 2, 3, 5 and 6 done and recorded in quickstart.md)* [US2] **(owner-funded)** Run quickstart scenarios 2 (each refusal on Base Sepolia, wallet balance unchanged), 3 (agent `setPolicy` reverts), 5 (replay of a signed payload rejected) and 6 (expiry plus `release-expired`). Record the transaction hashes in `specs/001-agent-wallet-demo/quickstart.md`

**Checkpoint**: all seven refusals on the public record; fuzz and invariants green in CI.

---

## Phase 5: User Story 3 - Anyone can watch and verify (Priority: P1)

**Goal**: A public bilingual dashboard shows rules, spend and a live timeline, each entry linked
to BaseScan.

**Independent Test**: Quickstart scenarios 8 and 9. Open `demo.yunshu.ai` and `/zh/`, `pay` with
the page open, and a row appears within 30 s; with JS off the snapshot history is still
readable.

### Tests for User Story 3

- [X] T033 [P] [US3] Write `scripts/snapshot.test.ts` (Vitest, recorded RPC fixtures in `scripts/fixtures/`): decodes every event kind into record entries per data-model.md, joins USDC `AuthorizationUsed` to `PaymentAuthorized` by nonce to mark `settled`, never requests more than 500 blocks per `eth_getLogs`, and resumes from `lastBlock + 1`
- [X] T034 [P] [US3] Write Playwright smoke tests in `apps/dashboard/tests/dashboard.spec.ts`:
  - `/` and `/zh/` render the rules, spend bars and at least one timeline row from a fixture `history.json`;
  - every row has a `verify` link to `https://sepolia.basescan.org/tx/0x…`;
  - the testnet banner is present;
  - with JS disabled the timeline is still visible;
  - with the RPC route blocked, the "network unavailable" notice appears.

### Implementation for User Story 3

- [X] T035 [US3] Implement `scripts/snapshot.ts`:
  - read `history.json` (or start at each wallet's creation block from `config/deployments.json`);
  - fetch the wallet and USDC (`authorizer = wallet`) logs in ≤ 500-block chunks up to `latest`;
  - read the current views (policy, paused, tasks, payees, `spentOn(today)`, balance);
  - merge and cap at 500 events per wallet;
  - write `apps/dashboard/src/data/history.json` per `contracts/dashboard.md`.

  Root script: `npm run snapshot`. Depends on T014
- [X] T036 [P] [US3] Create `apps/dashboard/src/i18n/en.json` and `zh.json` with identical keys: page copy, the testnet banner ("Test network only. No real money." / "仅测试网络，不涉及真实资金。"), labels for each rule, timeline kinds, and `reason.*` plain-language text for all seven reasons. Wire `scripts/check-i18n.mjs` into `prebuild`
- [X] T037 [US3] Build the dashboard pages in `apps/dashboard/src/pages/index.astro` (English) and `src/pages/zh/index.astro`, with components:
  - `src/components/RulesCard.astro`: cap, daily budget with UTC reset countdown, payees with labels, tasks;
  - `SpendBars.astro`: today and per-task spent/budget, balance;
  - `Timeline.astro`: newest first; icons ✓ ✕ ↺ ⚙; amount, payee label, task label, relative time, plain-language reason, `verify ↗`;
  - `TestnetBanner.astro`.

  Rendered statically from `src/data/history.json`, one template set for both languages. Depends on T035, T036
- [X] T038 [US3] Implement `apps/dashboard/src/scripts/live-tail.ts`, dynamically imported after `load` and idle:
  - poll `eth_getLogs` every 10 s from `lastBlock + 1` in ≤ 500-block steps (cap 10 steps per tick);
  - decode with viem `decodeEventLog`, prepend rows, update the counters;
  - animate inserts only under `prefers-reduced-motion: no-preference`;
  - on failure show "Network unavailable, showing data as of <time>".

  Keep first-screen JS ≤ 50 KB gzip (viem only in this chunk). Depends on T037
- [ ] T039 [US3] **(owner, Cloudflare dashboard)** Create the Pages project `agent-wallet-demo` from `edxzh/agent-wallet` (root `apps/dashboard`, build `npm ci && npm run build -w apps/dashboard`, output `apps/dashboard/dist`, `NODE_VERSION=22`) and attach the custom domain `demo.yunshu.ai`. Claude can drive the dashboard steps once the GitHub app access includes the new repo
- [ ] T040 [US3] Run quickstart scenarios 8 and 9 on `demo.yunshu.ai` (phone and desktop, both languages, BaseScan links, no-JS, RPC blocked) and record the results

**Checkpoint**: P1 complete. The demo pays, refuses and is publicly verifiable (MVP).

---

## Phase 6: User Story 4 - Operator changes limits or pauses instantly (Priority: P2)

**Goal**: Rule changes and pause apply to the very next attempt and are visible on the
dashboard.

**Independent Test**: Quickstart scenario 4. `set-cap 0.005` then `pay` is refused; `pause` then
`pay` is refused with "agent paused"; both changes appear as ⚙ rows.

- [X] T041 [P] [US4] Add pause/unpause tests to `contracts/test/PolicyWallet.t.sol`: after `pause`, any `authorize` is refused with `PAUSED` and no revert; `unpause` restores it; `Paused`/`Unpaused` and `RuleChanged` events are emitted; a lowered cap applies to the next call
- [X] T042 [US4] Implement `pause()`/`unpause()` (`onlyOperator`, emitting `Paused`/`Unpaused`) in `contracts/src/PolicyWallet.sol`. Depends on T028
- [X] T043 [US4] Add CLI commands `set-cap`, `set-daily`, `pause` and `unpause` (operator key) to `packages/agent/src/cli.ts`
- [X] T044 [US4] Show a paused badge on `RulesCard.astro` and render `ruleChange`/`paused`/`unpaused` rows in `Timeline.astro` with old → new values, with en/zh labels in `apps/dashboard/src/i18n/*.json`
- [X] T045 *(2026-10-08: set-cap 0.005 → next pay refused OVER_PER_PAYMENT_CAP; pause → refused PAUSED; unpause → paid; restored cap 1.00. Rows appear in the snapshot; live tail polls every 10 s)* [US4] **(owner-funded)** Run quickstart scenario 4 on Base Sepolia and confirm the dashboard shows the changes within 30 s

---

## Phase 7: User Story 5 - The demo always has fresh activity (Priority: P2)

**Goal**: A scheduled scripted agent keeps the dashboard current at $0.

**Independent Test**: Quickstart scenarios 10 and 11. After 48 h unattended there's activity
from both days, each run has at least one settled and one refused payment, and low funds stop
the run cleanly.

- [X] T046 [P] [US5] Write `packages/agent/test/scenario.test.ts` (mocked signer and fetch): `run-scenario` performs ~3 allowed payments and attempts over-cap, over-task, over-daily and unlisted-payee; exits `0` when every outcome matches, `2` on a mismatch, `3` on `INSUFFICIENT_FUNDS`
- [X] T047 *(demo policy set to 1.00 per payment / 1.00 per day so the over-daily probe is honest every run; probes are direct `authorize` attempts; expectations are computed from on-chain state before each step)* [US5] Implement `packages/agent/src/scenario.ts` and the `run-scenario [--seed n]` CLI command:
  - a deterministic plan per seed;
  - each step's expected outcome is compared with the actual;
  - JSON lines per step;
  - stop on insufficient funds with exit 3.

  Depends on T023, T031
- [X] T048 [US5] Create `.github/workflows/agent-run.yml`:
  - `schedule: cron '17 */6 * * *'` plus `workflow_dispatch`;
  - `permissions: contents: write`; `concurrency: agent-run`;
  - steps: `npm ci`, `npx agent-wallet run-scenario`, `npx agent-wallet release-expired`, `npm run snapshot`;
  - commit `apps/dashboard/src/data/history.json` with message `chore(snapshot): <ISO time> [skip ci]` and push (Cloudflare Pages rebuilds from the commit).

  Uses only the secrets `AGENT_PRIVATE_KEY` and `WALLET_ADDRESS`, never the operator key
- [X] T049 [US5] **(owner)** Add the GitHub Actions secrets `AGENT_PRIVATE_KEY` and `WALLET_ADDRESS` in `edxzh/agent-wallet` → Settings → Secrets and variables → Actions
  - Done 2026-10-09 with `gh secret set`. `WALLET_ADDRESS` is empty; the CLI falls back to `config/deployments.json`. First manual run (37923253371): 2 of 3 payments settled, all 4 probes refused as expected, one payment got a 402 with no reason from x402.org; `release-expired` then failed on the RPC's new 200-block `getLogs` limit (fixed; chunks are now 200)
- [ ] T050 [US5] Leave the schedule running for 48 h, then check quickstart scenarios 10 and 11 (low funds via `withdraw`) and record the results

---

## Phase 8: User Story 6 - Developers can run it themselves (Priority: P3)

**Goal**: A newcomer reproduces it from the README in ≤ 15 minutes.

**Independent Test**: Quickstart scenario 12 on a clean machine.

- [X] T051 [US6] Write `README.md`, in English with a short Chinese summary: what it is, architecture diagram (wallet → authorize → x402 → facilitator → USDC; dashboard snapshot plus live tail), the testnet-only warning, prerequisites, owner funding steps, deploy and `pay`/`run-scenario` commands, refusal reasons table, links to the dashboard and the spec
- [ ] T052 [US6] Run quickstart scenario 12 with someone else's machine or a fresh clone in a clean container (`docker run node:22`); time it and fix any README gaps

---

## Phase 9: Polish & Cross-Cutting Concerns

- [X] T053 **(owner, Cloudflare dashboard)** Deploy `packages/service` with Cloudflare Workers Builds from `edxzh/agent-wallet` (root `packages/service`) on custom domain `api.demo.yunshu.ai`; set `PAYEE_ADDRESS`. Re-run scenario 1 against the deployed URL
  - Done 2026-10-09 with `wrangler deploy` (custom domain in `packages/service/wrangler.toml`, not Workers Builds). Scenario 1 against `https://api.demo.yunshu.ai`: 402 with the right requirements, 400 for a bad pair, one paid request settled (tx `0x94f9ee9c…14b9`)
- [X] T054 Run a security review of `contracts/src/` (the `/security-review` command plus a manual checklist: reentrancy impossible since no external calls before state writes in `authorize`; signature malleability via OpenZeppelin `ECDSA`; digest bound to `from = this`, token domain and nonce; operator-only coverage; no `selfdestruct` or `delegatecall` in clones beyond EIP-1167). Fix findings and record them in `specs/001-agent-wallet-demo/research.md`
- [ ] T055 In the **yunshu.ai repo**, update the website's Work section:
  - in `src/data/site.json`, set `work.status: "shipped"`, `repoUrl: "https://github.com/edxzh/agent-wallet"` and `image` to a dashboard screenshot saved as `public/work/agent-wallet.{webp,avif}` at 1x/2x;
  - update `work.heading`/`description` copy in `src/i18n/en.json` and `zh.json`;
  - add a "Live demo" link to `https://demo.yunshu.ai` (new i18n key, both files).
- [ ] T056 In the **yunshu.ai repo**, mark feature 002 as moved: replace `specs/002-agent-wallet-demo/` contents with a `README.md` pointing to `edxzh/agent-wallet/specs/001-agent-wallet-demo`, and reset `.specify/feature.json` to `specs/001-website-v1`
- [ ] T057 After 1 month, check Cloudflare and GitHub billing pages show $0 (SC-006) and that the dashboard had activity on ≥ 95% of days (SC-007)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: T001 first; T002–T007 in parallel after it; T008–T009 are owner steps, which can run in parallel.
- **Foundational (Phase 2)**: T010 needs T003–T005 and T008, and **blocks all user stories**, since it fixes Design A or B. T011–T013 can run in parallel; T014 needs T012.
- **US1 (Phase 3)**: after Phase 2. It is the base for US2–US5 (contract, signer, CLI).
- **US2 (Phase 4)**: after T017 and T023. T028–T030 extend the same contract file as T017, so run them in sequence.
- **US3 (Phase 5)**: needs T014 and a deployed wallet (T024) for real data. UI work (T036–T038) can use fixtures and run alongside US2.
- **US4 (Phase 6)**: after T028 (same contract) and T037 (dashboard components).
- **US5 (Phase 7)**: after T023, T031 and T035.
- **US6 (Phase 8)**: after US1–US5.
- **Polish (Phase 9)**: T053 can come right after US1; T054 before announcing; T055–T056 after US3 ships; T057 a month later.

### Shared-file notes

`contracts/src/PolicyWallet.sol` is touched by T017, T028, T029, T030 and T042, and
`packages/agent/src/cli.ts` by T023, T031, T043 and T047. Do these in sequence.

### Parallel Opportunities

- Setup: T003, T004, T005, T006 and T007 together after T002.
- Foundational: T011, T012 and T013 together.
- US1: T015, T016, T019 and T021 together (tests and script in separate files).
- US2: T025, T026 and T027 together (separate test files; T027 appends to the US1 test file, so after T015).
- US3: T033, T034 and T036 together; dashboard UI (T036–T038) alongside US2 contract work.

---

## Parallel Example: User Story 2

```bash
# Write all refusal tests at once (separate files):
Task: "T025 [US2] contracts/test/Refusals.fuzz.t.sol"
Task: "T026 [US2] contracts/test/Invariants.t.sol"
# Meanwhile, the dashboard team (US3) on fixtures:
Task: "T036 [US3] apps/dashboard/src/i18n/{en,zh}.json"
# Then in sequence on the shared contract: T028 → T029 → T030
```

---

## Implementation Strategy

### MVP (all P1: US1 + US2 + US3)

1. Setup (Phase 1) and the **T010 design test**. Stop and confirm Design A or B before writing the wallet.
2. US1: one real payment from a policy wallet.
3. US2: all refusals on the record; fuzz and invariants green.
4. US3: public dashboard at `demo.yunshu.ai`. **This is the minimum worth showing**: it proves "pays on its own, stopped when over budget, every payment traceable".

### Then

5. US4: live rule changes and pause (a strong demo moment).
6. US5: the schedule keeps the dashboard fresh.
7. US6: README reproducibility.
8. Polish: deploy the Worker, security review, update the website's Work section (T055).

---

## Notes

- Every script and the Worker must refuse anything other than chain 84532.
- Never put the operator key in CI, logs or commits. The agent key lives only in `.env` and
  GitHub secrets.
- Commit after each task or logical group; the contract tests must pass before any on-chain
  step.
