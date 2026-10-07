# Contract: Demo Paid Service (x402 HTTP)

Host: `https://api.demo.yunshu.ai` (Cloudflare Worker, `@x402/hono` 2.28). Gives payments a
reliable, allowed payee (FR-009).

## `GET /quote?pair=<BASE-QUOTE>`

Returns a deterministic sample quote. The data is illustrative and the response says so.

**Without payment** → `402 Payment Required`, body per the x402 v2 spec:

```jsonc
{
  "x402Version": 2,
  "accepts": [{
    "scheme": "exact",                       // Design B: "policy-wallet-onchain"
    "network": "eip155:84532",               // Base Sepolia
    "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    "amount": "10000",                       // 0.01 USDC
    "payTo": "<service payee address>",
    "maxTimeoutSeconds": 300,
    "extra": { "name": "USDC", "version": "2" }   // EIP-712 domain of the token
  }],
  "error": "payment required"
}
```

**With a valid payment header** (Design A: the x402 `exact` payload, settled through the
x402.org facilitator; Design B: `{ txHash, nonce }`, verified against the `PaymentSettled`
event) → `200`:

```json
{ "pair": "ETH-USDC", "price": "2400.00", "asOf": "2026-10-07T00:00:00Z",
  "note": "Sample data for the Yunshu agent wallet demo", "settlementTx": "0x…" }
```

**Errors**:
- `400` for a malformed `pair`.
- `402` again if the facilitator rejects the payment. The body includes the facilitator's
  reason, and the agent logs it.

The exact header names and payload shape follow the pinned `@x402/*` version. The task 1 test
records the observed headers in research.md.

## Other routes

| Route | Response |
| --- | --- |
| `GET /health` | `200 {"ok":true,"network":"eip155:84532"}` (no payment) |
| anything else | `404` |

**Limits**: the Worker refuses to start unless its configured network is `eip155:84532`.
