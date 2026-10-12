# When an AI agent hires another agent: pay for the work only after checking it

*Edward Zhou · [Yunshu AI](https://yunshu.ai) · 12 October 2026 · [中文版](2026-10-agent-hires-agent-zh.md)*

In [the first part](2026-10-agent-pays-safely.md) of this demo, an AI agent pays for API calls
from a wallet whose limits live in a smart contract. That works because an API call is
instant: the agent pays, the answer comes back, done.

Hiring another agent isn't like that. The work arrives later, and it might be wrong, or never
arrive at all. So the hiring agent needs one more thing: **a way to hold the money until it has
checked the work**, without opening a hole in the spending rules it already has.

I added that to the demo. Every few hours, `research-bot-01` hires `worker-bot-01` for a small
task (average three prices) through an escrow contract on Base Sepolia. You can watch the jobs
on [demo.yunshu.ai](https://demo.yunshu.ai) and read the code
[on GitHub](https://github.com/edxzh/agent-wallet). Here are the four ideas, and what went
wrong on the way.

## 1. Put the money in escrow, and make sure the rules still see the worker

The hiring agent pays the job's price into a `JobEscrow` contract, through the same
`authorize` call as any payment. So the per-payment cap, the daily budget and the task budgets
all still apply.

My first design had a hole I didn't see until I reviewed it. The wallet's **payee rules**
(the allowlist, and paying unknown services only with a good reputation) only ever saw one
payee: the escrow. Once the operator allowed the escrow, the agent could "hire" anyone at all.
On the [try page](https://demo.yunshu.ai/try/), "pay a stranger" is refused; "hire a stranger"
would have got through.

The fix keeps the wallet unchanged. Before taking any money, the escrow asks the hiring wallet
the same question it asks about every payee, "may I pay this worker?" (`checkPayee`). If the
answer is no, the escrow records a refusal event and moves nothing.

The lesson is general: **when you put a contract between an agent and the people it pays,
check which address your rules actually see.**

## 2. The worker commits its answer on-chain, the hirer checks it

The worker delivers a result and puts its hash on-chain. The hirer receives the text, checks
that it matches the hash, then checks the answer itself. Every run also publishes the task and
the answer, so anyone can recompute both hashes and the average.

Some jobs go wrong on purpose. In
[this one](https://sepolia.basescan.org/tx/0xb6f19a8b19e706080bbb40f96f8590bae0d57350713249bc189174d0adf43fbd),
the worker has a plausible bug: it averages only the first two prices, and answers 1044.81
instead of 1043.46. The hirer's check catches it and
[rejects the delivery](https://sepolia.basescan.org/tx/0x598235f201eae274cd06f3f31449198c15f378765a8ae19a5b37151d31768172).
In the honest job a minute earlier, the check passed and the hirer
[accepted](https://sepolia.basescan.org/tx/0x01ffd5c138d8b6630146509bb6245693f8d4cb43bef324e99efc01d53c3b1fa1),
paying the worker.

## 3. A dispute needs a judge who isn't the hirer

A rejected delivery becomes a **dispute**, and the money stays put. Only the job's arbiter can
pay the worker or refund the hirer, and the escrow requires the arbiter to be the hiring
wallet's **operator**. As first written, the hiring agent could have named itself, which would
make the hirer the judge of its own dispute. The worker can't be the arbiter either.

To be honest about the limits: in this demo one owner runs both wallets, so the arbiter isn't
independent of the worker. A real marketplace would need workers run by someone else, or a
third-party arbiter.

## 4. Every job ends, whoever goes silent

An escrow that can freeze money for ever is worse than no escrow. So every state has a deadline,
and anyone can trigger what happens after it:
- the worker misses the deadline: the hirer is refunded;
- the hirer doesn't answer in time: the worker is paid;
- the arbiter doesn't rule in time: the hirer is refunded.

Each deadline has exactly one boundary, so no moment allows both the action and its timeout.
Unit tests check each boundary exactly, and a fuzz test tries a thousand random moments in each
window.

The security review found a less obvious way to freeze a job. USDC can **blacklist** an address.
A blacklisted worker can't receive the payout, so paying it reverts, and so did every way of
closing the job, timeouts included. Now the escrow closes the job first and pays second. If the
token refuses the payment, the amount is recorded as owed, and anyone can send it once the token
allows. I tested this against Circle's real token, using its own blacklister role on a local
copy of the chain.

## What surprised me

- **A refusal can leak a signature.** When the escrow refuses a worker, the call that carried
  the hirer's signed transfer is still on-chain, and anyone could submit that signature
  directly. Nothing can be stolen (it can only move money from the wallet into the escrow), but
  it's untidy. So the agent now asks the wallet about the worker with a free read *before*
  signing anything. The check inside the escrow stays as the backstop for a buggy or
  compromised agent.
- **Time slots make a stateless scheduler.** Each job's id comes from its 6-hour slot and its
  kind, so a run needs no state file. Rerunning a slot hires nothing new, and the next run can
  find the last one's jobs to close their timeouts.
- **A local fork isn't the real chain.** Rehearsing on a local copy of Base Sepolia exposed two
  differences: a local chain only mines when a transaction arrives, so "wait for 3
  confirmations" never finished, and it priced gas far higher than the real network, so a
  transaction the agent pays for easily on Base Sepolia ran out of funds locally.
  Both are worth knowing before trusting a rehearsal.

## Try it

- Watch the jobs: [demo.yunshu.ai](https://demo.yunshu.ai), section "Agents hiring agents"
  (中文: [/zh/](https://demo.yunshu.ai/zh/))
- Read the code, the spec and the security review:
  [github.com/edxzh/agent-wallet](https://github.com/edxzh/agent-wallet), `specs/004-agent-hires-agent/`
- New to the project? Start with [How it works](../how-it-works.md)

It's a test-network demo, and the security review is my own, not an audit, so don't put real
money in it. But the pattern holds: the money waits in a contract, the work is checked against
what was committed, a judge other than the hirer settles disputes, and every job ends. If your
agents will be paying each other and you want a second pair of eyes on the design, I'm at
[hello@yunshu.ai](mailto:hello@yunshu.ai).
