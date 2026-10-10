import { wrapFetchWithPayment, decodePaymentResponseHeader } from '@x402/fetch';
import type { Address, Hex } from 'viem';
import { createPolicyWalletClient } from './identity.js';
import { PolicyRefusedError, type AuthorizedPayment } from './signer.js';

export type PayOutcome =
  | {
      kind: 'settled';
      status: number;
      nonce: Hex;
      authorizeTx: Hex;
      settlementTx?: Hex;
      amount: bigint;
      payee: Address;
      body: unknown;
      /** Set when the wallet verified the payee's ERC-8004 identity: the payment can be rated. */
      agentId?: bigint;
    }
  | { kind: 'refused'; reason: string; nonce: Hex; authorizeTx: Hex }
  | { kind: 'failed'; status?: number; error: string; nonce?: Hex; authorizeTx?: Hex; diagnostics?: Record<string, unknown> };

/** One paid request through x402, paid from the PolicyWallet. */
export async function payUrl(
  url: string,
  opts: { wallet: Address; agentKey: Hex; taskId?: Hex; rpcUrl: string; fetchImpl?: typeof fetch },
): Promise<PayOutcome> {
  let authorized: AuthorizedPayment | undefined;
  let refusal: PolicyRefusedError | undefined;
  const { client } = createPolicyWalletClient({ ...opts, onAuthorized: (p) => (authorized = p), onRefused: (e) => (refusal = e) });
  const paying = wrapFetchWithPayment(resendOnBareSettleFailure(opts.fetchImpl ?? fetch), client);
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
        agentId: authorized.agentId,
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
    // An intermittent bare `402 {}` after a successful authorize has been seen (001 T049/T050):
    // keep what the server sent so the next one can be diagnosed.
    const diagnostics = { headers: [...res.headers.keys()], settlement, paymentRequired: required ? safeDecode(required) : undefined };
    return { kind: 'failed', status: res.status, error: reason, nonce: authorized?.nonce, authorizeTx: authorized?.txHash, diagnostics };
  } catch (err) {
    const e = refusal ?? findCause(err);
    if (e instanceof PolicyRefusedError) return { kind: 'refused', reason: e.reason, nonce: e.nonce, authorizeTx: e.txHash };
    return { kind: 'failed', error: (e as Error).message ?? String(e), nonce: authorized?.nonce, authorizeTx: authorized?.txHash };
  }
}

/**
 * The intermittent bare `402 {}` (001 T049/T050, 002 launch run): @x402/hono answers that when the
 * facilitator's settle call throws after verify passed, and nothing settles. Resend the same
 * signed payment a couple of times: its EIP-3009 nonce can settle at most once, so a resend can
 * never pay twice. Any other answer, including a 402 that says why, is returned as is.
 */
export function resendOnBareSettleFailure(inner: typeof fetch, tries = 2, delayMs = 3000): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    let res = await inner(request.clone());
    const paid = request.headers.has('PAYMENT-SIGNATURE') || request.headers.has('X-PAYMENT');
    for (let i = 0; paid && i < tries && (await isBareSettleFailure(res)); i++) {
      await new Promise((r) => setTimeout(r, delayMs));
      res = await inner(request.clone());
    }
    return res;
  };
}

async function isBareSettleFailure(res: Response): Promise<boolean> {
  if (res.status !== 402 || res.headers.has('PAYMENT-REQUIRED')) return false;
  return (await res.clone().text()).trim() === '{}';
}

function safeDecode(b64: string): unknown {
  try {
    return JSON.parse(atob(b64));
  } catch {
    return b64.slice(0, 200);
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
