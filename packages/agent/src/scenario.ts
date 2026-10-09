import { zeroHash, type Address, type Hex } from 'viem';
import { formatUsdc } from './chain.js';
import type { PayOutcome } from './pay.js';
import { expectedOutcome, type WalletState } from './state.js';
import type { Reason } from './reasons.js';

export type ProbeOutcome = { kind: 'authorized' | 'refused'; reason: Reason | string; nonce: Hex; txHash: Hex };

export type ScenarioDeps = {
  readState(): Promise<WalletState>;
  /** One x402 payment to the demo API (always `quoteAmount` to `servicePayee`, under `marketTask`). */
  pay(pair: string): Promise<PayOutcome>;
  /** A direct authorize() attempt, never signed or settled. */
  probe(a: { payee: Address; amount: bigint; taskId: Hex; validBefore: bigint }): Promise<ProbeOutcome>;
  servicePayee: Address;
  quoteAmount: bigint;
  marketTask: Hex;
  /** A task with a deliberately tiny budget, for the over-task probe. */
  probeTask: Hex;
  /** An address that is not on the allowlist. */
  strangerAddress: Address;
  log(line: Record<string, unknown>): void;
};

export const EXIT = { OK: 0, CONFIG: 1, MISMATCH: 2, INSUFFICIENT_FUNDS: 3, REGISTRY_CHANGED: 4 } as const;
const PAIRS = ['ETH-USDC', 'BTC-USDC', 'SOL-USDC', 'ARB-USDC', 'OP-USDC', 'LINK-USDC'];

/** Deterministic plan for a seed: which three pairs to buy, in which order. */
export function planFor(seed: number): string[] {
  const out: string[] = [];
  for (let i = 0; out.length < 3; i++) {
    const pair = PAIRS[(seed * 7 + i * 5) % PAIRS.length]!;
    if (!out.includes(pair)) out.push(pair);
  }
  return out;
}

/**
 * The scripted agent (FR-019, US5): ~3 allowed payments, then deliberate violations (over cap,
 * unlisted payee, over task budget, over daily budget). Every step's expected outcome is computed
 * from on-chain state just before it, and compared with what actually happened.
 */
export async function runScenario(deps: ScenarioDeps, seed: number): Promise<number> {
  let mismatches = 0;
  const check = (step: string, expected: Reason, actual: string, extra: Record<string, unknown>) => {
    const ok = expected === actual;
    if (!ok) mismatches++;
    deps.log({ step, expected, actual, ok, ...extra });
  };

  // 1. Allowed payments through x402.
  for (const pair of planFor(seed)) {
    const s = await deps.readState();
    const expected = expectedOutcome(s, {
      payee: deps.servicePayee,
      amount: deps.quoteAmount,
      validBefore: s.now + 300n,
      taskId: deps.marketTask,
    });
    const out = await deps.pay(pair);
    const actual = out.kind === 'settled' ? 'NONE' : out.kind === 'refused' ? out.reason : `FAILED: ${out.error}`;
    check(`pay ${pair}`, expected, actual, out.kind === 'settled' ? { nonce: out.nonce, settlementTx: out.settlementTx } : { ...out });
    if (actual === 'INSUFFICIENT_FUNDS') {
      deps.log({ step: 'stop', reason: 'insufficient funds: top up the wallet' });
      return EXIT.INSUFFICIENT_FUNDS;
    }
  }

  // 2. Deliberate violations, each a real on-chain attempt that should be refused.
  const probes: { step: string; intended: Reason; attempt: (s: WalletState) => { payee: Address; amount: bigint; taskId: Hex } }[] = [
    { step: 'probe over cap', intended: 'OVER_PER_PAYMENT_CAP', attempt: (s) => ({ payee: deps.servicePayee, amount: s.perPaymentCap + s.perPaymentCap / 2n, taskId: zeroHash }) },
    { step: 'probe unlisted payee', intended: 'PAYEE_NOT_ALLOWED', attempt: () => ({ payee: deps.strangerAddress, amount: deps.quoteAmount, taskId: zeroHash }) },
    { step: 'probe over task budget', intended: 'OVER_TASK_BUDGET', attempt: () => ({ payee: deps.servicePayee, amount: deps.quoteAmount, taskId: deps.probeTask }) },
    {
      step: 'probe over daily budget',
      intended: 'OVER_DAILY_BUDGET',
      attempt: (s) => ({ payee: deps.servicePayee, amount: s.dailyBudget - s.spentToday + deps.quoteAmount, taskId: zeroHash }),
    },
  ];
  for (const p of probes) {
    const s = await deps.readState();
    const a = { ...p.attempt(s), validBefore: s.now + 60n };
    const expected = expectedOutcome(s, a);
    if (expected !== p.intended) deps.log({ step: p.step, note: `state makes this probe give ${expected}, not ${p.intended}` });
    const out = await deps.probe(a);
    check(p.step, expected, out.kind === 'authorized' ? 'NONE' : out.reason, { amount: formatUsdc(a.amount), nonce: out.nonce, tx: out.txHash });
  }

  deps.log({ step: 'done', mismatches });
  return mismatches === 0 ? EXIT.OK : EXIT.MISMATCH;
}
