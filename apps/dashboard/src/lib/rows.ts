/**
 * Turns history.json entries into timeline rows. Shared by the static page (Astro) and the live
 * tail (browser), so both render identical text. No dependencies.
 */
export type Entry = {
  kind: 'authorized' | 'refused' | 'expired' | 'ruleChange' | 'paused' | 'unpaused' | 'rated' | 'statusChanged';
  settled?: boolean;
  settledTx?: string;
  nonce?: string;
  payee?: string;
  amount?: string;
  taskId?: string;
  reason?: string;
  ruleField?: string;
  ruleKey?: string;
  oldValue?: string;
  newValue?: string;
  agentId?: string;
  score?: number;
  tag?: string;
  feedbackIndex?: string;
  service?: string;
  payable?: boolean;
  block: number;
  logIndex: number;
  txHash: string;
  time: string;
};

export type Labels = {
  payees: Record<string, string>; // lower-case address → label
  tasks: Record<string, string>; // taskId → label
  services?: Record<string, string>; // 002: agentId → service label
  serviceKeys?: Record<string, string>; // 002: service key → label
};

export type RowText = {
  paid: string;
  pending: string;
  refused: string;
  expired: string;
  paused: string;
  unpaused: string;
  rule: Record<string, string>; // perPaymentCap, dailyBudget, payeeAllowed, payeeRemoved, taskBudget, agent
  reason: Record<string, string>;
  to: string;
  task: string;
  verify: string;
  unknownPayee: string;
  rated: string;
  statusPayable: string;
  statusNotPayable: string;
  tags: Record<string, string>;
};

export type Row = { key: string; icon: string; tone: 'ok' | 'bad' | 'muted' | 'info'; title: string; detail: string; href: string; time: string };

const ZERO_TASK = '0x' + '0'.repeat(64);

