import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { AGENT_REGISTRY } from '../src/services.js';

const PAYEE = {
  quote: '0xD0cf5c6DA15473264a5839f9AD24c014D9f1E1B6',
  reliable: '0x1111111111111111111111111111111111111111',
  flaky: '0x2222222222222222222222222222222222222222',
  newcomer: '0x3333333333333333333333333333333333333333',
  impostor: '0x4444444444444444444444444444444444444444',
};
const env = {
  NETWORK: 'eip155:84532',
  FACILITATOR_URL: 'https://www.x402.org/facilitator',
  PAYEE_ADDRESS: PAYEE.quote,
  PAYEE_RELIABLE: PAYEE.reliable,
  PAYEE_FLAKY: PAYEE.flaky,
  PAYEE_NEWCOMER: PAYEE.newcomer,
  PAYEE_IMPOSTOR: PAYEE.impostor,
  AGENT_ID_QUOTE: '10',
  AGENT_ID_RELIABLE: '11',
  AGENT_ID_FLAKY: '12',
  AGENT_ID_NEWCOMER: '0', // ids start at 0 in the real registry
  FLAKY_DEGRADE_AT: '2026-10-10T12:00:00Z',
  NEWCOMER_OPENS_AT: '2026-10-11T12:00:00Z',
};

/** Offline facilitator: advertises support; verify accepts any payload; settle succeeds. */
const facilitator = () =>
  ({
    getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:84532' }], extensions: [], signers: {} }),
    verify: async () => ({ isValid: true, payer: PAYEE.quote }),
    settle: async () => ({ success: true, transaction: '0x' + 'ab'.repeat(32), network: 'eip155:84532', payer: PAYEE.quote }),
  }) as never;
const app = createApp({ facilitator });

const required = async (path: string, e: Record<string, string> = env) => {
  const res = await app.request(path, {}, e);
  expect(res.status).toBe(402);
  return JSON.parse(atob(res.headers.get('PAYMENT-REQUIRED')!)).accepts[0];
};

/** Calls the route with a stand-in payment (the offline facilitator accepts it) and returns the body. */
const paid = async (path: string) => {
  const req = await required(path);
  const payload = { x402Version: 2, accepted: req, payload: { signature: '0x', authorization: {} } };
  const res = await app.request(path, { headers: { 'PAYMENT-SIGNATURE': btoa(JSON.stringify(payload)) } }, env);
  expect(res.status).toBe(200);
  return (await res.json()) as { pair: string; price: string; asOf: string };
};

afterEach(() => vi.useRealTimers());

describe('demo services (contracts/paid-services.md)', () => {
  it.each([
    ['/quote', PAYEE.quote, '10'],
    ['/s/reliable/quote', PAYEE.reliable, '11'],
    ['/s/flaky/quote', PAYEE.flaky, '12'],
    ['/s/newcomer/quote', PAYEE.newcomer, '0'],
  ])('%s: its own payTo and extra.erc8004, keeping extra.name/version', async (path, payTo, agentId) => {
    vi.useFakeTimers({ now: new Date('2026-10-12T00:00:00Z'), toFake: ['Date'] }); // newcomer open
    const r = await required(`${path}?pair=ETH-USDC`);
    expect(r.payTo).toBe(payTo);
    expect(r.extra).toEqual({ name: 'USDC', version: '2', erc8004: { agentRegistry: AGENT_REGISTRY, agentId } });
  });

  it("/s/impostor/quote claims reliable's id with its own payTo", async () => {
    const r = await required('/s/impostor/quote');
    expect(r.payTo).toBe(PAYEE.impostor);
    expect(r.extra.erc8004).toEqual({ agentRegistry: AGENT_REGISTRY, agentId: '11' });
  });

  it('/s/anonymous/quote claims no identity', async () => {
    const r = await required('/s/anonymous/quote');
    expect(r.payTo).toBe(PAYEE.impostor);
    expect(r.extra).toEqual({ name: 'USDC', version: '2' });
  });

  it('/quote without AGENT_ID_QUOTE keeps 001 behaviour (no identity claimed)', async () => {
    const r = await required('/quote', { ...env, AGENT_ID_QUOTE: '' });
    expect(r.extra).toEqual({ name: 'USDC', version: '2' });
  });

  it('/s/newcomer/quote: 503 with opensAt before NEWCOMER_OPENS_AT, no 402', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-11T11:59:59Z'), toFake: ['Date'] });
    const res = await app.request('/s/newcomer/quote', {}, env);
    expect(res.status).toBe(503);
    expect(res.headers.get('PAYMENT-REQUIRED')).toBeNull();
    expect(await res.json()).toEqual({ error: 'not open yet', opensAt: '2026-10-11T12:00:00.000Z' });
  });

  it('/s/flaky/quote: fresh before FLAKY_DEGRADE_AT, asOf = now − 1 h after', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-10T11:59:00Z'), toFake: ['Date'] });
    expect((await paid('/s/flaky/quote')).asOf).toBe('2026-10-10T11:59:00.000Z');
    vi.setSystemTime(new Date('2026-10-10T12:30:00Z'));
    expect((await paid('/s/flaky/quote')).asOf).toBe('2026-10-10T11:30:00.000Z');
    expect((await paid('/s/reliable/quote')).asOf).toBe('2026-10-10T12:30:00.000Z'); // reliable stays fresh
  });

  it('an unconfigured service answers 503, not a 402', async () => {
    const res = await app.request('/s/reliable/quote', {}, { ...env, PAYEE_RELIABLE: '' });
    expect(res.status).toBe(503);
    expect(res.headers.get('PAYMENT-REQUIRED')).toBeNull();
  });

  it('every route refuses to serve unless NETWORK is Base Sepolia', async () => {
    for (const path of ['/quote', '/s/reliable/quote', '/s/anonymous/quote']) {
      expect((await app.request(path, {}, { ...env, NETWORK: 'eip155:8453' })).status).toBe(500);
    }
  });
});
