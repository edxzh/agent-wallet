import { describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, getAddress, type Hex } from 'viem';
import { policyWalletAbi } from '../src/abi.js';
import type { PayOutcome } from '../src/pay.js';
import { rateOutcome, ratePayment, SETTLEMENT_CONFIRMATIONS } from '../src/rate.js';

const wallet = getAddress('0x00000000000000000000000000000000000000aa');
const nonce = ('0x' + '33'.repeat(32)) as Hex;
const settlementTx = ('0x' + 'aa'.repeat(32)) as Hex;
const rateTx = ('0x' + 'bb'.repeat(32)) as Hex;

const ratedLog = {
  address: wallet,
  topics: encodeEventTopics({ abi: policyWalletAbi, eventName: 'PaymentRated', args: { nonce, agentId: 4n } } as never),
  data: encodeAbiParameters([{ type: 'uint8' }, { type: 'string' }, { type: 'uint64' }], [90, 'accurate', 17n]),
};

function clients(settlementStatus: 'success' | 'reverted' = 'success') {
  const order: string[] = [];
  const waitForTransactionReceipt = vi.fn(async ({ hash }: { hash: Hex }) => {
    order.push(`receipt:${hash === settlementTx ? 'settlement' : 'rate'}`);
    return hash === settlementTx ? { status: settlementStatus, logs: [] } : { status: 'success' as const, logs: [ratedLog as never] };
  });
  const writeContract = vi.fn(async (_a: any) => {
    order.push('rate');
    return rateTx;
  });
  return { order, writeContract, waitForTransactionReceipt, c: { publicClient: { waitForTransactionReceipt }, walletClient: { writeContract } } };
}

describe('ratePayment (research R4)', () => {
  it('waits for the settlement receipt, then rates and returns the feedbackIndex', async () => {
    const t = clients();
    const r = await ratePayment({ wallet, nonce, settlementTx, score: 90, tag: 'accurate', endpoint: 'https://x/quote', clients: t.c });
    expect(t.order).toEqual(['receipt:settlement', 'rate', 'receipt:rate']);
    expect(t.waitForTransactionReceipt.mock.calls[0]![0]).toEqual({ hash: settlementTx, confirmations: SETTLEMENT_CONFIRMATIONS });
    expect(t.writeContract.mock.calls[0]![0]).toMatchObject({ functionName: 'rate', args: [nonce, 90, 'accurate', 'https://x/quote'] });
    expect(r).toEqual({ feedbackIndex: 17n, txHash: rateTx });
  });

  it('never rates when the settlement reverted', async () => {
    const t = clients('reverted');
    await expect(ratePayment({ wallet, nonce, settlementTx, score: 90, tag: 'accurate', endpoint: '', clients: t.c })).rejects.toThrow(/Settlement reverted/);
    expect(t.writeContract).not.toHaveBeenCalled();
  });
});

describe('pay --rate (rateOutcome)', () => {
  const ctx = (t: ReturnType<typeof clients>) => ({ url: 'https://api.demo.yunshu.ai/quote?pair=ETH-USDC', now: new Date('2026-10-09T12:00:00Z'), wallet, clients: t.c });
  const settled = (over: Partial<Extract<PayOutcome, { kind: 'settled' }>> = {}): PayOutcome => ({
    kind: 'settled',
    status: 200,
    nonce,
    authorizeTx: rateTx,
    settlementTx,
    amount: 10_000n,
    payee: wallet,
    body: { pair: 'ETH-USDC', price: '2400.00', asOf: '2026-10-09T11:59:50Z' },
    agentId: 4n,
    ...over,
  });

  it('never calls rate for a refused payment', async () => {
    const t = clients();
    const d = await rateOutcome({ kind: 'refused', reason: 'PAYEE_REPUTATION_TOO_LOW', nonce, authorizeTx: rateTx }, ctx(t));
    expect(d.kind).toBe('not-rated');
    expect(t.writeContract).not.toHaveBeenCalled();
  });

  it('never calls rate for a payment without a verified identity', async () => {
    const t = clients();
    const d = await rateOutcome(settled({ agentId: undefined }), ctx(t));
    expect(d).toEqual({ kind: 'not-rated', reason: 'payee has no verified identity' });
    expect(t.writeContract).not.toHaveBeenCalled();
  });

  it('scores and rates a settled, identity-checked payment', async () => {
    const t = clients();
    const d = await rateOutcome(settled(), ctx(t));
    expect(d).toMatchObject({ kind: 'rated', agentId: 4n, score: 90, tag: 'accurate', feedbackIndex: 17n });
  });
});
