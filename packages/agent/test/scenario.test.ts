import { describe, expect, it, vi } from 'vitest';
import { getAddress, zeroHash, type Hex } from 'viem';
import { EXIT, planFor, runScenario, type ScenarioDeps } from '../src/scenario.js';
import { expectedOutcome, type WalletState } from '../src/state.js';

const payee = getAddress('0x00000000000000000000000000000000000000bb');
const stranger = getAddress('0x00000000000000000000000000000000000000cc');
const marketTask = ('0x' + '01'.repeat(32)) as Hex;
const probeTask = ('0x' + '02'.repeat(32)) as Hex;
const h = (n: number) => ('0x' + n.toString(16).padStart(64, '0')) as Hex;

/** A tiny in-memory wallet that follows the contract's rules. */
function fakeWallet(overrides: Partial<WalletState> = {}) {
  const s: WalletState = {
    paused: false,
    perPaymentCap: 1_000_000n,
    dailyBudget: 1_000_000n,
    spentToday: 0n,
    day: 1n,
    balance: 9_000_000n,
    tasks: { [marketTask]: { budget: 10_000_000n, spent: 0n }, [probeTask]: { budget: 5_000n, spent: 0n } },
    payees: { [payee]: true },
    now: 1_000n,
    ...overrides,
  };
  let n = 0;
  const attempt = (a: { payee: `0x${string}`; amount: bigint; taskId: Hex; validBefore: bigint }) => {
    const reason = expectedOutcome(s, a);
    if (reason === 'NONE') {
      s.spentToday += a.amount;
      s.balance -= a.amount;
      if (a.taskId !== zeroHash) s.tasks[a.taskId]!.spent += a.amount;
    }
    return { reason, nonce: h(++n), txHash: h(1000 + n) };
  };
  return { s, attempt };
}

function deps(w: ReturnType<typeof fakeWallet>, over: Partial<ScenarioDeps> = {}): ScenarioDeps & { lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  return {
    lines,
    readState: async () => structuredClone(w.s),
    pay: vi.fn(async () => {
      const r = w.attempt({ payee, amount: 10_000n, taskId: marketTask, validBefore: w.s.now + 300n });
      return r.reason === 'NONE'
        ? { kind: 'settled' as const, status: 200, nonce: r.nonce, authorizeTx: r.txHash, amount: 10_000n, payee, body: {} }
        : { kind: 'refused' as const, reason: r.reason, nonce: r.nonce, authorizeTx: r.txHash };
    }),
    probe: vi.fn(async (a) => {
      const r = w.attempt(a);
      return { kind: r.reason === 'NONE' ? ('authorized' as const) : ('refused' as const), reason: r.reason, nonce: r.nonce, txHash: r.txHash };
    }),
    servicePayee: payee,
    quoteAmount: 10_000n,
    marketTask,
    probeTask,
    strangerAddress: stranger,
    log: (l) => lines.push(l),
    ...over,
  };
}

describe('run-scenario', () => {
  it('plans three distinct pairs per seed, deterministically', () => {
    expect(planFor(4)).toEqual(planFor(4));
    expect(new Set(planFor(4)).size).toBe(3);
  });

  it('makes 3 payments, then 4 probes that are each refused with the intended reason; exit 0', async () => {
    const d = deps(fakeWallet());
    expect(await runScenario(d, 1)).toBe(EXIT.OK);
    expect(d.pay).toHaveBeenCalledTimes(3);
    const results = d.lines.filter((l) => 'actual' in l).map((l) => [l.step, l.actual]);
    expect(results.slice(3)).toEqual([
      ['probe over cap', 'OVER_PER_PAYMENT_CAP'],
      ['probe unlisted payee', 'PAYEE_NOT_ALLOWED'],
      ['probe over task budget', 'OVER_TASK_BUDGET'],
      ['probe over daily budget', 'OVER_DAILY_BUDGET'],
    ]);
    expect(d.lines.every((l) => l.ok !== false)).toBe(true);
  });

  it('exits 2 when an outcome differs from the expectation', async () => {
    const w = fakeWallet();
    const d = deps(w, {
      probe: async () => ({ kind: 'refused', reason: 'PAUSED', nonce: h(1), txHash: h(2) }),
    });
    expect(await runScenario(d, 1)).toBe(EXIT.MISMATCH);
  });

  it('stops cleanly with exit 3 when the wallet runs out of funds', async () => {
    const d = deps(fakeWallet({ balance: 5_000n }));
    expect(await runScenario(d, 1)).toBe(EXIT.INSUFFICIENT_FUNDS);
    expect(d.probe).not.toHaveBeenCalled();
  });
});
