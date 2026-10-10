/**
 * Live tail (contracts/dashboard.md): after first paint, polls Base Sepolia every 10 s for the
 * wallet's new events and USDC settlements since the snapshot, and adds them to the newest group
 * (or starts a new one). The page is
 * complete without it (constitution VII); this only adds what happened since the last snapshot.
 */
import { decodeEventLog, decodeFunctionResult, encodeFunctionData, parseAbi, type Hex, type Log } from 'viem';
import { formatTime, GROUP_GAP_MS, isOperatorKind, rowKind, summarize, toRow, usdc, type Entry, type GroupText, type Labels, type RowKind, type RowText } from '../lib/rows';

type LiveData = {
  lang: 'en' | 'zh';
  lastBlock: number;
  updated: string;
  wallet: string;
  dailyBudget: string;
  pending: Entry[];
  labels: Labels;
  text: RowText;
  groupText: GroupText;
  networkDown: string;
  /** 002: what the service cards need to refresh themselves. */
  trust?: {
    reputation: string;
    trusted: string[];
    services: { key: string; agentId: string | null; payTo: string | null }[];
    payable: string;
    notPayable: string;
    reasons: Record<string, string>;
  };
};

const RPC = 'https://sepolia.base.org';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const POLL_MS = 10_000;
const MAX_RANGE = 200; // public RPC limit per eth_getLogs
const MAX_STEPS = 10;

const walletAbi = parseAbi([
  'event PaymentAuthorized(bytes32 indexed nonce, address indexed payee, bytes32 indexed taskId, uint256 amount, uint256 validBefore, bytes32 digest)',
  'event PaymentRefused(bytes32 indexed nonce, address indexed payee, bytes32 indexed taskId, uint256 amount, uint8 reason)',
  'event PaymentExpired(bytes32 indexed nonce, uint256 amount)',
  'event RuleChanged(bytes32 indexed field, bytes32 indexed key, uint256 oldValue, uint256 newValue)',
  'event Paused()',
  'event Unpaused()',
  'function spentOn(uint256 day) view returns (uint256)',
  // 002
  'event PaymentRated(bytes32 indexed nonce, uint256 indexed agentId, uint8 score, string tag, uint64 feedbackIndex)',
  'function checkPayee(address payee, bool hasClaim, uint256 payeeAgentId) view returns (uint8)',
]);
const reputationAbi = parseAbi([
  'function getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2) view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)',
]);
const TRUST_REFRESH_MS = 30_000; // contracts/dashboard.md: getSummary no faster than every 30 s
const usdcAbi = parseAbi([
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
  'function balanceOf(address) view returns (uint256)',
]);
const REASONS = [
  'NONE', 'PAUSED', 'INVALID_AMOUNT', 'PAYEE_NOT_ALLOWED', 'OVER_PER_PAYMENT_CAP', 'OVER_TASK_BUDGET', 'OVER_DAILY_BUDGET', 'INSUFFICIENT_FUNDS',
  // 002: trusted payees (contracts/src/Reason.sol, append only)
  'PAYEE_IDENTITY_UNVERIFIED', 'PAYEE_IDENTITY_MISMATCH', 'REPUTATION_UNAVAILABLE', 'NOT_ENOUGH_TRUSTED_REVIEWS', 'PAYEE_REPUTATION_TOO_LOW',
];
const AUTH_USED_TOPIC = '0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5';

let rpcId = 0;
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
  const json = (await res.json()) as { result?: T; error?: { message: string } };
  if (json.error || json.result === undefined) throw new Error(json.error?.message ?? 'rpc error');
  return json.result;
}
const hex = (n: number) => '0x' + n.toString(16);

