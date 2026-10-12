import { describe, expect, it } from 'vitest';
import { getAddress, type Hex } from 'viem';
import { hashText, jobIdFor, type JobTerms } from '../src/escrow.js';
import {
  checkWork,
  doWork,
  nonceFor,
  runHireScenario,
  SLOT_SECONDS,
  slotOf,
  specFor,
  unhappyKind,
  type HireDeps,
  type JobRecord,
  type JobView,
} from '../src/hireScenario.js';
import { EXIT } from '../src/scenario.js';

const wallet = getAddress('0x00000000000000000000000000000000000000aa');
const worker = getAddress('0x00000000000000000000000000000000000000b0');
const arbiter = getAddress('0x00000000000000000000000000000000000000a7');
const tx = (n: number) => ('0x' + n.toString(16).padStart(64, '0')) as Hex;

/** An in-memory escrow following JobEscrow's state machine and timeout boundaries. */
function fakeEscrow(start: bigint) {
  const clock = { now: start };
  const jobs = new Map<Hex, JobView & { resultHash?: Hex }>();
  const used = new Set<Hex>();
  const none: JobView = { status: 'None', outcome: 'NONE', deliverBy: 0n, deliveredAt: 0n, disputedAt: 0n, reviewWindow: 0n, disputeWindow: 0n };
  let n = 0;
  const lines: Record<string, unknown>[] = [];
  const published: JobRecord[] = [];
  const calls: string[] = [];
  const close = (id: Hex, outcome: string) => Object.assign(jobs.get(id)!, { status: 'Closed', outcome });
  const deps: HireDeps = {
    wallet,
    worker,
    arbiter,
    now: async () => clock.now,
    readJob: async (id) => ({ ...(jobs.get(id) ?? none) }),
    nonceUsed: async (nonce) => used.has(nonce),
    async hire(nonce: Hex, t: JobTerms) {
      calls.push('hire');
      used.add(nonce);
      const jobId = jobIdFor(wallet, nonce);
      jobs.set(jobId, { ...none, status: 'Open', deliverBy: clock.now + BigInt(t.deliverIn), reviewWindow: BigInt(t.reviewWindow), disputeWindow: BigInt(t.disputeWindow) });
      return { kind: 'opened', jobId, nonce, authorizeTx: tx(++n), openTx: tx(++n) };
    },
    async deliver(id, resultHash) {
      calls.push('deliver');
      const j = jobs.get(id)!;
      if (j.status !== 'Open' || clock.now > j.deliverBy) throw new Error('cannot deliver');
      Object.assign(j, { status: 'Delivered', deliveredAt: clock.now, resultHash });
      return tx(++n);
    },
    async accept(id) {
      calls.push('accept');
      if (jobs.get(id)!.status !== 'Delivered') throw new Error('cannot accept');
      close(id, 'ACCEPTED');
      return tx(++n);
    },
    async reject(id) {
      calls.push('reject');
      const j = jobs.get(id)!;
      if (j.status !== 'Delivered' || clock.now >= j.deliveredAt + j.reviewWindow) throw new Error('cannot reject');
      Object.assign(j, { status: 'Disputed', disputedAt: clock.now });
      return tx(++n);
    },
    async claimTimeout(id) {
      calls.push('timeout');
      const j = jobs.get(id)!;
      if (j.status === 'Open' && clock.now > j.deliverBy) close(id, 'DELIVERY_TIMEOUT');
      else if (j.status === 'Delivered' && clock.now >= j.deliveredAt + j.reviewWindow) close(id, 'REVIEW_TIMEOUT');
      else if (j.status === 'Disputed' && clock.now >= j.disputedAt + j.disputeWindow) close(id, 'ARBITER_TIMEOUT');
      else throw new Error('not due');
      return tx(++n);
    },
    publish: (r) => published.push(r),
    log: (l) => lines.push(l),
  };
  return { deps, clock, jobs, lines, published, calls };
}

const evenSlotStart = (slot: number) => BigInt((slot % 2 === 0 ? slot : slot + 1) * SLOT_SECONDS);

describe('the work and its check', () => {
  const spec = specFor(81_000);
  it('the honest worker passes the check; the sloppy one is caught', () => {
    const good = doWork(spec, 'honest');
    const bad = doWork(spec, 'sloppy');
    expect(checkWork(spec, good, hashText(good))).toEqual({ ok: true });
    expect(checkWork(spec, bad, hashText(bad))).toMatchObject({ ok: false, reason: expect.stringContaining('expected') });
  });
  it('a delivery that differs from the committed hash fails', () => {
    const good = doWork(spec, 'honest');
    expect(checkWork(spec, good, hashText('something else'))).toMatchObject({ ok: false, reason: 'result does not match the committed hash' });
  });
  it('specs are deterministic per slot and differ between slots', () => {
    expect(specFor(5)).toEqual(specFor(5));
    expect(specFor(5)).not.toEqual(specFor(6));
  });
});

