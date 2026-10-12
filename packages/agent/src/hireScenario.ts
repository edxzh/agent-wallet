/**
 * The scheduled hire scenario (specs/004-agent-hires-agent, T011). Each run, research-bot-01 hires
 * worker-bot-01 for a small, checkable task (average some prices):
 *
 * - `honest`: the worker delivers the right answer; the hirer checks it and accepts (ACCEPTED);
 * - every other run, `dispute`: the worker delivers a wrong answer; the hirer's check catches it
 *   and rejects. Only the operator can settle a dispute, and its key never runs in CI, so unless
 *   the owner settles it by hand, a later run refunds the hirer (ARBITER_TIMEOUT);
 * - the other runs, `noshow`: the worker never delivers; a later run refunds the hirer
 *   (DELIVERY_TIMEOUT).
 *
 * Jobs are named by the 6-hour slot and kind (the funding nonce is derived from them), so a run
 * needs no state file: rerunning a slot skips jobs that already exist, and later runs find earlier
 * slots' jobs to close their timeouts. Every outcome is compared with what should have happened.
 */
import { keccak256, toHex, type Address, type Hex } from 'viem';
import { hashText, jobIdFor, outcomeName, type HireOutcome, type JobTerms } from './escrow.js';
import { EXIT } from './scenario.js';

export const SLOT_SECONDS = 6 * 3600;
export const JOB_PRICE = 10_000n; // 0.01 USDC
/** How many past slots to look back for jobs whose timeout is due (2 days of 6-hour runs). */
export const LOOKBACK_SLOTS = 8;
export type JobKind = 'honest' | 'dispute' | 'noshow';
export const KINDS: JobKind[] = ['honest', 'dispute', 'noshow'];

/** IJobEscrow.Status */
export const STATUS = ['None', 'Open', 'Delivered', 'Disputed', 'Closed'] as const;
export type JobView = {
  status: (typeof STATUS)[number];
  outcome: string;
  deliverBy: bigint;
  deliveredAt: bigint;
  disputedAt: bigint;
  reviewWindow: bigint;
  disputeWindow: bigint;
};

export type Spec = { task: 'average'; unit: 'USDC'; values: string[] };
/** A published job record: the texts behind the on-chain spec and result hashes. */
export type JobRecord = { jobId: Hex; slot: number; kind: JobKind; spec: string; specHash: Hex; result?: string; resultHash?: Hex; check?: string };

export type HireDeps = {
  wallet: Address;
  worker: Address;
  arbiter: Address;
  now(): Promise<bigint>;
  readJob(jobId: Hex): Promise<JobView>;
  /** Whether the hiring wallet already used this funding nonce (a hire that didn't open). */
  nonceUsed(nonce: Hex): Promise<boolean>;
  hire(nonce: Hex, terms: JobTerms): Promise<HireOutcome>;
  deliver(jobId: Hex, resultHash: Hex): Promise<Hex>;
  accept(jobId: Hex): Promise<Hex>;
  reject(jobId: Hex, reasonHash: Hex): Promise<Hex>;
  claimTimeout(jobId: Hex): Promise<Hex>;
  publish(record: JobRecord): void;
  log(line: Record<string, unknown>): void;
};

export const slotOf = (now: bigint) => Number(now / BigInt(SLOT_SECONDS));
export const nonceFor = (wallet: Address, slot: number, kind: JobKind): Hex => keccak256(toHex(`aw-hire:v1:${wallet.toLowerCase()}:${slot}:${kind}`));
/** The unhappy job of a slot alternates, so both kinds show up every day. */
export const unhappyKind = (slot: number): JobKind => (slot % 2 === 0 ? 'dispute' : 'noshow');

/** The task for a slot: three illustrative prices, the same for anyone who recomputes it. */
export function specFor(slot: number): Spec {
  const v = (i: number) => (1000 + ((slot * 7919 + i * 104729) % 9000) / 100).toFixed(2);
  return { task: 'average', unit: 'USDC', values: [v(1), v(2), v(3)] };
}

const cents = (s: string) => BigInt(s.replace('.', ''));
const fromCents = (c: bigint) => `${c / 100n}.${(c % 100n).toString().padStart(2, '0')}`;

/** The worker. `sloppy` has a plausible bug: it averages only the first two values. */
export function doWork(spec: Spec, mode: 'honest' | 'sloppy'): string {
  const vals = mode === 'honest' ? spec.values : spec.values.slice(0, 2);
  const sum = vals.reduce((a, s) => a + cents(s), 0n);
  return JSON.stringify({ average: fromCents(sum / BigInt(vals.length)) });
}

/** The hirer's check: the delivery matches the hash the worker committed, and the answer is right. */
export function checkWork(spec: Spec, result: string, committed: Hex): { ok: true } | { ok: false; reason: string } {
  if (hashText(result) !== committed) return { ok: false, reason: 'result does not match the committed hash' };
  let got: unknown;
  try {
    got = (JSON.parse(result) as { average?: unknown }).average;
  } catch {
    return { ok: false, reason: 'result is not JSON' };
  }
  const want = (JSON.parse(doWork(spec, 'honest')) as { average: string }).average;
  return got === want ? { ok: true } : { ok: false, reason: `average is ${String(got)}, expected ${want}` };
}

