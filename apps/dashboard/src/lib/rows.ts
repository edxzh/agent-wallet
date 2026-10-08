/**
 * Turns history.json entries into timeline rows. Shared by the static page (Astro) and the live
 * tail (browser), so both render identical text. No dependencies.
 */
export type Entry = {
  kind: 'authorized' | 'refused' | 'expired' | 'ruleChange' | 'paused' | 'unpaused';
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
  block: number;
  logIndex: number;
  txHash: string;
  time: string;
};

export type Labels = {
  payees: Record<string, string>; // lower-case address → label
  tasks: Record<string, string>; // taskId → label
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
