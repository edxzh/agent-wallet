/**
 * Pure helpers for the dashboard snapshot (contracts/dashboard.md): decode wallet and USDC logs
 * into record entries and merge them into history.json. No I/O here, so it is unit-tested.
 */
import { decodeEventLog, getAddress, type Address, type Hex, type Log } from 'viem';
import { policyWalletAbi } from '../../packages/agent/src/abi.js';
import { usdcAbi } from '../../packages/agent/src/chain.js';
import { reasonName } from '../../packages/agent/src/reasons.js';

export type Entry = {
  kind: 'authorized' | 'refused' | 'expired' | 'ruleChange' | 'paused' | 'unpaused' | 'rated' | 'statusChanged';
  /** For `authorized`: whether USDC settled it, and the settlement tx. */
  settled?: boolean;
  settledTx?: Hex;
  nonce?: Hex;
  payee?: Address;
  amount?: string;
  taskId?: Hex;
  reason?: string;
  ruleField?: string;
  ruleKey?: Hex;
  oldValue?: string;
  newValue?: string;
  /** 002 `rated`: the wallet's rating of a settled, identity-checked payment (PaymentRated). */
  agentId?: string;
  score?: number;
  tag?: string;
  feedbackIndex?: string;
  /** 002 `statusChanged`: a demo service became payable or not (from consecutive snapshots). */
  service?: string;
  payable?: boolean;
  block: number;
  logIndex: number;
  txHash: Hex;
  time: string;
};

export type WalletHistory = {
  address: Address;
  name: string;
  paused: boolean;
  policy: { perPaymentCap: string; dailyBudget: string };
  payees: { address: Address; label: string; labelZh?: string; allowed: boolean }[];
  tasks: { id: Hex; label: string; budget: string; spent: string }[];
  today: { day: number; spent: string };
  balance: string;
  events: Entry[];
};

export type History = {
  network: string;
  generatedAt: string;
  lastBlock: number;
  wallets: WalletHistory[];
  // 002: trusted payees (optional until set up)
  erc8004?: import('./trust.js').Erc8004Info;
  reputationRule?: import('./trust.js').ReputationRuleView;
  services?: import('./trust.js').ServiceView[];
};

export const MAX_EVENTS = 500;

const fieldName = (f: Hex) => {
  const bytes = Buffer.from(f.slice(2), 'hex');
  return bytes.subarray(0, bytes.indexOf(0) === -1 ? 32 : bytes.indexOf(0)).toString('utf8');
};

/** Decodes the wallet's own logs into entries. `times` maps block number → ISO time. */
export function decodeWalletLogs(logs: Log[], times: Map<number, string>): Entry[] {
  const out: Entry[] = [];
  for (const log of logs) {
    let ev;
    try {
      ev = decodeEventLog({ abi: policyWalletAbi, data: log.data, topics: log.topics });
    } catch {
      continue; // not one of ours (e.g. Initialized)
    }
    const block = Number(log.blockNumber);
    const base = { block, logIndex: Number(log.logIndex), txHash: log.transactionHash!, time: times.get(block) ?? '' };
    const a = ev.args as Record<string, unknown>;
    switch (ev.eventName) {
      case 'PaymentAuthorized':
        out.push({ ...base, kind: 'authorized', settled: false, nonce: a.nonce as Hex, payee: getAddress(a.payee as string), taskId: a.taskId as Hex, amount: String(a.amount) });
        break;
      case 'PaymentRefused':
        out.push({ ...base, kind: 'refused', nonce: a.nonce as Hex, payee: getAddress(a.payee as string), taskId: a.taskId as Hex, amount: String(a.amount), reason: reasonName(Number(a.reason)) });
        break;
      case 'PaymentExpired':
        out.push({ ...base, kind: 'expired', nonce: a.nonce as Hex, amount: String(a.amount) });
        break;
      case 'RuleChanged':
        out.push({ ...base, kind: 'ruleChange', ruleField: fieldName(a.field as Hex), ruleKey: a.key as Hex, oldValue: String(a.oldValue), newValue: String(a.newValue) });
        break;
      case 'Paused':
        out.push({ ...base, kind: 'paused' });
        break;
      case 'Unpaused':
        out.push({ ...base, kind: 'unpaused' });
        break;
      case 'PaymentRated':
        out.push({
          ...base,
          kind: 'rated',
          nonce: a.nonce as Hex,
          agentId: String(a.agentId),
          score: Number(a.score),
          tag: a.tag as string,
          feedbackIndex: String(a.feedbackIndex),
        });
        break;
    }
  }
  return out;
}

/** USDC AuthorizationUsed logs (authorizer = wallet) → nonce → settlement tx. */
export function settlementsFrom(logs: Log[]): Map<Hex, Hex> {
  const m = new Map<Hex, Hex>();
  for (const log of logs) {
    try {
      const ev = decodeEventLog({ abi: usdcAbi, data: log.data, topics: log.topics });
      if (ev.eventName === 'AuthorizationUsed') m.set(ev.args.nonce, log.transactionHash!);
    } catch {}
  }
  return m;
}

/** Merges new entries into the old ones: dedupe, mark settlements, newest first, capped. */
export function mergeEvents(previous: Entry[], fresh: Entry[], settlements: Map<Hex, Hex>, cap = MAX_EVENTS): Entry[] {
  const key = (e: Entry) => `${e.txHash}:${e.logIndex}`;
  const byKey = new Map<string, Entry>();
  for (const e of [...previous, ...fresh]) byKey.set(key(e), { ...e });
  for (const e of byKey.values()) {
    if (e.kind === 'authorized' && e.nonce && settlements.has(e.nonce)) {
      e.settled = true;
      e.settledTx = settlements.get(e.nonce);
    }
  }
  return [...byKey.values()].sort((a, b) => b.block - a.block || b.logIndex - a.logIndex).slice(0, cap);
}
