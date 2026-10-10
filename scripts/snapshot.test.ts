import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, getAddress, pad, stringToHex, zeroHash, type Hex, type Log } from 'viem';
import { policyWalletAbi } from '../packages/agent/src/abi.js';
import { blockRanges } from '../packages/agent/src/chain.js';
import { usdcAbi } from '../packages/agent/src/chain.js';
import { decodeWalletLogs, mergeEvents, settlementsFrom, type Entry } from './lib/history.js';

const wallet = getAddress('0x7b146350cc960a45036c9db1dcd45be7693eebf0');
const payee = getAddress('0xd0cf5c6da15473264a5839f9ad24c014d9f1e1b6');
const n1 = ('0x' + '01'.repeat(32)) as Hex;
const n2 = ('0x' + '02'.repeat(32)) as Hex;
let seq = 0;
const tx = () => ('0x' + (++seq).toString(16).padStart(64, '0')) as Hex;

function log(eventName: string, args: Record<string, unknown>, data: Hex, block: number, abi: readonly unknown[] = policyWalletAbi): Log {
  return {
    address: wallet,
    topics: encodeEventTopics({ abi, eventName, args } as never) as never,
    data,
    blockNumber: BigInt(block),
    logIndex: 0,
    transactionHash: tx(),
  } as unknown as Log;
}

const authorized = (nonce: Hex, block: number) =>
  log('PaymentAuthorized', { nonce, payee, taskId: zeroHash }, encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }], [10000n, 99n, zeroHash]), block);
const refused = (nonce: Hex, reason: number, block: number) =>
  log('PaymentRefused', { nonce, payee, taskId: zeroHash }, encodeAbiParameters([{ type: 'uint256' }, { type: 'uint8' }], [1500000n, reason]), block);
const ruleChanged = (block: number) =>
  log('RuleChanged', { field: pad(stringToHex('perPaymentCap'), { dir: 'right' }), key: zeroHash }, encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [1000000n, 5000n]), block);
const used = (nonce: Hex, block: number) => log('AuthorizationUsed', { authorizer: wallet, nonce }, '0x', block, usdcAbi);

describe('snapshot decoding', () => {
  it('decodes every event kind into record entries', () => {
    const times = new Map([[10, '2026-10-08T00:00:00.000Z']]);
    const entries = decodeWalletLogs(
      [
        authorized(n1, 10),
        refused(n2, 4, 10),
        ruleChanged(10),
        log('PaymentExpired', { nonce: n1 }, encodeAbiParameters([{ type: 'uint256' }], [10000n]), 10),
        log('Paused', {}, '0x', 10),
        log('Unpaused', {}, '0x', 10),
      ],
      times,
    );
    expect(entries.map((e) => e.kind)).toEqual(['authorized', 'refused', 'ruleChange', 'expired', 'paused', 'unpaused']);
    expect(entries[1]).toMatchObject({ reason: 'OVER_PER_PAYMENT_CAP', amount: '1500000', payee });
    expect(entries[2]).toMatchObject({ ruleField: 'perPaymentCap', oldValue: '1000000', newValue: '5000' });
    expect(entries[0]!.time).toBe('2026-10-08T00:00:00.000Z');
  });

  it('joins USDC AuthorizationUsed to PaymentAuthorized by nonce to mark settled', () => {
    const fresh = decodeWalletLogs([authorized(n1, 10), authorized(n2, 11)], new Map());
    const settlement = used(n1, 12);
    const merged = mergeEvents([], fresh, settlementsFrom([settlement]));
    const byNonce = Object.fromEntries(merged.map((e) => [e.nonce, e]));
    expect(byNonce[n1]).toMatchObject({ settled: true, settledTx: settlement.transactionHash });
    expect(byNonce[n2]).toMatchObject({ settled: false });
  });

  it('marks an older authorization settled when the settlement arrives in a later snapshot', () => {
    const first = mergeEvents([], decodeWalletLogs([authorized(n1, 10)], new Map()), new Map());
    const second = mergeEvents(first, [], settlementsFrom([used(n1, 20)]));
    expect(second[0]).toMatchObject({ nonce: n1, settled: true });
  });

  it('dedupes, orders newest first and caps', () => {
    const a = decodeWalletLogs([authorized(n1, 10)], new Map());
    const b = decodeWalletLogs([refused(n2, 3, 30), ruleChanged(20)], new Map());
    const merged = mergeEvents(a, [...b, ...a], new Map());
    expect(merged.map((e: Entry) => e.block)).toEqual([30, 20, 10]);
    expect(mergeEvents(a, b, new Map(), 2)).toHaveLength(2);
  });
});