describe('runHireScenario', () => {
  it('even slot: honest job accepted, dispute job rejected and left for the arbiter', async () => {
    const start = evenSlotStart(81_000);
    const e = fakeEscrow(start + 60n);
    expect(unhappyKind(slotOf(start))).toBe('dispute');
    expect(await runHireScenario(e.deps)).toBe(EXIT.OK);
    expect(e.calls).toEqual(['hire', 'deliver', 'accept', 'hire', 'deliver', 'reject']);
    const slot = slotOf(start);
    const honest = jobIdFor(wallet, nonceFor(wallet, slot, 'honest'));
    const dispute = jobIdFor(wallet, nonceFor(wallet, slot, 'dispute'));
    expect(e.jobs.get(honest)!.outcome).toBe('ACCEPTED');
    expect(e.jobs.get(dispute)!.status).toBe('Disputed');
    expect(e.published.map((r) => [r.kind, r.check])).toEqual([
      ['honest', 'ok'],
      ['dispute', expect.stringContaining('expected')],
    ]);
    expect(e.lines.every((l) => l.ok !== false)).toBe(true);
  });

  it('odd slot: the no-show job stays open with nothing delivered', async () => {
    const start = evenSlotStart(81_000) + BigInt(SLOT_SECONDS);
    const e = fakeEscrow(start + 60n);
    expect(await runHireScenario(e.deps)).toBe(EXIT.OK);
    expect(e.calls).toEqual(['hire', 'deliver', 'accept', 'hire']);
    expect(e.jobs.get(jobIdFor(wallet, nonceFor(wallet, slotOf(start), 'noshow')))!.status).toBe('Open');
  });

  it('the next runs close the earlier unhappy jobs by timeout, refunding the hirer', async () => {
    const start = evenSlotStart(81_000);
    const e = fakeEscrow(start + 60n);
    await runHireScenario(e.deps); // slot s: honest + dispute
    e.clock.now += BigInt(SLOT_SECONDS);
    await runHireScenario(e.deps); // slot s+1: dispute times out; honest + noshow
    e.clock.now += BigInt(SLOT_SECONDS);
    expect(await runHireScenario(e.deps)).toBe(EXIT.OK); // slot s+2: noshow times out
    const s = slotOf(start);
    expect(e.jobs.get(jobIdFor(wallet, nonceFor(wallet, s, 'dispute')))!.outcome).toBe('ARBITER_TIMEOUT');
    expect(e.jobs.get(jobIdFor(wallet, nonceFor(wallet, s + 1, 'noshow')))!.outcome).toBe('DELIVERY_TIMEOUT');
    expect(e.lines.filter((l) => String(l.step).startsWith('timeout')).map((l) => l.actual)).toEqual(['ARBITER_TIMEOUT', 'DELIVERY_TIMEOUT']);
  });

  it('a second run in the same slot hires nothing new', async () => {
    const e = fakeEscrow(evenSlotStart(81_000) + 60n);
    await runHireScenario(e.deps);
    const before = e.calls.length;
    expect(await runHireScenario(e.deps)).toBe(EXIT.OK);
    expect(e.calls.length).toBe(before);
    expect(e.lines.filter((l) => l.skipped === 'already hired this slot')).toHaveLength(2);
  });

  it('a hire the wallet refuses is a mismatch; out of funds stops the run', async () => {
    const e = fakeEscrow(evenSlotStart(81_000) + 60n);
    e.deps.hire = async (nonce) => ({ kind: 'refused-by-wallet', reason: 'OVER_DAILY_BUDGET', nonce, authorizeTx: tx(1) });
    expect(await runHireScenario(e.deps)).toBe(EXIT.MISMATCH);
    e.deps.hire = async (nonce) => ({ kind: 'refused-by-wallet', reason: 'INSUFFICIENT_FUNDS', nonce, authorizeTx: tx(1) });
    const e2 = fakeEscrow(evenSlotStart(81_100) + 60n);
    e2.deps.hire = e.deps.hire;
    expect(await runHireScenario(e2.deps)).toBe(EXIT.INSUFFICIENT_FUNDS);
  });

  it('skips a slot whose funding nonce was used by a hire that never opened', async () => {
    const e = fakeEscrow(evenSlotStart(81_000) + 60n);
    const slot = slotOf(e.clock.now);
    const used = new Set([nonceFor(wallet, slot, 'honest')]);
    e.deps.nonceUsed = async (n) => used.has(n);
    expect(await runHireScenario(e.deps)).toBe(EXIT.OK);
    expect(e.calls).toEqual(['hire', 'deliver', 'reject']);
  });
});
