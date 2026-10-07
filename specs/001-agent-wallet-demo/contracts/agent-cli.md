# Contract: Agent SDK and CLI (`packages/agent`)

## SDK

```ts
/** x402 ClientEvmSigner whose address is the PolicyWallet. Before signing an EIP-3009
 *  authorization it calls wallet.authorize() on-chain. If that emits PaymentRefused, it throws
 *  PolicyRefusedError and nothing is signed. */
createPolicyWalletSigner(opts: {
  wallet: `0x${string}`;            // PolicyWallet address
  agentKey: `0x${string}`;          // agent private key (env only, never logged)
  taskId?: `0x${string}`;           // defaults to 0x0 (no task)
  rpcUrl?: string;                  // default https://sepolia.base.org
}): ClientEvmSigner;

class PolicyRefusedError extends Error { reason: Reason; nonce: `0x${string}`; txHash: `0x${string}` }
```

It is used with `@x402/fetch` to make a `fetch` that pays automatically:

```ts
const pay = wrapFetchWithPayment(fetch, client /* registered with the policy signer */);
await pay('https://api.demo.yunshu.ai/quote?pair=ETH-USDC');
```

## CLI (`npx agent-wallet <command>`)

All commands read `.env`, **check `eth_chainId == 84532` first and exit 1 otherwise**, and print
one JSON line per event (`--pretty` for humans).

| Command | Key used | Purpose |
| --- | --- | --- |
| `deploy-factory` | operator | Deploy the factory (once) |
| `create-wallet --agent <addr> --name <n> --cap <usdc> --daily <usdc>` | operator | New wallet |
| `set-payee <addr> --allow/--deny` · `set-task <label> --budget <usdc>` · `set-cap` · `set-daily` · `pause` · `unpause` | operator | Change rules (US4) |
| `pay <url> [--task <label>]` | agent | One paid request |
| `run-scenario [--seed n]` | agent | Scripted run: ~3 allowed payments plus deliberate violations (over cap, over daily, payee not allowed, over task budget). Exit 0 if each had the expected outcome (US5) |
| `release-expired` | agent | Call `release` for authorizations past `validBefore` |
| `status` | none | Rules, spent and remaining, balances |

Exit codes: `0` ok · `1` wrong network or config · `2` an outcome differed from what the
scenario expected · `3` insufficient funds (the run stops cleanly, edge case).
