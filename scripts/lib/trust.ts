/**
 * Pure helpers for feature 002's dashboard data (specs/002-trusted-payees-erc8004/contracts/
 * dashboard.md): service cards, per-run reputation snapshots and status changes. No I/O here.
 */
import { keccak256, toHex, type Address, type Hex } from 'viem';
import type { Entry } from './history.js';

export const MAX_SNAPSHOTS = 400;

/** One reading per service per run, verbatim from getSummary + checkPayee at `block`. */
export type ServiceSnapshot = { time: string; block: number; count: number; average: string; decimals: number; payable: boolean; reason?: string };

export type ServiceView = {
  key: string;
  label: { en: string; zh: string };
  /** The identity this route claims (the impostor claims reliable's); null for none. */
  agentId: string | null;
  claims: 'self' | 'reliable' | null;
  name?: string;
  description?: string;
  payTo: Address | null;
  /** getAgentWallet(agentId): who the identity says should be paid. */
  registeredWallet?: Address;
  /** Verbatim getSummary(agentId, trustedReviewers, "", "") at `block` (FR-015). */
  summary?: { count: number; average: string; decimals: number; block: number };
  /** checkPayee(payTo, hasClaim, agentId) on the gated wallet, at the same block. */
  payable: boolean;
  reason?: string;
  /** When `payable` last changed (or first seen). */
  since: string;
  snapshots: ServiceSnapshot[];
};

export type Erc8004Info = { identity: Address; reputation: Address; implementations: { identity: Address; reputation: Address }; pinnedOk: boolean };
export type ReputationRuleView = { wallet: Address; enabled: boolean; minAverage: number; minCount: number; trustedReviewers: { address: Address; label: string }[] };

/** `name` and `description` from a `data:application/json;base64,…` registration file. */
export function decodeAgentURI(uri: string | undefined): { name?: string; description?: string } {
  const m = uri?.match(/^data:application\/json;base64,(.+)$/);
  if (!m) return {};
  try {
    const file = JSON.parse(Buffer.from(m[1]!, 'base64').toString('utf8')) as { name?: unknown; description?: unknown };
    return {
      name: typeof file.name === 'string' ? file.name : undefined,
      description: typeof file.description === 'string' ? file.description : undefined,
    };
  } catch {
    return {};
  }
}

/** Adds this run's reading (one per block), keeping the newest `cap`. */
export function appendSnapshot(previous: ServiceSnapshot[], s: ServiceSnapshot, cap = MAX_SNAPSHOTS): ServiceSnapshot[] {
  const rest = previous.filter((p) => p.block !== s.block);
  return [...rest, s].sort((a, b) => a.block - b.block).slice(-cap);
}

/** When the current payable/not-payable streak started. */
export function sinceOf(snapshots: ServiceSnapshot[]): string {
  const last = snapshots.at(-1);
  if (!last) return '';
  let since = last.time;
  for (let i = snapshots.length - 1; i >= 0 && snapshots[i]!.payable === last.payable; i--) since = snapshots[i]!.time;
  return since;
}

/** A timeline row when a service's payable status differs from its previous snapshot. */
export function statusChange(key: string, agentId: string | null, previous: ServiceSnapshot | undefined, now: ServiceSnapshot): Entry | undefined {
  if (!previous || previous.payable === now.payable) return undefined;
  return {
    kind: 'statusChanged',
    service: key,
    agentId: agentId ?? undefined,
    payable: now.payable,
    reason: now.reason,
    block: now.block,
    logIndex: 1_000_000, // after any on-chain log in that block
    // Not a transaction: a stable id so merges dedupe it. Rows link to the service, not to this.
    txHash: keccak256(toHex(`status:${key}:${now.block}`)) as Hex,
    time: now.time,
  };
}
