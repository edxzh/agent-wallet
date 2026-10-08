/**
 * Live tail (contracts/dashboard.md): after first paint, polls Base Sepolia every 10 s for the
 * wallet's new events and USDC settlements since the snapshot, and prepends rows. The page is
 * complete without it (constitution VII); this only adds what happened since the last snapshot.
 */
import { decodeEventLog, encodeFunctionData, parseAbi, type Hex, type Log } from 'viem';
import { formatTime, toRow, usdc, type Entry, type Labels, type RowText } from '../lib/rows';

type LiveData = {
  lang: 'en' | 'zh';
  lastBlock: number;
  updated: string;
  wallet: string;
  dailyBudget: string;
  pending: Entry[];
  labels: Labels;
  text: RowText;
  networkDown: string;
};

const RPC = 'https://sepolia.base.org';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const POLL_MS = 10_000;
const MAX_RANGE = 500; // public RPC limit per eth_getLogs
const MAX_STEPS = 10;

const walletAbi = parseAbi([
  'event PaymentAuthorized(bytes32 indexed nonce, address indexed payee, bytes32 indexed taskId, uint256 amount, uint256 validBefore, bytes32 digest)',
  'event PaymentRefused(bytes32 indexed nonce, address indexed payee, bytes32 indexed taskId, uint256 amount, uint8 reason)',
  'event PaymentExpired(bytes32 indexed nonce, uint256 amount)',
  'event RuleChanged(bytes32 indexed field, bytes32 indexed key, uint256 oldValue, uint256 newValue)',
  'event Paused()',
  'event Unpaused()',
  'function spentOn(uint256 day) view returns (uint256)',
]);
const usdcAbi = parseAbi([
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
  'function balanceOf(address) view returns (uint256)',
]);
const REASONS = ['NONE', 'PAUSED', 'INVALID_AMOUNT', 'PAYEE_NOT_ALLOWED', 'OVER_PER_PAYMENT_CAP', 'OVER_TASK_BUDGET', 'OVER_DAILY_BUDGET', 'INSUFFICIENT_FUNDS'];
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
  }
  return undefined;
}

export function start() {
  const el = document.getElementById('aw-live');
  const list = document.querySelector<HTMLOListElement>('[data-live="rows"]');
  if (!el || !list) return;
  const data = JSON.parse(el.textContent || '{}') as LiveData;
  const notice = document.querySelector<HTMLElement>('[data-live="notice"]');
  const verify = data.text.verify;
  const byNonce = new Map<string, Entry>(data.pending.filter((e) => e.nonce).map((e) => [e.nonce!, e]));
  let cursor = data.lastBlock + 1;

  const render = (e: Entry, isNew: boolean) => {
    const r = toRow(e, data.labels, data.text);
    const li = document.createElement('li');
    li.className = `row ${r.tone}${isNew ? ' new' : ''}`;
    li.dataset.key = r.key;
    const icon = Object.assign(document.createElement('span'), { className: 'icon', textContent: r.icon });
    icon.setAttribute('aria-hidden', 'true');
    const text = document.createElement('div');
    text.className = 'text';
    text.append(Object.assign(document.createElement('p'), { className: 'title', textContent: r.title }));
    if (r.detail) text.append(Object.assign(document.createElement('p'), { className: 'detail', textContent: r.detail }));
    const meta = document.createElement('div');
    meta.className = 'meta';
    const time = Object.assign(document.createElement('time'), { textContent: formatTime(r.time, data.lang) });
    time.dateTime = r.time;
    const a = Object.assign(document.createElement('a'), { href: r.href, textContent: verify, target: '_blank', rel: 'noopener' });
    meta.append(time, a);
    li.append(icon, text, meta);
    const existing = list.querySelector(`[data-key="${r.key}"]`);
    if (existing) existing.replaceWith(li);
    else list.prepend(li);
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

  void tick();
  setInterval(() => void tick(), POLL_MS);
}
