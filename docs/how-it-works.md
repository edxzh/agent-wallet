# How the agent wallet works

A guided tour, from the idea to the code. Each section explains one part in a few paragraphs
and links to the document that covers it in full. Read top to bottom, and stop wherever you
have enough.

> **Test network only (Base Sepolia). No real money.**

## 0. See it first

- **Live dashboard:** <https://demo.yunshu.ai> (中文: <https://demo.yunshu.ai/zh/>). Every
  payment, refusal and rating the demo agent makes, read from the chain.
- **Try to make it overspend:** <https://demo.yunshu.ai/try/>. You play the attacker, and the real
  contract answers in a dry run.
- **The story, without code:** [Letting an AI agent pay for itself, without letting it
  overspend](articles/2026-10-agent-pays-safely.md) ([中文](articles/2026-10-agent-pays-safely-zh.md)).
  The sequel, on agents hiring agents: [When an AI agent hires another agent](articles/2026-10-agent-hires-agent.md)
  ([中文](articles/2026-10-agent-hires-agent-zh.md)).

## 1. The problem

An AI agent that can pay for things (API calls, data, other agents' work) is useful, and a
risk: a bug, a prompt injection or a stolen key could make it spend without limit, or pay the
wrong party. Off-chain checks don't help much, because a compromised agent can skip them.

The answer here: **the agent's money sits in a smart contract that enforces the rules itself**.
The agent can ask to pay; the contract decides, before any money moves, and leaves a public
record either way.

## 2. The pieces

```text
 agent (TypeScript, packages/agent) ── holds only an "agent key": it can ask, not change rules
   │
   ├─▶ paid API (Cloudflare Worker, packages/service): answers 402 "pay 0.01 USDC" (x402)
   │
   └─▶ PolicyWallet (Solidity, contracts/src): the agent's wallet on Base Sepolia
          rules: per-payment cap, daily budget, task budgets, allowed payees, pause
          only the operator (the owner's key, never in CI) can change them

 dashboard (Astro, apps/dashboard): reads the public record and shows it
```

- [`README.md`](../README.md): the flow diagram, the rules and the refusal reasons on one page.
- [`specs/001-agent-wallet-demo/spec.md`](../specs/001-agent-wallet-demo/spec.md): what the demo
  must do, as user stories.

## 3. How a payment works (feature 001)

1. The agent requests a paid API and gets back `402 Payment Required` with a price
   ([x402](https://www.x402.org/)).
2. The agent calls `wallet.authorize(nonce, payee, amount, …)` on-chain. The contract checks
   every rule. If any fails, it emits `PaymentRefused` with **exactly one reason** and stops:
   nothing is signed and no money moves. If all pass, it reserves the budget and records the
   exact payment it is willing to make.
3. The agent signs a standard USDC transfer (EIP-3009) *from the wallet*.
4. USDC asks the wallet, "is this signature valid?" (ERC-1271). The wallet says yes only for a
   payment it reserved in step 2. So the agent's key alone can't move money: the contract has
   to agree first.

Refusals are events, not errors, so blocked payments are on the public record too. That's how
the dashboard can show "refused: over the daily budget".

Read:
- [`research.md` › R2](../specs/001-agent-wallet-demo/research.md) explains why this design
  works with x402, and the test that proved it before anything was built.
- [`data-model.md`](../specs/001-agent-wallet-demo/data-model.md) covers the rules, budgets,
  reservations and every refusal reason.
- [`contracts/policy-wallet.md`](../specs/001-agent-wallet-demo/contracts/policy-wallet.md) is
  the contract's functions and events: the public interface.
- [`contracts/src/PolicyWallet.sol`](../contracts/src/PolicyWallet.sol) is the code (`authorize`,
  `_check`, `isValidSignature`).

## 4. Whom it may pay (feature 002, ERC-8004)

A fixed list of allowed payees is safe but rigid. Feature 002 lets the wallet also pay a
service that isn't on the list, if it has a good enough **reputation from reviewers the
operator trusts**, read on-chain inside `authorize`:

- Services prove who they are with an [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004)
  identity, whose registered wallet must be the payee. That stops an impostor using someone
  else's identity.
- The rule on the demo wallet: an average of ≥ 70 from ≥ 3 trusted reviews.
- After each paid call, the agent rates the service on-chain. It can only rate a payment that
  really settled to an identity the wallet checked, so reviews can't be invented.

Read:
- [`specs/002-trusted-payees-erc8004/spec.md`](../specs/002-trusted-payees-erc8004/spec.md).
- [`research.md` › R4](../specs/002-trusted-payees-erc8004/research.md) explains why ratings
  can't be faked.
- [`contracts/policy-wallet-reputation.md`](../specs/002-trusted-payees-erc8004/contracts/policy-wallet-reputation.md)
  covers `checkPayee`, `rate` and the five new refusal reasons.
- [`quickstart-results.md`](../specs/002-trusted-payees-erc8004/quickstart-results.md) records
  what happened when it ran live.

## 5. Trying it without risk (feature 003)

The try page doesn't send transactions. It asks a public node to **dry-run** the wallet's
`authorize` call (`eth_simulateV1`), as if sent from the agent's address, against the live
state. The node runs the deployed contract's real code and returns the event it *would* emit,
so the answer is the contract's own, at no cost and with no key.

Read: [`specs/003-try-to-overspend/spec.md`](../specs/003-try-to-overspend/spec.md).

## 6. An agent hires an agent (feature 004)

Paying for an API answer is instant. Hiring another agent isn't: the work comes later and may
be bad. The **JobEscrow** contract holds the hirer's money until the work is checked:

1. The hirer's wallet pays the price into the escrow. Every wallet rule still applies, and
   the escrow also asks the wallet whether it may pay this **worker** (feature 002's
   `checkPayee`).
2. The worker delivers. The hash of its result goes on-chain.
3. The hirer checks the result and **accepts**, so the worker is paid, or **rejects**, which
   opens a dispute that only the wallet's operator can settle.
4. Every step has a deadline, so no job is ever stuck: a late worker means a refund, a silent
   hirer means the worker is paid, and a silent arbiter means a refund.

The scheduled demo run hires `worker-bot-01` every 6 hours: one honest job, plus either a
dispute (a sloppy result the hirer's check catches) or a no-show. It publishes each job's spec
and result in [`apps/dashboard/src/data/jobs.json`](../apps/dashboard/src/data/jobs.json)
(written by the first scheduled run after 2026-10-12), so anyone can check them against the
hashes on-chain.

Read:
- [`specs/004-agent-hires-agent/spec.md`](../specs/004-agent-hires-agent/spec.md) and
  [`plan.md`](../specs/004-agent-hires-agent/plan.md) (R1: why the wallet's rules reach the
  worker).
- [`security-review.md`](../specs/004-agent-hires-agent/security-review.md): what could go
  wrong and how it's handled (a self-review, not an audit).
- [`contracts/src/JobEscrow.sol`](../contracts/src/JobEscrow.sol).

## 7. Why you can trust the claims

- **Tests are the evidence.** Every refusal reason has a fuzz test showing no money moves.
  Invariant tests run random sequences of calls and check that spending never exceeds a limit
  and that no job pays twice. Fork tests run against the real Base Sepolia USDC. See
  [`contracts/test/`](../contracts/test/).
- **The record is public.** Every row on the dashboard links to its transaction on
  [BaseScan](https://sepolia.basescan.org).
- **The ground rules are written down.**
  [`.specify/memory/constitution.md`](../.specify/memory/constitution.md) sets out: test network
  only, rules enforced on-chain, the operator key never in CI, $0 running cost, and standards
  over inventions.

## 8. Run it yourself

- [`contracts/README.md`](../contracts/README.md) covers building and testing the contracts
  (Foundry).
- [`specs/001-agent-wallet-demo/quickstart.md`](../specs/001-agent-wallet-demo/quickstart.md)
  runs a wallet, the paid API and the agent end to end on Base Sepolia.
- [`specs/002-trusted-payees-erc8004/quickstart.md`](../specs/002-trusted-payees-erc8004/quickstart.md)
  sets up identities and reputation.
- [`specs/004-agent-hires-agent/quickstart.md`](../specs/004-agent-hires-agent/quickstart.md)
  deploys the escrow and a worker.

## What to skip

The `tasks.md` and `plan.md` files are build checklists and design logs, useful only if you're
changing that feature. [`apps/dashboard/DESIGN.md`](../apps/dashboard/DESIGN.md) is only about
where the dashboard's shared styles come from.
