# Implementation Plan: Try to Make It Overspend

**Spec**: [spec.md](spec.md) · **Date**: 2026-10-11

## Summary

A static Astro page in `apps/dashboard` (`/try/`, `/zh/try/`) with preset and custom attacks. A
lazily loaded script dry-runs the wallet call with `eth_simulateV1` on `https://sepolia.base.org`
(the RPC the live tail already uses) and decodes the resulting event with viem.

Verified before building (2026-10-11, live research-bot-01): allowed 0.01 → `PaymentAuthorized`;
10 USDC → reason 4; unknown address → 8; impostor claiming 9614 → 9; flaky → 12; newcomer → 11;
archive-research task → 5; 0.5 USDC ×3 → authorized, 6, 6.

## Constitution Check

| Principle | Status |
|---|---|
| I. Testnet only | Pass. The script checks `eth_chainId` = 84532 before simulating; "test network only" banner. |
| II. Rules on-chain, refusals on record | Pass. Outcomes come from the contract. The page says dry runs are not on the record and links the real ones. |
| III. Proven contracts | N/A. No contract change. |
| IV. Keys | Pass. No key anywhere: `from` is the agent's public address in a simulation. |
| V. Zero cost | Pass. Public RPC, one request per attack, only on a visitor's click. |
| VI. Standards | Pass. `eth_simulateV1` is a standard execution-API method; viem is already a dependency. |
| VII. Readable dashboard | Pass. Bilingual, plain-language reasons (reused), no-JS fallback, lazy JS. |

## Files

- `apps/dashboard/src/lib/attacks.ts`: preset attacks built from `history.json` and their copy keys
- `apps/dashboard/src/components/Try.astro`, `src/pages/try/index.astro`, `src/pages/zh/try/index.astro`
- `apps/dashboard/src/scripts/try.ts`: encode, simulate, decode, render
- `apps/dashboard/src/components/Page.astro`: `path` prop for canonical, hreflang and language links
- `apps/dashboard/src/i18n/{en,zh}.json`: `try` section, dashboard link
- `apps/dashboard/tests/try.spec.ts`: presets render, no-JS fallback, results decoded from a mocked RPC
- `scripts/check-try.ts`: live check that each preset gets its expected reason today

## Complexity Tracking

None. No new dependency.
