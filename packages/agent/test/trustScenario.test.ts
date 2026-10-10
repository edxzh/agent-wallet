import { describe, expect, it, vi } from 'vitest';
import { getAddress, type Address, type Hex } from 'viem';
import type { PayOutcome } from '../src/pay.js';
import { RegistryChangedError } from '../src/registries.js';
import { EXIT } from '../src/scenario.js';
import type { WalletState } from '../src/state.js';
import { runTrustScenario, type Requirement, type TrustDeps } from '../src/trustScenario.js';

const A = (n: number) => getAddress(`0x${n.toString(16).padStart(40, '0')}`);
const gated = A(1);
const scouts = [
  { name: 'scout-02', wallet: A(2) },
  { name: 'scout-03', wallet: A(3) },
];
const PAYEES: Record<string, Address> = { quote: A(10), reliable: A(11), flaky: A(12), newcomer: A(13), impostor: A(14), anonymous: A(14) };
const IDS: Record<string, bigint | undefined> = { quote: 0n, reliable: 1n, flaky: 2n, newcomer: 3n, impostor: 1n, anonymous: undefined };
const urlOf = (k: string) => `https://api.demo.yunshu.ai/${k === 'quote' ? 'quote' : `s/${k}/quote`}?pair=ETH-USDC`;
const keyOf = (u: string) => Object.keys(PAYEES).find((k) => u === urlOf(k))!;
const LINK_URL = 'https://api.demo.yunshu.ai/quote?pair=LINK-USDC';

const state = (over: Partial<WalletState> = {}): WalletState => ({
  paused: false,
  perPaymentCap: 1_000_000n,
  dailyBudget: 5_000_000n,
  spentToday: 0n,
  day: 1n,
  balance: 10_000_000n,
  tasks: {},
  payees: {},
  now: 1_000n,
  ...over,
});

/**
 * A fake world: `scope[wallet][key]` is what checkPayee returns; pay follows it (the contract and
 * checkPayee agree). Calls are recorded in order.
 */
function world(opts: { scope?: (wallet: Address, key: string) => string; closed?: string[]; lie?: string; pinned?: boolean; rateFails?: boolean } = {}) {
  const calls: string[] = [];
  let n = 0;
  const scope = opts.scope ?? ((w: Address, k: string) => (w === gated ? ({ quote: 'NONE', reliable: 'NONE', flaky: 'PAYEE_REPUTATION_TOO_LOW', newcomer: 'NOT_ENOUGH_TRUSTED_REVIEWS', impostor: 'PAYEE_IDENTITY_MISMATCH', anonymous: 'PAYEE_IDENTITY_UNVERIFIED' } as Record<string, string>)[k]! : 'NONE'));
  const lines: Record<string, unknown>[] = [];
  const d: TrustDeps = {
    assertPinned: vi.fn(async () => {
      calls.push('pinned');
      if (opts.pinned === false) throw new RegistryChangedError('reputation', '0xaaa', '0xbbb');
    }),
    services: Object.keys(PAYEES).map((key) => ({ key, url: urlOf(key) })),
    scouts,
    gated,
    requirement: vi.fn(async (u: string): Promise<Requirement> => {
      const k = keyOf(u);
      return opts.closed?.includes(k) ? { open: false, status: 503 } : { open: true, payTo: PAYEES[k]!, agentId: IDS[k] };
    }),
    readState: vi.fn(async () => state()),
    checkPayee: vi.fn(async (w: Address, _p: Address, _id: bigint | undefined) => scope(w, keyOf(lastUrl))),
    pay: vi.fn(async (w: Address, u: string): Promise<PayOutcome> => {
      const k = keyOf(u);
      calls.push(`pay ${w === gated ? 'gated' : scouts.find((s) => s.wallet === w)!.name} ${k}`);
      const reason = opts.lie === k ? 'PAYEE_REPUTATION_TOO_LOW' : scope(w, k);
      const nonce = `0x${(++n).toString(16).padStart(64, '0')}` as Hex;
      return reason === 'NONE'
        ? { kind: 'settled', status: 200, nonce, authorizeTx: nonce, settlementTx: nonce, amount: 10_000n, payee: PAYEES[k]!, body: {}, agentId: IDS[k] }
        : { kind: 'refused', reason, nonce, authorizeTx: nonce };
    }),
    rate: vi.fn(async (w: Address, out: PayOutcome) => {
      calls.push(`rate ${w === gated ? 'gated' : 'scout'}`);
      if (opts.rateFails) throw new Error('rate reverted');
      return { kind: 'rated' as const, agentId: (out as { agentId: bigint }).agentId, score: 90, tag: 'accurate', feedbackIndex: 1n, txHash: '0x01' as Hex };
    }),
    run001: vi.fn(async (rateSettled) => {
      calls.push('001');
      const q = await d.pay(gated, urlOf('quote'));
      return (await rateSettled(q as never, LINK_URL)) ? EXIT.OK : EXIT.MISMATCH;
    }),
    quoteAmount: 10_000n,
    log: (l) => lines.push(l),
  };
  // checkPayee is called right after requirement(url): remember which URL it's for.
  let lastUrl = '';
  const req = d.requirement;
  d.requirement = vi.fn(async (u: string) => ((lastUrl = u), req(u)));
  return { d, calls, lines };
}