const TERMS = { deliverIn: 3600, reviewWindow: 3600, disputeWindow: 3600 } as const;

export async function runHireScenario(d: HireDeps): Promise<number> {
  let mismatches = 0;
  const check = (step: string, expected: string, actual: string, extra: Record<string, unknown> = {}) => {
    const ok = expected === actual;
    if (!ok) mismatches++;
    d.log({ step, expected, actual, ok, ...extra });
  };
  const now = await d.now();
  const slot = slotOf(now);

  // 1. Close earlier slots' jobs whose deadline has passed (anyone may; the hirer pays the gas).
  for (let s = slot - 1; s >= slot - LOOKBACK_SLOTS; s--) {
    for (const kind of KINDS) {
      const jobId = jobIdFor(d.wallet, nonceFor(d.wallet, s, kind));
      const j = await d.readJob(jobId);
      const due =
        (j.status === 'Open' && now > j.deliverBy) ||
        (j.status === 'Delivered' && now >= j.deliveredAt + j.reviewWindow) ||
        (j.status === 'Disputed' && now >= j.disputedAt + j.disputeWindow);
      if (!due) continue;
      const expected = j.status === 'Open' ? 'DELIVERY_TIMEOUT' : j.status === 'Delivered' ? 'REVIEW_TIMEOUT' : 'ARBITER_TIMEOUT';
      const tx = await d.claimTimeout(jobId);
      check(`timeout ${kind} (slot ${s})`, expected, (await d.readJob(jobId)).outcome, { jobId, tx });
    }
  }

  // 2. This slot's jobs: one honest, one unhappy.
  for (const kind of ['honest', unhappyKind(slot)] as JobKind[]) {
    const nonce = nonceFor(d.wallet, slot, kind);
    const jobId = jobIdFor(d.wallet, nonce);
    if ((await d.readJob(jobId)).status !== 'None') {
      d.log({ step: `hire ${kind}`, skipped: 'already hired this slot', jobId });
      continue;
    }
    if (await d.nonceUsed(nonce)) {
      d.log({ step: `hire ${kind}`, skipped: 'funding nonce already used this slot (an earlier hire did not open)', nonce });
      continue;
    }
    const spec = specFor(slot);
    const specText = JSON.stringify(spec);
    const record: JobRecord = { jobId, slot, kind, spec: specText, specHash: hashText(specText) };
    const hired = await d.hire(nonce, { worker: d.worker, arbiter: d.arbiter, amount: JOB_PRICE, spec: specText, ...TERMS });
    if (hired.kind !== 'opened') {
      check(`hire ${kind}`, 'OPENED', hired.kind === 'worker-not-payable' ? `WORKER_${hired.reason}` : hired.reason, { ...hired });
      if (hired.kind === 'refused-by-wallet' && hired.reason === 'INSUFFICIENT_FUNDS') return EXIT.INSUFFICIENT_FUNDS;
      continue;
    }
    d.log({ step: `hire ${kind}`, ok: true, jobId, openTx: hired.openTx });
    if (kind === 'noshow') {
      d.publish(record);
      check('noshow: worker stays silent', 'Open', (await d.readJob(jobId)).status, { jobId });
      continue;
    }

    // The worker does the work, commits its hash on-chain, and hands the text over.
    const result = doWork(spec, kind === 'honest' ? 'honest' : 'sloppy');
    const resultHash = hashText(result);
    const deliverTx = await d.deliver(jobId, resultHash);
    d.log({ step: `deliver ${kind}`, jobId, resultHash, tx: deliverTx });

    // The hirer checks it against the spec and the committed hash.
    const verdict = checkWork(spec, result, resultHash);
    Object.assign(record, { result, resultHash, check: verdict.ok ? 'ok' : verdict.reason });
    d.publish(record);
    if (verdict.ok) {
      const tx = await d.accept(jobId);
      check(`accept ${kind}`, kind === 'honest' ? 'ACCEPTED' : 'REJECTED', (await d.readJob(jobId)).outcome, { jobId, tx });
    } else {
      const tx = await d.reject(jobId, hashText(verdict.reason));
      check(`reject ${kind}`, kind === 'dispute' ? 'Disputed' : 'ACCEPTED', (await d.readJob(jobId)).status, { jobId, reason: verdict.reason, tx });
    }
  }
  return mismatches ? EXIT.MISMATCH : EXIT.OK;
}

/** Decodes the escrow's `job(id)` tuple into a JobView. */
export function toJobView(j: { status: number; outcome: number; deliverBy: bigint; deliveredAt: bigint; disputedAt: bigint; reviewWindow: number; disputeWindow: number }): JobView {
  return {
    status: STATUS[j.status] ?? 'None',
    outcome: outcomeName(j.outcome),
    deliverBy: j.deliverBy,
    deliveredAt: j.deliveredAt,
    disputedAt: j.disputedAt,
    reviewWindow: BigInt(j.reviewWindow),
    disputeWindow: BigInt(j.disputeWindow),
  };
}
