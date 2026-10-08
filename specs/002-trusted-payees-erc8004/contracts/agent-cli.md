# Contract: Agent SDK and CLI additions (`packages/agent`)

Extends [001's SDK and CLI](../../001-agent-wallet-demo/contracts/agent-cli.md). All of 001's
rules apply:
- check the chain id first;
- one JSON line per event;
- never print a key.

## SDK

```ts
/** 001's signer, now identity-aware. Registers an onBeforePaymentCreation hook that reads
 *  selectedRequirements.extra.erc8004. If its agentRegistry equals the pinned identity
 *  registry, the signer calls authorizeWithIdentity(…, agentId); otherwise authorize(…) (001).
 *  On refusal it throws PolicyRefusedError (now also with reasons 8–12). */
createPolicyWalletClient(opts: CreatePolicyWalletSignerOptions & { erc8004: Erc8004Config }): x402Client;

/** Pure and deterministic (research R6). */
scoreQuote(res: { status: number; body: unknown }, req: { pair: string; now: Date }):
  { score: number; tag: 'accurate' | 'stale' | 'wrong-data' | 'malformed' };

/** First waits for the facilitator's settlement tx receipt (hash from the x402 payment
 *  response), then calls wallet.rate(nonce, score, tag, endpoint) and waits for that receipt.
 *  Returns feedbackIndex and txHash. Called only after a settled payment that had an identity. */
ratePayment(opts: { wallet; agentKey; nonce; settlementTx; score; tag; endpoint }): Promise<{ feedbackIndex: bigint; txHash: `0x${string}` }>;

/** Reads the ERC-1967 implementation slot of both registries and compares it with
 *  config/erc8004.json. Throws RegistryChangedError on a mismatch (research R8). */
assertRegistriesPinned(): Promise<void>;
```

## CLI (`npx agent-wallet <command>`)

| Command | Key used | Purpose |
| --- | --- | --- |
| `register-services` | services-owner + payee keys, including 001's `SERVICE_PAYEE` key (local only) | Register quote, reliable, flaky and newcomer: `register(agentURI)`, then `setAgentWallet` signed by each payee key. Writes the ids to `config/services.json`. Idempotent: skips existing ids whose wallet already matches |
| `set-reputation --wallet <w> --min-avg <0-100> --min-count <n> [--off]` | operator | `setReputationRule` (US1) |
| `trust-reviewer --wallet <w> <addr> [--remove]` | operator | `setTrustedReviewer` |
| `pay <url> [--task <label>] [--rate]` | agent | 001's `pay`. With `--rate`, scores the response and rates it once settled |
| `run-scenario` | agent | In order: (1) `assertRegistriesPinned`; (2) each scout pays and rates every open demo service; (3) 001's scenario on `research-bot-01`, except that 001's "payee not allowed" probe runs on `scout-02` (rule off, still reason 3); (4) the gated wallet tries reliable, flaky, newcomer, impostor and anonymous. It rates every settled payment that had an identity, `/quote` included. **Every expected outcome is computed with `checkPayee` just before the attempt**, never hard-coded. Exit 0 if every outcome matches |
| `reputation [--service <key>]` | none | Per service: identity, registered wallet, trusted count and average (`getSummary`), `checkPayee` for the gated wallet |

**Exit codes**: 001's codes (`0` ok, `1` wrong network or config, `2` an unexpected outcome, `3`
insufficient funds), plus `4`: a registry implementation changed, so the run stops before any
payment (research R8).
