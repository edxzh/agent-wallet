import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, getAddress, keccak256, toHex, type Hex, type Log } from 'viem';
import { jobEscrowAbi } from '../packages/agent/src/abi.js';
import { mergeJobs, withPublished } from './lib/jobs.js';

const escrow = getAddress('0xf12b4e917c64ca692f6af8c635409740e66ff721');
const client = getAddress('0xc788272fe9c76810ef1ba2539b56822405edb0fc');
const worker = getAddress('0x6d964d762c6610dcb9f5ed380591d5e8b3b15bce');
const arbiter = getAddress('0xc6e78b511c87688bc33c9db7539e5e0334b2ad59');
const job = ('0x' + 'aa'.repeat(32)) as Hex;
const nonce = ('0x' + '11'.repeat(32)) as Hex;
const spec = '{"task":"average","unit":"USDC","values":["1.00","2.00","3.00"]}';
const result = '{"average":"2.00"}';
let seq = 0;
const tx = () => ('0x' + (++seq).toString(16).padStart(64, '0')) as Hex;

function log(eventName: string, args: Record<string, unknown>, types: string[], values: unknown[], block: number, logIndex = 0): Log {
  return {
    address: escrow,
    topics: encodeEventTopics({ abi: jobEscrowAbi, eventName, args } as never) as never,
    data: encodeAbiParameters(types.map((type) => ({ type })), values),
    blockNumber: BigInt(block),
    logIndex,
    transactionHash: tx(),
  } as unknown as Log;
}

const opened = (block: number, id = job) =>
  log('JobOpened', { jobId: id, client, worker }, ['address', 'bytes32', 'uint256', 'uint64', 'uint32', 'uint32', 'bytes32', 'uint256'], [arbiter, nonce, 10000n, 1_800_003_600n, 3600, 3600, keccak256(toHex(spec)), 0n], block);
const delivered = (block: number, hash = keccak256(toHex(result))) => log('JobDelivered', { jobId: job }, ['bytes32'], [hash], block);
const disputed = (block: number) => log('JobDisputed', { jobId: job }, ['bytes32'], [keccak256(toHex('wrong'))], block);
const closed = (block: number, outcome: number, to: string, logIndex = 0) => log('JobClosed', { jobId: job, to }, ['uint8', 'uint256'], [outcome, 10000n], block, logIndex);
const times = new Map([100, 101, 102, 103, 200].map((b) => [b, `2026-10-12T00:00:${String(b % 60).padStart(2, '0')}.000Z`]));

describe('mergeJobs', () => {
  it('follows a job from opened to accepted', () => {
    const [j] = mergeJobs([], [opened(100), delivered(101), closed(102, 1, worker)], times);
    expect(j).toMatchObject({ jobId: job, client, worker, amount: '10000', status: 'closed' });
    expect(j!.opened).toMatchObject({ block: 100, deliverBy: 1_800_003_600, reviewWindow: 3600, specHash: keccak256(toHex(spec)) });
    expect(j!.closed).toMatchObject({ outcome: 'ACCEPTED', to: worker, deferred: false, block: 102 });
  });

  it('continues a job across snapshots (disputed in one, timed out in the next)', () => {
    const first = mergeJobs([], [opened(100), delivered(101), disputed(102)], times);
    expect(first[0]!.status).toBe('disputed');
    const next = mergeJobs(first, [closed(200, 6, client)], times);
    expect(next[0]!.status).toBe('closed');
    expect(next[0]!.closed!.outcome).toBe('ARBITER_TIMEOUT');
    expect(next[0]!.disputed!.block).toBe(102);
    expect(first[0]!.status).toBe('disputed'); // the previous history isn't mutated
  });

  it('marks a payout the token refused as deferred', () => {
    const deferred = log('PaymentDeferred', { jobId: job, to: worker }, ['uint256'], [10000n], 102, 1);
    const [j] = mergeJobs([], [opened(100), delivered(101), closed(102, 1, worker, 0), deferred], times);
    expect(j!.closed!.deferred).toBe(true);
  });

  it('records a refused hire with the wallet reason', () => {
    const refused = log('JobRefused', { jobId: job, client, worker }, ['bytes32', 'uint8'], [nonce, 3], 100);
    const [j] = mergeJobs([], [refused], times);
    expect(j).toMatchObject({ status: 'refused', refused: { reason: 'PAYEE_NOT_ALLOWED' } });
  });

  it('newest first, capped', () => {
    const ids = Array.from({ length: 5 }, (_, i) => ('0x' + (i + 1).toString(16).padStart(64, '0')) as Hex);
    const jobs = mergeJobs([], ids.map((id, i) => opened(100 + i, id)), times, 3);
    expect(jobs.map((j) => j.opened!.block)).toEqual([104, 103, 102]);
  });
});

describe('withPublished', () => {
  it('adds the texts and checks them against the on-chain hashes', () => {
    const jobs = mergeJobs([], [opened(100), delivered(101)], times);
    const [j] = withPublished(jobs, [{ jobId: job, kind: 'honest', spec, result, check: 'ok' }]);
    expect(j).toMatchObject({ kind: 'honest', spec, result, check: 'ok', specMatches: true, resultMatches: true });
  });

  it('flags a published result that does not match what the worker committed', () => {
    const jobs = mergeJobs([], [opened(100), delivered(101, keccak256(toHex('something else')))], times);
    expect(withPublished(jobs, [{ jobId: job, kind: 'honest', spec, result }])[0]!.resultMatches).toBe(false);
  });
});
