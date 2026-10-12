/**
 * Pure helpers for the dashboard's jobs section (specs/004-agent-hires-agent, T012): decode the
 * escrow's logs into job histories, merge them into history.json, and join each job with the spec
 * and result texts the scheduled run published (jobs.json), checking the result text against the
 * hash on-chain. No I/O here, so it is unit-tested.
 */
import { decodeEventLog, getAddress, keccak256, toHex, type Address, type Hex, type Log } from 'viem';
import { jobEscrowAbi } from '../../packages/agent/src/abi.js';
import { outcomeName } from '../../packages/agent/src/escrow.js';
import { reasonName } from '../../packages/agent/src/reasons.js';

export type Step = { time: string; block: number; txHash: Hex };
export type JobHistory = {
  jobId: Hex;
  client: Address;
  worker: Address;
  amount: string;
  status: 'open' | 'delivered' | 'disputed' | 'closed' | 'refused';
  opened?: Step & { deliverBy: number; reviewWindow: number; disputeWindow: number; specHash: Hex };
  /** The hirer's wallet wouldn't pay this worker: no money moved. */
  refused?: Step & { reason: string };
  delivered?: Step & { resultHash: Hex };
  disputed?: Step & { reasonHash: Hex };
  closed?: Step & { outcome: string; to: Address; deferred: boolean };
  /** From jobs.json, when the scheduled run published them. */
  kind?: string;
  spec?: string;
  result?: string;
  check?: string;
  /** keccak256(spec) and keccak256(result) equal the hashes on-chain. */
  specMatches?: boolean;
  resultMatches?: boolean;
};
export type PublishedJob = { jobId: Hex; kind: string; spec: string; result?: string; check?: string };

export const MAX_JOBS = 30;

type Decoded = { name: string; args: Record<string, unknown>; step: Step; logIndex: number };

function decode(logs: Log[], times: Map<number, string>): Decoded[] {
  const out: Decoded[] = [];
  for (const log of logs) {
    try {
      const ev = decodeEventLog({ abi: jobEscrowAbi, data: log.data, topics: log.topics });
      const block = Number(log.blockNumber);
      out.push({ name: ev.eventName, args: ev.args as Record<string, unknown>, logIndex: Number(log.logIndex), step: { time: times.get(block) ?? '', block, txHash: log.transactionHash! } });
    } catch {}
  }
  return out.sort((a, b) => a.step.block - b.step.block || a.logIndex - b.logIndex);
}

/** Applies the escrow's logs (in order) to the jobs already known, newest first, capped. */
export function mergeJobs(previous: JobHistory[], logs: Log[], times: Map<number, string>, cap = MAX_JOBS): JobHistory[] {
  const jobs = new Map<Hex, JobHistory>(previous.map((j) => [j.jobId, structuredClone(j)]));
  for (const e of decode(logs, times)) {
    const id = e.args.jobId as Hex;
    const j = jobs.get(id);
    switch (e.name) {
      case 'JobOpened':
        jobs.set(id, {
          ...(j ?? {}),
          jobId: id,
          client: getAddress(e.args.client as string),
          worker: getAddress(e.args.worker as string),
          amount: String(e.args.amount),
          status: 'open',
          opened: {
            ...e.step,
            deliverBy: Number(e.args.deliverBy),
            reviewWindow: Number(e.args.reviewWindow),
            disputeWindow: Number(e.args.disputeWindow),
            specHash: e.args.specHash as Hex,
          },
        });
        break;
      case 'JobRefused':
        if (!j) {
          jobs.set(id, {
            jobId: id,
            client: getAddress(e.args.client as string),
            worker: getAddress(e.args.worker as string),
            amount: '0',
            status: 'refused',
            refused: { ...e.step, reason: reasonName(Number(e.args.reason)) },
          });
        }
        break;
      case 'JobDelivered':
        if (j) Object.assign(j, { status: 'delivered', delivered: { ...e.step, resultHash: e.args.resultHash as Hex } });
        break;
      case 'JobDisputed':
        if (j) Object.assign(j, { status: 'disputed', disputed: { ...e.step, reasonHash: e.args.reasonHash as Hex } });
        break;
      case 'JobClosed':
        if (j) Object.assign(j, { status: 'closed', closed: { ...e.step, outcome: outcomeName(Number(e.args.outcome)), to: getAddress(e.args.to as string), deferred: false } });
        break;
      case 'PaymentDeferred':
        if (j?.closed) j.closed.deferred = true;
        break;
    }
  }
  const first = (j: JobHistory) => j.opened ?? j.refused;
  return [...jobs.values()].sort((a, b) => (first(b)?.block ?? 0) - (first(a)?.block ?? 0)).slice(0, cap);
}

/** Adds the published spec and result texts, and whether they hash to what is on-chain. */
export function withPublished(jobs: JobHistory[], published: PublishedJob[]): JobHistory[] {
  const byId = new Map(published.map((p) => [p.jobId.toLowerCase(), p]));
  const hash = (s: string) => keccak256(toHex(s));
  return jobs.map((j) => {
    const p = byId.get(j.jobId.toLowerCase());
    if (!p) return j;
    return {
      ...j,
      kind: p.kind,
      spec: p.spec,
      result: p.result,
      check: p.check,
      specMatches: j.opened ? hash(p.spec) === j.opened.specHash : undefined,
      resultMatches: p.result !== undefined && j.delivered ? hash(p.result) === j.delivered.resultHash : undefined,
    };
  });
}
