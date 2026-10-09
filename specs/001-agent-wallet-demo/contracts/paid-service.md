# Contract: Demo Paid Service (x402 HTTP)

Host: `https://api.demo.yunshu.ai` (Cloudflare Worker, `@x402/hono` 2.28). Gives payments a
reliable, allowed payee (FR-009).

## `GET /quote?pair=<BASE-QUOTE>`

Returns a deterministic sample quote. The data is illustrative and the response says so.

Validation runs before payment, so a malformed request is never charged.

**Without payment** → `402 Payment Required`. The body is `{}`; the requirements are in the
`PAYMENT-REQUIRED` response **header**, base64 JSON per the x402 v2 spec (research.md R2):

```jsonc
{
  "x402Version": 2,
  "resource": { "url": "https://api.demo.yunshu.ai/quote?pair=ETH-USDC", "description": "…" },
  "accepts": [{
    "scheme": "exact",
    "network": "eip155:84532",               // Base Sepolia
    "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    "amount": "10000",                       // 0.01 USDC
    "payTo": "<service payee address>",
    "maxTimeoutSeconds": 300,
    "extra": { "name": "USDC", "version": "2" }   // EIP-712 domain of the token
  }]
}
```

**With a valid `PAYMENT-SIGNATURE` request header** (the x402 `exact` payload: an EIP-3009
authorization with `from` = the PolicyWallet, signed by the agent key and accepted through
ERC-1271; settled by the x402.org facilitator) → `200`, with a `PAYMENT-RESPONSE` header (base64
JSON `{ success, payer, transaction, network }`; `transaction` is the settlement tx):

```json
{ "pair": "ETH-USDC", "price": "2400.00", "asOf": "2026-10-07T00:00:00.000Z",
  "note": "Sample data for the Yunshu agent wallet demo. Test network only." }
```

**Errors**:
- `400` for a malformed `pair` (expected `^[A-Z]{2,10}-[A-Z]{2,10}$`; default `ETH-USDC`).
- `402` again if the facilitator rejects the payment (e.g. `invalid_exact_evm_signature` when the
  wallet never authorized the digest). The agent logs the reason.
- `500` if `PAYEE_ADDRESS` is not configured.

The v1 header names `X-PAYMENT` and `X-PAYMENT-RESPONSE` are still recognised by the libraries.

## Other routes

| Route | Response |
| --- | --- |
| `GET /health` | `200 {"ok":true,"network":"eip155:84532","testnetOnly":true}` (no payment) |
| anything else | `404` |

**Limits**: the Worker answers `500` to every request unless its configured network is
`eip155:84532`.
