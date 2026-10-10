import { describe, expect, it } from 'vitest';
import { resendOnBareSettleFailure } from '../src/pay.js';

const URL_ = 'https://api.example/s/flaky/quote';
const paid = { headers: { 'PAYMENT-SIGNATURE': 'sig-1' } };
const bare = () => new Response('{}', { status: 402, headers: { 'content-type': 'application/json' } });
const ok = () => new Response('{"pair":"ETH-USDC"}', { status: 200 });

function fake(responses: (() => Response)[]) {
  const seen: Request[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(new Request(input, init));
    return responses[Math.min(seen.length - 1, responses.length - 1)]!();
  }) as typeof fetch;
  return { f, seen };
}

describe('resendOnBareSettleFailure', () => {
  it('resends the same signed payment after a bare 402 {}', async () => {
    const { f, seen } = fake([bare, ok]);
    const res = await resendOnBareSettleFailure(f, 2, 0)(URL_, paid);
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(2);
    expect(seen.map((r) => r.headers.get('PAYMENT-SIGNATURE'))).toEqual(['sig-1', 'sig-1']);
  });

  it('gives up after `tries` resends and returns the last answer', async () => {
    const { f, seen } = fake([bare]);
    const res = await resendOnBareSettleFailure(f, 2, 0)(URL_, paid);
    expect(res.status).toBe(402);
    expect(await res.text()).toBe('{}');
    expect(seen).toHaveLength(3);
  });

  it('never resends a 402 that says why (PAYMENT-REQUIRED)', async () => {
    const said = () => new Response('{}', { status: 402, headers: { 'PAYMENT-REQUIRED': btoa('{"error":"invalid_signature"}') } });
    const { f, seen } = fake([said, ok]);
    expect((await resendOnBareSettleFailure(f, 2, 0)(URL_, paid)).status).toBe(402);
    expect(seen).toHaveLength(1);
  });

  it('never resends an unpaid request (the first 402 asks for payment)', async () => {
    const { f, seen } = fake([bare, ok]);
    expect((await resendOnBareSettleFailure(f, 2, 0)(URL_)).status).toBe(402);
    expect(seen).toHaveLength(1);
  });

  it('passes other answers through untouched', async () => {
    const { f, seen } = fake([() => new Response('{"error":"boom"}', { status: 402 }), ok]);
    expect(await (await resendOnBareSettleFailure(f, 2, 0)(URL_, paid)).text()).toBe('{"error":"boom"}');
    expect(seen).toHaveLength(1);
  });
});
