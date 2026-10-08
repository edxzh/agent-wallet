import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import type { Address, Hex } from 'viem';
import { NETWORK } from './config.js';
import { createPolicyWalletSigner, PolicyRefusedError, type AuthorizedPayment } from './signer.js';

export type PayOutcome =
  | { kind: 'settled'; status: number; nonce: Hex; authorizeTx: Hex; settlementTx?: Hex; amount: bigint; payee: Address; body: unknown }
  | { kind: 'refused'; reason: string; nonce: Hex; authorizeTx: Hex }
  | { kind: 'failed'; status?: number; error: string; nonce?: Hex; authorizeTx?: Hex };

/** One paid request through x402, paid from the PolicyWallet. */
export async function payUrl(
  url: string,
  opts: { wallet: Address; agentKey: Hex; taskId?: Hex; rpcUrl: string; fetchImpl?: typeof fetch },
): Promise<PayOutcome> {
  let authorized: AuthorizedPayment | undefined;
  let refusal: PolicyRefusedError | undefined;
  const signer = createPolicyWalletSigner({ ...opts, onAuthorized: (p) => (authorized = p), onRefused: (e) => (refusal = e) });
  const client = new x402Client().register(NETWORK, new ExactEvmScheme(signer as never));
  const paying = wrapFetchWithPayment(opts.fetchImpl ?? fetch, client);
  try {
    const res = await paying(url);
    const header = res.headers.get('PAYMENT-RESPONSE') ?? res.headers.get('X-PAYMENT-RESPONSE');
    const settlement = header ? (decodePaymentResponseHeader(header) as { success?: boolean; transaction?: Hex }) : undefined;
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {}
    if (res.ok && authorized) {
      return {
        kind: 'settled',
        status: res.status,
        nonce: authorized.nonce,
        authorizeTx: authorized.txHash,
        settlementTx: settlement?.transaction,
        amount: authorized.amount,
        payee: authorized.payee,
        body,
      };
    }
    // x402 v2 puts the facilitator's reason in the PAYMENT-REQUIRED header's `error`.
    const required = res.headers.get('PAYMENT-REQUIRED');
    let reason = typeof body === 'string' ? body : JSON.stringify(body);
    if (required) {
      try {
        reason = (JSON.parse(atob(required)) as { error?: string }).error ?? reason;
      } catch {}
    }
    return { kind: 'failed', status: res.status, error: reason, nonce: authorized?.nonce, authorizeTx: authorized?.txHash };
  } catch (err) {
    const e = refusal ?? findCause(err);
    if (e instanceof PolicyRefusedError) return { kind: 'refused', reason: e.reason, nonce: e.nonce, authorizeTx: e.txHash };
    return { kind: 'failed', error: (e as Error).message ?? String(e), nonce: authorized?.nonce, authorizeTx: authorized?.txHash };
  }
}

/** x402 wraps signer errors; dig out a PolicyRefusedError if there is one. */
function findCause(err: unknown): unknown {
  let e: unknown = err;
  for (let i = 0; i < 5 && e; i++) {
    if (e instanceof PolicyRefusedError) return e;
    e = (e as { cause?: unknown }).cause;
  }
  return err;
}