describe('runTrustScenario (T046)', () => {
  it('checks the pins first, then scouts, then 001, then the gated wallet against all five services', async () => {
    const { d, calls } = world();
    expect(await runTrustScenario(d)).toBe(EXIT.OK);
    expect(calls.filter((c) => !c.startsWith('rate'))).toEqual([
      'pinned',
      'pay scout-02 reliable', 'pay scout-02 flaky', 'pay scout-02 newcomer',
      'pay scout-03 reliable', 'pay scout-03 flaky', 'pay scout-03 newcomer',
      '001', 'pay gated quote',
      'pay gated reliable', 'pay gated flaky', 'pay gated newcomer', 'pay gated impostor', 'pay gated anonymous',
    ]);
  });

  it('rates every settled payment with a verified identity, /quote included, and nothing refused', async () => {
    const { d, calls } = world();
    await runTrustScenario(d);
    // 6 scout payments + gated quote + gated reliable settle; the other 4 gated attempts are refused.
    expect(calls.filter((c) => c.startsWith('rate')).length).toBe(8);
    expect(d.rate).toHaveBeenCalledTimes(8);
  });

  it("rates 001's payments against the URL actually paid (its pair)", async () => {
    const { d } = world();
    await runTrustScenario(d);
    const quoteRating = (d.rate as ReturnType<typeof vi.fn>).mock.calls.find((c) => String(c[2]).startsWith('https://api.demo.yunshu.ai/quote?'));
    expect(quoteRating?.[2]).toBe(LINK_URL);
  });

  it('takes every expectation from checkPayee just before the attempt', async () => {
    const { d, lines } = world();
    await runTrustScenario(d);
    const gatedSteps = lines.filter((l) => String(l.step).startsWith('gated →'));
    expect(gatedSteps.map((l) => [l.step, l.expected, l.ok])).toEqual([
      ['gated → reliable', 'NONE', true],
      ['gated → flaky', 'PAYEE_REPUTATION_TOO_LOW', true],
      ['gated → newcomer', 'NOT_ENOUGH_TRUSTED_REVIEWS', true],
      ['gated → impostor', 'PAYEE_IDENTITY_MISMATCH', true],
      ['gated → anonymous', 'PAYEE_IDENTITY_UNVERIFIED', true],
    ]);
  });

  it('exits 4 on a changed registry before any payment', async () => {
    const { d, calls } = world({ pinned: false });
    expect(await runTrustScenario(d)).toBe(EXIT.REGISTRY_CHANGED);
    expect(calls).toEqual(['pinned']);
    expect(d.pay).not.toHaveBeenCalled();
  });

  it('exits 2 when an outcome differs from checkPayee', async () => {
    const { d } = world({ lie: 'reliable' });
    expect(await runTrustScenario(d)).toBe(EXIT.MISMATCH);
  });

  it('exits 2 when a rating fails', async () => {
    const { d } = world({ rateFails: true });
    expect(await runTrustScenario(d)).toBe(EXIT.MISMATCH);
  });

  it('exits 3 on insufficient funds', async () => {
    const { d } = world({ scope: () => 'INSUFFICIENT_FUNDS' });
    expect(await runTrustScenario(d)).toBe(EXIT.INSUFFICIENT_FUNDS);
  });

  it('skips a closed service (newcomer before it opens) without a payment attempt', async () => {
    const { d, calls } = world({ closed: ['newcomer'] });
    expect(await runTrustScenario(d)).toBe(EXIT.OK);
    expect(calls.some((c) => c.endsWith('newcomer'))).toBe(false);
  });
});
