# Letting an AI agent pay for itself, without letting it overspend

*Edward Zhou · [Yunshu AI](https://yunshu.ai) · 11 October 2026 · [中文版](2026-10-agent-pays-safely-zh.md)*

AI agents are starting to buy things on their own: an API call here, a dataset there. The
[x402](https://www.x402.org/) standard makes this simple. A service answers `402 Payment
Required` with a price, the agent signs a payment, and the request goes through. What x402
doesn't answer is the question every team asks next: **what stops the agent from spending too
much, or paying the wrong party?**

I built a small, public answer to that question: an agent wallet whose limits live in a smart
contract. It runs live on the Base Sepolia test network at
[demo.yunshu.ai](https://demo.yunshu.ai), and the code is
[on GitHub](https://github.com/edxzh/agent-wallet). Here are the four ideas that make it work,
and what surprised me along the way.

## 1. The wallet is a contract, and the agent only holds a key

The agent doesn't hold the money. A `PolicyWallet` contract does, and the operator (me) sets its
rules:
- a cap per payment;
- a daily budget, reset at midnight UTC;
- budgets per task;
- a list of allowed payees;
- a pause switch.

The agent's key can do exactly one thing: ask the wallet to **authorize** a payment. It can't
change a rule. A stolen agent key can lose at most what the rules allow, and the operator can
pause the wallet at once.

## 2. The standard x402 payment, from a contract

x402's standard `exact` scheme on EVM chains uses EIP-3009: the payer signs a
`TransferWithAuthorization`, and a *facilitator* submits it to the USDC contract. Normally the
payer is an ordinary account. Here the payer is the wallet contract, which can't sign anything
itself.

The answer is **ERC-1271**, the standard for contract signatures:
1. The agent signs the payment with its own key, but with `from` set to the wallet.
2. When USDC sees a contract as the payer, it asks the contract `isValidSignature(…)`.
3. The wallet says yes **only** for a payment it has already authorized, signed by its agent.

So `authorize` is the single gate: rules are checked there, on-chain, before anything is signed.

I didn't assume this would work. Before writing the real wallet, I deployed a 37-line test
contract and paid a real x402 endpoint through the public x402.org facilitator. Two payments
settled ([one of them](https://sepolia.basescan.org/tx/0xe733dc33b67f89295fd6c8c04e8c375356aa1c06562e44456faaa7f3f54b5005)).
One test, one afternoon, and the whole design rested on evidence instead of a reading of the
docs. A pleasant side effect: the facilitator pays the settlement gas, so the agent only needs
gas for its own `authorize` call.

## 3. A refusal is a public record, not an error

The usual way for a contract to say no is to revert. But a reverted transaction leaves no
trace, and the point of this wallet is that **blocked payments are visible too**.

So `authorize` never reverts for a policy reason. It emits `PaymentRefused` with exactly one
reason and returns `false`:
- over the per-payment cap;
- over the daily budget;
- over the task budget;
- payee not allowed;
- paused;
- insufficient funds;
- invalid amount.

No money moves, and anyone can verify the refusal on BaseScan. The dashboard shows each one in
plain language, next to the payments that went through.

## 4. Pay strangers only if people you trust vouch for them

An allowlist is safe but rigid. The second part of the demo lets the wallet pay services it has
never been told about, if they have earned a good reputation, using
[ERC-8004](https://eips.ethereum.org/EIPS/eip-8004)'s public identity and reputation registries
on Base Sepolia.

Two details from the standard turned out to be the whole safety story:
- **Reputation must be read through a list of reviewers.** ERC-8004's summary function requires
  you to name the reviewers whose ratings count. Fake reviews from anyone else simply don't
  count. In the demo, the rule is "average ≥ 70 from ≥ 3 trusted reviews", checked on-chain
  inside `authorize`.
- **Identity is bound to a payment address.** A service claims an ERC-8004 identity, and the
  wallet checks that the identity's registered wallet *is* the payee. An impostor that borrows a
  well-reviewed identity but asks to be paid elsewhere is refused.

Ratings can't be invented either. The wallet itself is the reviewer, and it can rate only a
payment that **settled**, once. Each rating carries the payment's nonce, so every review points
to a real payment. On the dashboard you can watch a reliable service earn trust, a flaky one
lose it, and an impostor get refused every time.

## What surprised me

- **Public RPC nodes lag.** Right after a transaction, `sepolia.base.org` sometimes answered from
  a node one block behind. The facilitator checks signatures on its own node too, so the agent
  now waits for a few confirmations after `authorize` before signing. Read state by events, or at
  the receipt's block, never "latest".
- **Free endpoints have limits that shape the design.** The public RPC returns logs for at most
  500 blocks per call, about 16 minutes on Base. The dashboard therefore renders from a
  snapshot that a scheduled job updates and commits, and only the last few minutes come live
  from the chain. A happy side effect: the page works without JavaScript.
- **Upgradeable registries need pinning.** The ERC-8004 registries are upgradeable contracts run
  by someone else, so every run checks their implementation addresses first and stops before
  paying anything if they changed.

## Try it

- Watch it live: [demo.yunshu.ai](https://demo.yunshu.ai) (中文: [/zh/](https://demo.yunshu.ai/zh/))
- Read the code, specs and test results: [github.com/edxzh/agent-wallet](https://github.com/edxzh/agent-wallet)
- Run it yourself in about 15 minutes, for $0, from the README

It's a test-network demo and not audited, so don't put real money in it. But the pattern is
real: limits in the contract, refusals on the record, and trust you can check. If your team is
letting agents spend money and wants a second pair of eyes on the design, I'm at
[hello@yunshu.ai](mailto:hello@yunshu.ai).
