# Agent Wallet

An agent wallet with spending limits and an audit log. An AI agent pays for services on its own
through [x402](https://www.x402.org/), gets stopped before settlement when it goes over budget or
out of scope, and every payment and refusal is on a public record anyone can verify.

> **Status: in progress.** Test network only (Base Sepolia). No real money.

- Live demo (coming): https://demo.yunshu.ai
- Spec, plan and tasks: [`specs/001-agent-wallet-demo/`](specs/001-agent-wallet-demo/)
- Built by [Yunshu AI](https://yunshu.ai)

## How it works (planned)

1. The operator gives each agent a `PolicyWallet` contract with a per-payment cap, a daily budget,
   task budgets and an allowed list of payees.
2. Before paying, the agent asks its wallet to `authorize` the payment on-chain. A payment that
   breaks a rule is refused with a reason, recorded as an event, and no money moves.
3. Allowed payments go through the standard x402 `exact` scheme with test USDC.
4. A public dashboard shows rules, spend, and a timeline of payments and refusals, each linked
   to BaseScan.

Full setup and run instructions will follow as the build progresses.

## License

MIT
