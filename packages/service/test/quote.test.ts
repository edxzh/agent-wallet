import { describe, expect, it } from 'vitest';
import { createApp, samplePrice } from '../src/app.js';

const env = {
  NETWORK: 'eip155:84532',
  PAYEE_ADDRESS: '0xD0cf5c6DA15473264a5839f9AD24c014D9f1E1B6',
  FACILITATOR_URL: 'https://www.x402.org/facilitator',
};
// Offline stand-in for the x402.org facilitator: only advertises what it supports.
const facilitator = () =>
  ({
    getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:84532' }], extensions: [], signers: {} }),
    verify: async () => ({ isValid: false, invalidReason: 'offline test' }),
    settle: async () => ({ success: false, errorReason: 'offline test', transaction: '', network: 'eip155:84532' }),
  }) as never;
const app = createApp({ facilitator });

describe('paid service', () => {
  it('GET /health needs no payment', async () => {
    const res = await app.request('/health', {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, network: 'eip155:84532', testnetOnly: true });
  });

  it('GET /quote without payment → 402 with exact USDC requirements in PAYMENT-REQUIRED', async () => {
    const res = await app.request('/quote?pair=ETH-USDC', {}, env);
    expect(res.status).toBe(402);
    const header = res.headers.get('PAYMENT-REQUIRED');
    expect(header).toBeTruthy();
    const required = JSON.parse(atob(header!));
    expect(required.x402Version).toBe(2);
    expect(required.accepts[0]).toMatchObject({
      scheme: 'exact',
      network: 'eip155:84532',
      amount: '10000',
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      payTo: env.PAYEE_ADDRESS,
      extra: { name: 'USDC', version: '2' },
    });
  });

  it('GET /quote with a bad pair → 400 before any payment', async () => {
    const res = await app.request('/quote?pair=eth/usd', {}, env);
    expect(res.status).toBe(400);
    expect(res.headers.get('PAYMENT-REQUIRED')).toBeNull();
  });

  it('refuses to serve on any network but Base Sepolia', async () => {
    const res = await app.request('/health', {}, { ...env, NETWORK: 'eip155:8453' });
    expect(res.status).toBe(500);
  });

  it('unknown routes → 404', async () => {
    expect((await app.request('/nope', {}, env)).status).toBe(404);
  });

  it('sample prices are deterministic', () => {
    expect(samplePrice('ETH-USDC')).toBe('2400.00');
    expect(samplePrice('ABC-USDC')).toBe(samplePrice('ABC-USDC'));
  });
});