export function usdc(units: string | bigint | undefined): string {
  const v = BigInt(units ?? 0);
  const whole = v / 1_000_000n;
  const frac = (v % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${whole}.${frac.length < 2 ? frac.padEnd(2, '0') : frac}`;
}

export const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
export const txLink = (hash: string) => `https://sepolia.basescan.org/tx/${hash}`;
export const IDENTITY_REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
/** The ERC-8004 identity (an NFT) on BaseScan. */
export const identityLink = (agentId: string) => `https://sepolia.basescan.org/nft/${IDENTITY_REGISTRY}/${agentId}`;

const fill = (t: string, vars: Record<string, string>) => t.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '');

export function toRow(e: Entry, labels: Labels, t: RowText): Row {
  const payee = e.payee ? (labels.payees[e.payee.toLowerCase()] ?? `${t.unknownPayee} ${shortAddress(e.payee)}`) : '';
  const task = e.taskId && e.taskId !== ZERO_TASK ? (labels.tasks[e.taskId] ?? shortAddress(e.taskId)) : '';
  const detail = [payee && `${t.to} ${payee}`, task && `${t.task} ${task}`].filter(Boolean).join(' · ');
  const base = { key: `${e.txHash}:${e.logIndex}`, time: e.time, href: txLink(e.txHash) };
  switch (e.kind) {
    case 'authorized':
      return e.settled
        ? { ...base, icon: '✓', tone: 'ok', title: fill(t.paid, { amount: usdc(e.amount) }), detail, href: txLink(e.settledTx ?? e.txHash) }
        : { ...base, icon: '…', tone: 'muted', title: fill(t.pending, { amount: usdc(e.amount) }), detail };
    case 'refused':
      return { ...base, icon: '✕', tone: 'bad', title: fill(t.refused, { amount: usdc(e.amount) }), detail: [t.reason[e.reason ?? ''] ?? e.reason, detail].filter(Boolean).join(' · ') };
    case 'expired':
      return { ...base, icon: '↺', tone: 'muted', title: fill(t.expired, { amount: usdc(e.amount) }), detail: '' };
    case 'paused':
      return { ...base, icon: '⏸', tone: 'info', title: t.paused, detail: '' };
    case 'unpaused':
      return { ...base, icon: '▶', tone: 'info', title: t.unpaused, detail: '' };
    case 'rated': {
      const service = labels.services?.[e.agentId ?? ''] ?? `#${e.agentId}`;
      const tag = t.tags[e.tag ?? ''] ?? e.tag ?? '';
      return { ...base, icon: '★', tone: (e.score ?? 0) >= 70 ? 'ok' : 'bad', title: fill(t.rated, { service, score: String(e.score), tag }), detail: '' };
    }
    case 'statusChanged': {
      const service = labels.serviceKeys?.[e.service ?? ''] ?? e.service ?? '';
      const reason = e.payable ? '' : (t.reason[e.reason ?? ''] ?? e.reason ?? '');
      return {
        ...base,
        icon: e.payable ? '↑' : '↓',
        tone: e.payable ? 'ok' : 'bad',
        title: fill(e.payable ? t.statusPayable : t.statusNotPayable, { service }),
        detail: reason,
        href: e.agentId ? identityLink(e.agentId) : base.href, // not a transaction: link the identity
      };
    }
    case 'ruleChange': {
      const f = e.ruleField ?? '';
      let title: string;
      if (f === 'payee') {
        const who = labels.payees['0x' + (e.ruleKey ?? '').slice(-40)] ?? shortAddress('0x' + (e.ruleKey ?? '').slice(-40));
        title = fill(e.newValue === '1' ? t.rule.payeeAllowed! : t.rule.payeeRemoved!, { payee: who });
      } else if (f === 'taskBudget') {
        title = fill(t.rule.taskBudget!, { task: labels.tasks[e.ruleKey ?? ''] ?? shortAddress(e.ruleKey ?? ''), old: usdc(e.oldValue), new: usdc(e.newValue) });
      } else if (f === 'agent') {
        title = t.rule.agent!;
      } else {
        title = fill(t.rule[f] ?? f, { old: usdc(e.oldValue), new: usdc(e.newValue) });
      }
      return { ...base, icon: '⚙', tone: 'info', title, detail: '' };
    }
  }
}

// ── Groups ──────────────────────────────────────────────────────────────────────────────
// The agent acts in bursts (a scheduled run is a few payments and probes within a minute), so
// the timeline groups entries that are close in time. Operator actions get groups of their own.

export type RowKind = 'paid' | 'pending' | 'refused' | 'released' | 'rule' | 'paused' | 'unpaused' | 'rated' | 'status';

export type GroupText = {
  agent: string;
  operator: string;
  paid: string;
  pending: string;
  refused: string;
  released: string;
  rule: string;
  rules: string;
  paused: string;
  unpaused: string;
  spent: string;
  older: string;
  rated: string;
};

export type Group = { key: string; operator: boolean; entries: Entry[] };

/** Entries further apart than this start a new group. Runs take about a minute. */
export const GROUP_GAP_MS = 10 * 60_000;

export function rowKind(e: Entry): RowKind {
  switch (e.kind) {
    case 'authorized':
      return e.settled ? 'paid' : 'pending';
    case 'refused':
      return 'refused';
    case 'expired':
      return 'released';
    case 'ruleChange':
      return 'rule';
    case 'rated':
      return 'rated';
    case 'statusChanged':
      return 'status';
    default:
      return e.kind;
  }
}

export const isOperatorKind = (k: RowKind) => k === 'rule' || k === 'paused' || k === 'unpaused';

/** Groups newest-first entries into newest-first groups. */
export function groupEntries(entries: Entry[]): Group[] {
  const groups: Group[] = [];
  for (const e of entries) {
    const operator = isOperatorKind(rowKind(e));
    const g = groups.at(-1);
    const oldest = g?.entries.at(-1);
    if (g && oldest && g.operator === operator && Date.parse(oldest.time) - Date.parse(e.time) <= GROUP_GAP_MS) g.entries.push(e);
    else groups.push({ key: `${e.txHash}:${e.logIndex}`, operator, entries: [e] });
  }
  return groups;
}

/** A group's heading: its title and counts, e.g. "3 paid · 4 refused · 0.03 USDC spent". */
export function summarize(items: { kind: RowKind; amount?: string }[], operator: boolean, t: GroupText): { title: string; counts: string } {
  const n = (k: RowKind) => items.filter((i) => i.kind === k).length;
  const parts: string[] = [];
  for (const k of ['paid', 'pending', 'refused', 'released', 'rated'] as const) if (n(k)) parts.push(fill(t[k], { n: String(n(k)) }));
  if (n('rule')) parts.push(fill(n('rule') === 1 ? t.rule : t.rules, { n: String(n('rule')) }));
  if (n('paused')) parts.push(t.paused);
  if (n('unpaused')) parts.push(t.unpaused);
  const spent = items.filter((i) => i.kind === 'paid').reduce((sum, i) => sum + BigInt(i.amount ?? 0), 0n);
  if (spent > 0n) parts.push(fill(t.spent, { amount: usdc(spent) }));
  return { title: operator ? t.operator : t.agent, counts: parts.join(' · ') };
}

/** "8 Oct 2026, 02:17 UTC" / "2026年10月8日 02:17 UTC" */
export function formatTime(iso: string, lang: 'en' | 'zh'): string {
  if (!iso) return '';
  const d = new Date(iso);
  const s = new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'en-GB', {
    year: 'numeric',
    month: lang === 'zh' ? 'long' : 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  }).format(d);
  return `${s} UTC`;
}
