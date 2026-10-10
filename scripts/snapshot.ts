/**
 * Builds apps/dashboard/src/data/history.json from Base Sepolia (contracts/dashboard.md).
 * Incremental: resumes from `lastBlock + 1`, fetches logs in ≤ 200-block chunks (public RPC limit),
 * reads current views, merges, caps at 500 events per wallet. Read-only: no keys needed.
 *
 * Usage: npm run snapshot
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { getAddress, isAddress, type Log } from 'viem';
import { blockRanges, formatUsdc, guardedPublicClient, usdcAbi } from '../packages/agent/src/chain.js';
import { loadConfig, NETWORK, readDeployments, readPayees, USDC } from '../packages/agent/src/config.js';
import { readWalletState } from '../packages/agent/src/state.js';
import { decodeWalletLogs, mergeEvents, settlementsFrom, type Entry, type History, type WalletHistory } from './lib/history.js';
import { policyWalletAbi } from '../packages/agent/src/abi.js';
import { ROOT } from '../packages/agent/src/config.js';
import { reasonName } from '../packages/agent/src/reasons.js';
import { assertRegistriesPinned, ERC8004, IDENTITY_REGISTRY, identityAbi, REPUTATION_REGISTRY, reputationAbi } from '../packages/agent/src/registries.js';
import { appendSnapshot, decodeAgentURI, sinceOf, statusChange, type Erc8004Info, type ReputationRuleView, type ServiceView } from './lib/trust.js';

const OUT = new URL('../apps/dashboard/src/data/history.json', import.meta.url);
const cfg = loadConfig();
const pub = await guardedPublicClient(cfg.rpcUrl);
const deployments = readDeployments();
const payeeLabels = readPayees().filter((p) => isAddress(p.address));
const previous: History | undefined = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : undefined;

const latest = await pub.getBlockNumber();
const wallets: WalletHistory[] = [];

for (const w of deployments.wallets) {
  const address = getAddress(w.address);
  const prev = previous?.wallets.find((p) => getAddress(p.address) === address);
  const from = BigInt(prev ? previous!.lastBlock + 1 : w.createdBlock);

  const walletLogs: Log[] = [];
  const usdcLogs: Log[] = [];
  for (const [fromBlock, toBlock] of from <= latest ? blockRanges(from, latest) : []) {
    walletLogs.push(...(await pub.getLogs({ address, fromBlock, toBlock })));
    usdcLogs.push(
      ...(await pub.getLogs({
        address: USDC,
        event: usdcAbi.find((x) => x.type === 'event' && x.name === 'AuthorizationUsed') as never,
        args: { authorizer: address } as never,
        fromBlock,
        toBlock,
      })),
    );
  }

  const times = new Map<number, string>();
  for (const n of new Set(walletLogs.map((l) => Number(l.blockNumber)))) {
    const b = await pub.getBlock({ blockNumber: BigInt(n) });
    times.set(n, new Date(Number(b.timestamp) * 1000).toISOString());
  }
  const settlements = settlementsFrom(usdcLogs);
  const events = mergeEvents(prev?.events ?? [], decodeWalletLogs(walletLogs, times), settlements);

  const tasks = deployments.tasks ?? [];
  const s = await readWalletState(pub, address, tasks.map((t) => t.id), payeeLabels.map((p) => getAddress(p.address)));
  const name = (await pub.readContract({ address, abi: [{ type: 'function', name: 'name', inputs: [], outputs: [{ type: 'string' }], stateMutability: 'view' }], functionName: 'name' })) as string;
  wallets.push({
    address,
    name,
    paused: s.paused,
    policy: { perPaymentCap: s.perPaymentCap.toString(), dailyBudget: s.dailyBudget.toString() },
    payees: payeeLabels.map((p) => ({ address: getAddress(p.address), label: p.label, labelZh: p.labelZh, allowed: s.payees[getAddress(p.address)] ?? false })),
    tasks: tasks.map((t) => ({ id: t.id, label: t.label, budget: s.tasks[t.id]!.budget.toString(), spent: s.tasks[t.id]!.spent.toString() })),
    today: { day: Number(s.day), spent: s.spentToday.toString() },
    balance: s.balance.toString(),
    events,
  });
  console.error(`✓ ${name}: +${walletLogs.length} wallet logs, ${settlements.size} settlements, ${events.length} events, balance ${formatUsdc(s.balance)}`);
}

// ── 002: trusted payees ─────────────────────────────────────────────────────────────────
// The gated wallet is the first in deployments.json (research-bot-01). Everything below is read
// at `latest`, so a card's average, count and payable status all come from the same block.
type ServiceEntry = { key: string; label: { en: string; zh: string }; agentId: string | null; payTo: string | null; claims: 'self' | 'reliable' | null };
const servicesPath = `${ROOT}config/services.json`;
const serviceEntries: ServiceEntry[] = existsSync(servicesPath) ? JSON.parse(readFileSync(servicesPath, 'utf8')).services : [];
const gated = wallets[0];
const gatedHasRule = gated
  ? await pub.readContract({ address: gated.address, abi: policyWalletAbi, functionName: 'identityRegistry', blockNumber: latest }).then(() => true, () => false)
  : false;
let erc8004: Erc8004Info | undefined;
let reputationRule: ReputationRuleView | undefined;
let services: ServiceView[] | undefined;
if (gated && gatedHasRule && serviceEntries.some((x) => x.agentId !== null)) {
  const pinnedOk = await assertRegistriesPinned(pub as never).then(() => true, () => false);
  erc8004 = {
    identity: IDENTITY_REGISTRY,
    reputation: REPUTATION_REGISTRY,
    implementations: { identity: getAddress(ERC8004.identity.implementation), reputation: getAddress(ERC8004.reputation.implementation) },
    pinnedOk,
  };
  const read = <T>(address: `0x${string}`, abi: readonly unknown[], functionName: string, args: unknown[] = []) =>
    pub.readContract({ address, abi, functionName, args, blockNumber: latest } as never) as Promise<T>;
  const [enabled, minAverage, minCount] = await read<readonly [boolean, number, bigint]>(gated.address, policyWalletAbi, 'reputationRule');
  const trusted = await read<readonly `0x${string}`[]>(gated.address, policyWalletAbi, 'trustedReviewers');
  const nameOf = (a: string) => deployments.wallets.find((w) => getAddress(w.address) === getAddress(a))?.name ?? a;
  reputationRule = {
    wallet: gated.address,
    enabled,
    minAverage: Number(minAverage),
    minCount: Number(minCount),
    trustedReviewers: trusted.map((a) => ({ address: getAddress(a), label: nameOf(a) })),
  };
  const block = await pub.getBlock({ blockNumber: latest });
  const time = new Date(Number(block.timestamp) * 1000).toISOString();
  const statusRows: Entry[] = [];
  services = [];
  for (const e of serviceEntries) {
    // The identity a route claims: its own, reliable's (impostor), or none (anonymous).
    const claimed = e.claims === 'self' ? e.agentId : e.claims === 'reliable' ? (serviceEntries.find((x) => x.key === 'reliable')?.agentId ?? null) : null;
    const prev = previous?.services?.find((x) => x.key === e.key);
    const payTo = e.payTo ? getAddress(e.payTo) : null;
    let view: Omit<ServiceView, 'payable' | 'reason' | 'since' | 'snapshots'> = { key: e.key, label: e.label, agentId: claimed, claims: e.claims, payTo };
    let summary: ServiceView['summary'];
    if (claimed !== null) {
      const id = BigInt(claimed);
      const [uri, registered] = await Promise.all([
        read<string>(IDENTITY_REGISTRY, identityAbi, 'tokenURI', [id]).catch(() => undefined),
        read<`0x${string}`>(IDENTITY_REGISTRY, identityAbi, 'getAgentWallet', [id]),
      ]);
      const [count, average, decimals] = trusted.length
        ? await read<readonly [bigint, bigint, number]>(REPUTATION_REGISTRY, reputationAbi, 'getSummary', [id, trusted, '', ''])
        : [0n, 0n, 0];
      summary = { count: Number(count), average: average.toString(), decimals: Number(decimals), block: Number(latest) };
      view = { ...view, ...decodeAgentURI(uri), registeredWallet: getAddress(registered), summary };
    }
    const code = payTo ? Number(await read<number>(gated.address, policyWalletAbi, 'checkPayee', [payTo, claimed !== null, BigInt(claimed ?? 0)])) : -1;
    const payable = code === 0;
    const reason = payable ? undefined : code < 0 ? 'NOT_CONFIGURED' : reasonName(code);
    const snap = { time, block: Number(latest), count: summary?.count ?? 0, average: summary?.average ?? '0', decimals: summary?.decimals ?? 0, payable, reason };
    const change = statusChange(e.key, claimed, prev?.snapshots.at(-1), snap);
    if (change) statusRows.push(change);
    const snapshots = appendSnapshot(prev?.snapshots ?? [], snap);
    services.push({ ...view, payable, reason, since: sinceOf(snapshots), snapshots });
  }
  gated.events = mergeEvents(gated.events, statusRows, new Map());
  console.error(`✓ trust: rule ${enabled ? 'on' : 'off'} (${minAverage}+ from ${minCount}), ${services.length} services, registries ${pinnedOk ? 'pinned' : 'CHANGED'}`);
}

const history: History = { network: NETWORK, generatedAt: new Date().toISOString(), lastBlock: Number(latest), wallets, erc8004, reputationRule, services };
mkdirSync(new URL('.', OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(history, null, 2) + '\n');
console.error(`✓ history.json written at block ${latest}`);
