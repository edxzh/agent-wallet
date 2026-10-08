/**
 * Builds apps/dashboard/src/data/history.json from Base Sepolia (contracts/dashboard.md).
 * Incremental: resumes from `lastBlock + 1`, fetches logs in ≤ 500-block chunks (public RPC limit),
 * reads current views, merges, caps at 500 events per wallet. Read-only: no keys needed.
 *
 * Usage: npm run snapshot
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { getAddress, isAddress, type Log } from 'viem';
import { blockRanges, formatUsdc, guardedPublicClient, usdcAbi } from '../packages/agent/src/chain.js';
import { loadConfig, NETWORK, readDeployments, readPayees, USDC } from '../packages/agent/src/config.js';
import { readWalletState } from '../packages/agent/src/state.js';
import { decodeWalletLogs, mergeEvents, settlementsFrom, type History, type WalletHistory } from './lib/history.js';

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

const history: History = { network: NETWORK, generatedAt: new Date().toISOString(), lastBlock: Number(latest), wallets };
mkdirSync(new URL('.', OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(history, null, 2) + '\n');
console.error(`✓ history.json written at block ${latest}`);
