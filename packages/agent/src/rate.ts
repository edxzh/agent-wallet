/**
 * Publishes the wallet's rating for a settled, identity-checked payment (research R4): waits for
 * the facilitator's settlement receipt first, so a lagging RPC node can't make rate() revert as
 * "not settled", then calls wallet.rate and returns the registry's feedbackIndex.
 */
import { parseEventLogs, type Address, type Hex, type TransactionReceipt } from 'viem';
import { policyWalletAbi } from './abi.js';
import type { PayOutcome } from './pay.js';
import { scoreQuote } from './scoring.js';

export const SETTLEMENT_CONFIRMATIONS = 2;

type Clients = {
  publicClient: {
    waitForTransactionReceipt(args: { hash: Hex; confirmations?: number }): Promise<Pick<TransactionReceipt, 'logs' | 'status'>>;
  };
  walletClient: { writeContract(args: any): Promise<Hex> };
};

export type RateOptions = { wallet: Address; nonce: Hex; settlementTx: Hex; score: number; tag: string; endpoint: string; clients: Clients };

export async function ratePayment(o: RateOptions): Promise<{ feedbackIndex: bigint; txHash: Hex }> {
  const settled = await o.clients.publicClient.waitForTransactionReceipt({ hash: o.settlementTx, confirmations: SETTLEMENT_CONFIRMATIONS });
  if (settled.status !== 'success') throw new Error(`Settlement reverted: ${o.settlementTx}`);
  const txHash = await o.clients.walletClient.writeContract({
    address: o.wallet,
    abi: policyWalletAbi,
    functionName: 'rate',
    args: [o.nonce, o.score, o.tag, o.endpoint],
  });
  const receipt = await o.clients.publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== 'success') throw new Error(`rate reverted: ${txHash}`);
  const rated = parseEventLogs({ abi: policyWalletAbi, logs: receipt.logs, eventName: 'PaymentRated' }).find((e) => e.args.nonce === o.nonce);
  if (!rated) throw new Error(`No PaymentRated event for ${o.nonce} in ${txHash}`);
  return { feedbackIndex: rated.args.feedbackIndex, txHash };
}

export type RateDecision =
  | { kind: 'rated'; agentId: bigint; score: number; tag: string; feedbackIndex: bigint; txHash: Hex }
  | { kind: 'not-rated'; reason: string };

/**
 * `pay --rate`: rates only a settled payment whose payee identity the wallet verified. Refused,
 * failed and identity-less payments are never rated (US2 #3).
 */
export async function rateOutcome(
  r: PayOutcome,
  ctx: { url: string; now: Date; wallet: Address; clients: Clients },
): Promise<RateDecision> {
  if (r.kind !== 'settled') return { kind: 'not-rated', reason: `payment ${r.kind}` };
  if (r.agentId === undefined) return { kind: 'not-rated', reason: 'payee has no verified identity' };
  if (!r.settlementTx) return { kind: 'not-rated', reason: 'no settlement transaction' };
  const pair = new URL(ctx.url).searchParams.get('pair') ?? 'ETH-USDC';
  const { score, tag } = scoreQuote({ status: r.status, body: r.body }, { pair, now: ctx.now });
  const { feedbackIndex, txHash } = await ratePayment({
    wallet: ctx.wallet,
    nonce: r.nonce,
    settlementTx: r.settlementTx,
    score,
    tag,
    endpoint: ctx.url.slice(0, 200),
    clients: ctx.clients,
  });
  return { kind: 'rated', agentId: r.agentId, score, tag, feedbackIndex, txHash };
}