describe('log fetching ranges', () => {
  it('never asks for more than 200 blocks per eth_getLogs and covers the range exactly', () => {
    const ranges = blockRanges(1000n, 2234n);
    expect(ranges[0]).toEqual([1000n, 1199n]);
    expect(ranges.at(-1)).toEqual([2200n, 2234n]);
    for (const [from, to] of ranges) expect(to - from + 1n).toBeLessThanOrEqual(200n);
    expect(blockRanges(5n, 5n)).toEqual([[5n, 5n]]);
  });

  it('resumes from lastBlock + 1 (no overlap with the previous snapshot)', () => {
    const lastBlock = 47828879n;
    expect(blockRanges(lastBlock + 1n, lastBlock + 600n)[0]![0]).toBe(lastBlock + 1n);
  });
});

// ── 002: trusted payees (T030) ────────────────────────────────────────────────────────────
import { appendSnapshot, decodeAgentURI, MAX_SNAPSHOTS, sinceOf, statusChange, type ServiceSnapshot } from './lib/trust.js';

const rated = (nonce: Hex, block: number) =>
  log('PaymentRated', { nonce, agentId: 9614n }, encodeAbiParameters([{ type: 'uint8' }, { type: 'string' }, { type: 'uint64' }], [90, 'accurate', 3n]), block);
const snap = (block: number, payable: boolean, reason?: string): ServiceSnapshot => ({
  time: new Date(1_791_000_000_000 + block * 1000).toISOString(),
  block,
  count: 3,
  average: '90',
  decimals: 0,
  payable,
  reason,
});

describe('trusted payees in the snapshot', () => {
  it('decodes PaymentRated into a rated row with the registry index', () => {
    const [e] = decodeWalletLogs([rated(n1, 10)], new Map([[10, '2026-10-10T06:17:00.000Z']]));
    expect(e).toMatchObject({ kind: 'rated', nonce: n1, agentId: '9614', score: 90, tag: 'accurate', feedbackIndex: '3', block: 10 });
  });

  it('reads name and description from an on-chain registration file, and tolerates anything else', () => {
    const file = { name: 'Yunshu demo · Reliable quotes', description: 'Demo', endpoints: [] };
    expect(decodeAgentURI(`data:application/json;base64,${Buffer.from(JSON.stringify(file)).toString('base64')}`)).toEqual({ name: file.name, description: 'Demo' });
    expect(decodeAgentURI('https://example.com/agent.json')).toEqual({});
    expect(decodeAgentURI('data:application/json;base64,!!!')).toEqual({});
    expect(decodeAgentURI(undefined)).toEqual({});
  });

  it('keeps one snapshot per block, oldest first, capped at 400', () => {
    let s: ServiceSnapshot[] = [];
    for (let b = 1; b <= MAX_SNAPSHOTS + 5; b++) s = appendSnapshot(s, snap(b, true));
    s = appendSnapshot(s, snap(MAX_SNAPSHOTS + 5, false)); // same block again replaces, never duplicates
    expect(s).toHaveLength(MAX_SNAPSHOTS);
    expect(s[0]!.block).toBe(6);
    expect(s.at(-1)).toMatchObject({ block: MAX_SNAPSHOTS + 5, payable: false });
  });

  it('dates "since" from the start of the current status streak', () => {
    const s = [snap(1, false, 'NOT_ENOUGH_TRUSTED_REVIEWS'), snap(2, true), snap(3, true)];
    expect(sinceOf(s)).toBe(s[1]!.time);
    expect(sinceOf([])).toBe('');
  });

  it('adds a statusChanged row only when payable flips, with a stable id', () => {
    expect(statusChange('flaky', '9615', undefined, snap(5, true))).toBeUndefined(); // first reading
    expect(statusChange('flaky', '9615', snap(4, true), snap(5, true))).toBeUndefined();
    const row = statusChange('flaky', '9615', snap(4, true), snap(5, false, 'PAYEE_REPUTATION_TOO_LOW'))!;
    expect(row).toMatchObject({ kind: 'statusChanged', service: 'flaky', agentId: '9615', payable: false, reason: 'PAYEE_REPUTATION_TOO_LOW', block: 5 });
    expect(statusChange('flaky', '9615', snap(4, true), snap(5, false))!.txHash).toBe(row.txHash);
    // Merged twice (two snapshot runs see the same flip), it stays one row.
    expect(mergeEvents([row], [row], new Map())).toHaveLength(1);
  });
});