function fieldName(f: Hex) {
  let s = '';
  for (let i = 2; i < f.length; i += 2) {
    const c = parseInt(f.slice(i, i + 2), 16);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

function toEntry(log: Log, time: string): Entry | undefined {
  let ev;
  try {
    ev = decodeEventLog({ abi: walletAbi, data: log.data, topics: log.topics });
  } catch {
    return undefined;
  }
  const base = { block: Number(log.blockNumber), logIndex: Number(log.logIndex), txHash: log.transactionHash!, time };
  const a = ev.args as Record<string, any>;
  switch (ev.eventName) {
    case 'PaymentAuthorized':
      return { ...base, kind: 'authorized', settled: false, nonce: a.nonce, payee: a.payee, taskId: a.taskId, amount: String(a.amount) };
    case 'PaymentRefused':
      return { ...base, kind: 'refused', nonce: a.nonce, payee: a.payee, taskId: a.taskId, amount: String(a.amount), reason: REASONS[Number(a.reason)] };
    case 'PaymentExpired':
      return { ...base, kind: 'expired', nonce: a.nonce, amount: String(a.amount) };
    case 'RuleChanged':
      return { ...base, kind: 'ruleChange', ruleField: fieldName(a.field), ruleKey: a.key, oldValue: String(a.oldValue), newValue: String(a.newValue) };
    case 'Paused':
      return { ...base, kind: 'paused' };
    case 'Unpaused':
      return { ...base, kind: 'unpaused' };
    case 'PaymentRated':
      return { ...base, kind: 'rated', nonce: a.nonce, agentId: String(a.agentId), score: Number(a.score), tag: a.tag, feedbackIndex: String(a.feedbackIndex) };
  }
  return undefined;
}

export function start() {
  const el = document.getElementById('aw-live');
  const groups = document.querySelector<HTMLElement>('[data-live="groups"]');
  const timeline = groups?.closest('section');
  if (!el || !groups || !timeline) return;
  const data = JSON.parse(el.textContent || '{}') as LiveData;
  const notice = document.querySelector<HTMLElement>('[data-live="notice"]');
  const verify = data.text.verify;
  const byNonce = new Map<string, Entry>(data.pending.filter((e) => e.nonce).map((e) => [e.nonce!, e]));
  let cursor = data.lastBlock + 1;

  const el$ = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = '') =>
    Object.assign(document.createElement(tag), { className, textContent: text });

  /** Re-derives a group's heading from its rows (rows change kind when a payment settles). */
  const refreshGroup = (g: HTMLElement) => {
    const items = [...g.querySelectorAll<HTMLElement>('li.row')].map((li) => ({ kind: li.dataset.kind as RowKind, amount: li.dataset.amount }));
    const { title, counts } = summarize(items, g.dataset.group === 'operator', data.groupText);
    g.querySelector('.gtitle')!.textContent = title;
    g.querySelector('.counts')!.textContent = counts;
    const newest = g.querySelector<HTMLTimeElement>('li.row time')?.dateTime ?? '';
    g.dataset.newest = newest;
    const time = g.querySelector<HTMLTimeElement>(':scope > summary time')!;
    time.dateTime = newest;
    time.textContent = formatTime(newest, data.lang);
  };

  const newGroup = (operator: boolean) => {
    const g = document.createElement('details');
    g.className = 'group';
    g.open = true;
    g.dataset.group = operator ? 'operator' : 'agent';
    const summary = document.createElement('summary');
    const chev = el$('span', 'chev');
    chev.setAttribute('aria-hidden', 'true');
    summary.append(chev, el$('span', 'gtitle'), el$('span', 'counts'), document.createElement('time'));
    const ol = document.createElement('ol');
    ol.setAttribute('role', 'list');
    g.append(summary, ol);
    groups.prepend(g);
    timeline.querySelector<HTMLElement>('[data-live="empty"]')?.setAttribute('hidden', '');
    return g;
  };

  const render = (e: Entry, isNew: boolean) => {
    const r = toRow(e, data.labels, data.text);
    const kind = rowKind(e);
    const li = document.createElement('li');
    li.className = `row ${r.tone}${isNew ? ' new' : ''}`;
    li.dataset.key = r.key;
    li.dataset.kind = kind;
    if (e.amount) li.dataset.amount = e.amount;
    const icon = el$('span', 'icon', r.icon);
    icon.setAttribute('aria-hidden', 'true');
    const text = el$('div', 'text');
    text.append(el$('p', 'title', r.title));
    if (r.detail) text.append(el$('p', 'detail', r.detail));
    const meta = el$('div', 'meta');
    const time = el$('time', '', formatTime(r.time, data.lang));
    time.dateTime = r.time;
    const a = Object.assign(document.createElement('a'), { href: r.href, textContent: verify, target: '_blank', rel: 'noopener' });
    meta.append(time, a);
    li.append(icon, text, meta);

    const existing = timeline.querySelector<HTMLElement>(`li[data-key="${r.key}"]`);
    let group: HTMLElement;
    if (existing) {
      group = existing.closest<HTMLElement>('details.group')!;
      existing.replaceWith(li);
    } else {
      const operator = isOperatorKind(kind);
      const top = groups.querySelector<HTMLElement>(':scope > details.group');
      const close = top && top.dataset.group === (operator ? 'operator' : 'agent') && Date.parse(r.time) - Date.parse(top.dataset.newest ?? '') <= GROUP_GAP_MS;
      group = close ? top : newGroup(operator);
      group.querySelector('ol')!.prepend(li);
    }
    refreshGroup(group);
  };

  const refreshCounters = async () => {
    const day = Math.floor(Date.now() / 86_400_000);
    const [spent, balance] = await Promise.all([
      rpc<Hex>('eth_call', [{ to: data.wallet, data: encodeFunctionData({ abi: walletAbi, functionName: 'spentOn', args: [BigInt(day)] }) }, 'latest']),
      rpc<Hex>('eth_call', [{ to: USDC, data: encodeFunctionData({ abi: usdcAbi, functionName: 'balanceOf', args: [data.wallet as Hex] }) }, 'latest']),
    ]);
    const today = document.querySelector('[data-live="today"] [data-live-text]');
    if (today) today.textContent = `${usdc(BigInt(spent))} / ${usdc(data.dailyBudget)} USDC`;
    const bal = document.querySelector('[data-live="balance"]');
    if (bal) bal.textContent = `${usdc(BigInt(balance))} USDC`;
  };

  const tick = async () => {
    try {
      const latest = Number(await rpc<Hex>('eth_blockNumber', []));
      let changed = false;
      for (let step = 0; step < MAX_STEPS && cursor <= latest; step++) {
        const to = Math.min(cursor + MAX_RANGE - 1, latest);
        const [walletLogs, usdcLogs] = await Promise.all([
          rpc<Log[]>('eth_getLogs', [{ address: data.wallet, fromBlock: hex(cursor), toBlock: hex(to) }]),
          rpc<Log[]>('eth_getLogs', [{ address: USDC, fromBlock: hex(cursor), toBlock: hex(to), topics: [AUTH_USED_TOPIC, '0x' + data.wallet.slice(2).toLowerCase().padStart(64, '0')] }]),
        ]);
        for (const log of walletLogs) {
          const block = await rpc<{ timestamp: Hex }>('eth_getBlockByNumber', [log.blockNumber, false]);
          const e = toEntry(log, new Date(Number(block.timestamp) * 1000).toISOString());
          if (!e) continue;
          if (e.nonce && e.kind === 'authorized') byNonce.set(e.nonce, e);
          render(e, true);
          changed = true;
        }
        for (const log of usdcLogs) {
          const ev = decodeEventLog({ abi: usdcAbi, data: log.data, topics: log.topics });
          const e = ev.eventName === 'AuthorizationUsed' ? byNonce.get(ev.args.nonce) : undefined;
          if (e && !e.settled) {
            e.settled = true;
            e.settledTx = log.transactionHash!;
            render(e, true);
            changed = true;
          }
        }
        cursor = to + 1;
      }
      if (changed) await refreshCounters();
      if (notice) notice.hidden = true;
    } catch {
      if (notice) {
        notice.textContent = data.networkDown.replace('{time}', data.updated);
        notice.hidden = false;
      }
    }
  };

  // 002: re-read each card's trusted summary and payable status (same calls the wallet makes).
  let lastTrust = 0;
  const refreshTrust = async () => {
    const tr = data.trust;
    if (!tr || Date.now() - lastTrust < TRUST_REFRESH_MS) return;
    lastTrust = Date.now();
    for (const s of tr.services) {
      const card = document.querySelector<HTMLElement>(`[data-service="${s.key}"]`);
      if (!card) continue;
      if (s.agentId !== null && tr.trusted.length) {
        const ret = await rpc<Hex>('eth_call', [
          { to: tr.reputation, data: encodeFunctionData({ abi: reputationAbi, functionName: 'getSummary', args: [BigInt(s.agentId), tr.trusted as Hex[], '', ''] }) },
          'latest',
        ]);
        const [count, value, decimals] = decodeFunctionResult({ abi: reputationAbi, functionName: 'getSummary', data: ret });
        const set = (sel: string, text: string) => {
          const el = card.querySelector(`[data-svc="${sel}"]`);
          if (el) el.textContent = text;
        };
        set('count', String(count));
        set('average', count > 0n ? (Number(value) / 10 ** decimals).toFixed(decimals ? 1 : 0) : '–');
      }
      if (s.payTo) {
        const ret = await rpc<Hex>('eth_call', [
          { to: data.wallet, data: encodeFunctionData({ abi: walletAbi, functionName: 'checkPayee', args: [s.payTo as Hex, s.agentId !== null, BigInt(s.agentId ?? 0)] }) },
          'latest',
        ]);
        const code = Number(decodeFunctionResult({ abi: walletAbi, functionName: 'checkPayee', data: ret }));
        const badge = card.querySelector('[data-svc="badge"]');
        const wasPayable = badge?.classList.contains('on');
        if (badge && wasPayable !== (code === 0)) {
          badge.classList.toggle('on', code === 0);
          badge.classList.toggle('off', code !== 0);
          badge.textContent = code === 0 ? tr.payable : tr.notPayable;
          const reason = card.querySelector('[data-svc="reason"]');
          if (reason) reason.textContent = code === 0 ? '' : (tr.reasons[REASONS[code] ?? ''] ?? REASONS[code] ?? '');
        }
      }
    }
  };

  void tick();
  setInterval(() => void tick(), POLL_MS);
  setInterval(() => void refreshTrust().catch(() => {}), POLL_MS);
}
