/**
 * Preset attacks for the "try to make it overspend" page (specs/003-try-to-overspend). Each is
 * what an agent that obeys any instruction would try to pay. The outcome is never decided here:
 * the page dry-runs the wallet contract and shows its answer (FR-001). `expect` is only for the
 * live check (scripts/check-try.ts): what the contract should say for today's state.
 */
import type { History } from './history';

export type Payment = {
  payee: string;
  /** USDC base units (6 decimals), as a decimal string. */
  amount: string;
  /** Task id, or null for no task. */
  taskId: string | null;
  /** The ERC-8004 agentId the service claims, or null for no claim. */
  claim: string | null;
};

export type AttackId = 'normal' | 'big' | 'stranger' | 'impostor' | 'flaky' | 'task' | 'daily';
export type Attack = { id: AttackId; payments: Payment[]; expect: string[] };

/** A well-known address that no service uses: the "send it to my personal wallet" payee. */
export const STRANGER = '0x000000000000000000000000000000000000dEaD';
export const ATTACK_IDS: AttackId[] = ['normal', 'big', 'stranger', 'impostor', 'flaky', 'task', 'daily'];

/** The wallet the page attacks: the one with the reputation rule (research-bot-01). */
export function targetWallet(h: History) {
  const addr = h.reputationRule?.wallet?.toLowerCase();
  return h.wallets.find((w) => w.address.toLowerCase() === addr) ?? h.wallets[0];
}

export function attacksFor(h: History): Attack[] {
  const w = targetWallet(h);
  if (!w) return [];
  const svc = (key: string) => h.services?.find((s) => s.key === key);
  const quote = svc('quote');
  const reliable = svc('reliable');
  const flaky = svc('flaky');
  const impostor = svc('impostor');
  const quotePayee = quote?.payTo ?? w.payees.find((p) => p.allowed)?.address;
  if (!quotePayee) return [];
  const cent = '10000'; // 0.01 USDC, the demo API's price
  const cap = BigInt(w.policy.perPaymentCap);
  const daily = BigInt(w.policy.dailyBudget);
  const half = daily / 2n > 0n && daily / 2n <= cap ? daily / 2n : cap;
  // The smallest task budget that a 0.01 payment overruns.
  const tinyTask = w.tasks.find((t) => BigInt(t.budget) - BigInt(t.spent) < BigInt(cent));
  const pay = (payee: string, amount: string, claim: string | null = null, taskId: string | null = null): Payment => ({ payee, amount, taskId, claim });

  const out: Attack[] = [
    { id: 'normal', payments: [pay(quotePayee, cent, quote?.agentId ?? null)], expect: ['NONE'] },
    { id: 'big', payments: [pay(quotePayee, String(cap * 5n), quote?.agentId ?? null)], expect: ['OVER_PER_PAYMENT_CAP'] },
    {
      id: 'stranger',
      payments: [pay(STRANGER, cent)],
      expect: [h.reputationRule?.enabled ? 'PAYEE_IDENTITY_UNVERIFIED' : 'PAYEE_NOT_ALLOWED'],
    },
  ];
  if (impostor?.payTo && reliable?.agentId) {
    out.push({ id: 'impostor', payments: [pay(impostor.payTo, cent, reliable.agentId)], expect: ['PAYEE_IDENTITY_MISMATCH'] });
  }
  if (flaky?.payTo && flaky.agentId) {
    out.push({ id: 'flaky', payments: [pay(flaky.payTo, cent, flaky.agentId)], expect: [flaky.payable ? 'NONE' : (flaky.reason ?? 'PAYEE_REPUTATION_TOO_LOW')] });
  }
  if (tinyTask) out.push({ id: 'task', payments: [pay(quotePayee, cent, quote?.agentId ?? null, tinyTask.id)], expect: ['OVER_TASK_BUDGET'] });
  // Three of the same purchase: budgets add up inside one simulated block. Only the last
  // answer is certain whatever was spent today.
  out.push({ id: 'daily', payments: [0, 1, 2].map(() => pay(quotePayee, String(half), quote?.agentId ?? null)), expect: ['*', '*', 'OVER_DAILY_BUDGET'] });
  return out;
}
