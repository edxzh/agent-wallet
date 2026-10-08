# Contract: Demo Paid Services (x402 HTTP, identities)

Extends [001's paid service](../../001-agent-wallet-demo/contracts/paid-service.md). Same Worker
(`https://api.demo.yunshu.ai`), same `@x402/hono` setup and same response body. The new
services are separate routes, each with its own `payTo` and its own ERC-8004 identity
(research R5, R9).

| Route | Service | `payTo` | Claims identity | Behaviour |
| --- | --- | --- | --- | --- |
| `GET /quote` | 001's quote API | 001's `SERVICE_PAYEE` (allowlisted in 001) | `quote.agentId` | as 001, plus its identity in `extra`, so payments to it are rated (FR-009). Kept separate from `reliable` so the new services are never allowlisted for the gated wallet |
| `GET /s/reliable/quote` | reliable | `PAYEE_RELIABLE` | `reliable.agentId` | always fresh |
| `GET /s/flaky/quote` | flaky | `PAYEE_FLAKY` | `flaky.agentId` | fresh until `FLAKY_DEGRADE_AT`, then always stale (`asOf` 1 hour old). It depends only on server time, never on anything the agent chooses (research R5) |
| `GET /s/newcomer/quote` | newcomer | `PAYEE_NEWCOMER` | `newcomer.agentId` | `503 {"error":"not open yet","opensAt":…}` before `NEWCOMER_OPENS_AT` (no 402, no payment), then always fresh |
| `GET /s/impostor/quote` | impostor (US6 test) | `PAYEE_IMPOSTOR` | **reliable's** id | always fresh. It must be refused before payment |
| `GET /s/anonymous/quote` | anonymous (US6 #2) | `PAYEE_IMPOSTOR` | none | always fresh |

## 402 body (per route)

001's body, with the identity **merged into** `extra`. `name` and `version` stay, because the
`exact` scheme needs them for USDC's EIP-712 domain:

```jsonc
"extra": {
  "name": "USDC", "version": "2",
  "erc8004": { "agentRegistry": "eip155:84532:0x8004A818BFB912233c491871b3d84c89A494BD9e",
               "agentId": "7" }          // decimal string; omitted for /s/anonymous
}
```

- The quote body itself is unchanged from 001, so the agent's scoring (research R6) sees only
  `pair`, `price` and `asOf`.

## Configuration (Worker vars)

- `PAYEE_RELIABLE`, `PAYEE_FLAKY`, `PAYEE_NEWCOMER`, `PAYEE_IMPOSTOR` (addresses, not keys);
- `AGENT_ID_QUOTE`, `AGENT_ID_RELIABLE`, `AGENT_ID_FLAKY`, `AGENT_ID_NEWCOMER`;
- `FLAKY_DEGRADE_AT` and `NEWCOMER_OPENS_AT` (ISO times).

These are mirrored in `config/services.json`. The Worker still refuses to start unless
`NETWORK = eip155:84532`.

## Identity registration files (`agentURI`)

On-chain `data:application/json;base64,…`, one per service:

```json
{ "type": "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
  "name": "Yunshu demo · Reliable quotes",
  "description": "Demo x402 quote service for the Yunshu agent wallet. Test network only.",
  "image": "https://demo.yunshu.ai/favicon.svg",
  "endpoints": [{ "name": "x402", "endpoint": "https://api.demo.yunshu.ai/s/reliable/quote", "version": "2.0" }],
  "x402Support": true, "active": true, "registrations": [], "supportedTrust": ["reputation"] }
```
