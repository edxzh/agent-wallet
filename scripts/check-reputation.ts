/**
 * FR-015 / SC-005: every trusted average and count on the dashboard equals the registry. For each
 * service in history.json, re-reads getSummary(agentId, trustedReviewers, "", "") at the snapshot's
 * block and exits 1 on any difference. Read-only. Usage: npx tsx scripts/check-reputation.ts
 */
import { readFileSync } from 'node:fs';
import { guardedPublicClient } from '../packages/agent/src/chain.js';
import { loadConfig } from '../packages/agent/src/config.js';
import { policyWalletAbi } from '../packages/agent/src/abi.js';
import { REPUTATION_REGISTRY, reputationAbi } from '../packages/agent/src/registries.js';
import type { History } from './lib/history.js';

const history: History = JSON.parse(readFileSync(new URL('../apps/dashboard/src/data/history.json', import.meta.url), 'utf8'));
if (!history.services?.length || !history.reputationRule) {
  console.error('✓ check-reputation: no trusted-payee data in history.json, nothing to check');
  process.exit(0);
}
const pub = await guardedPublicClient(loadConfig().rpcUrl);
let differences = 0;
for (const s of history.services) {
  if (!s.summary || s.agentId === null) continue;
  const blockNumber = BigInt(s.summary.block);
  const trusted = (await pub.readContract({ address: history.reputationRule.wallet, abi: policyWalletAbi, functionName: 'trustedReviewers', blockNumber })) as readonly `0x${string}`[];
  const [count, average, decimals] = trusted.length
    ? await pub.readContract({ address: REPUTATION_REGISTRY, abi: reputationAbi, functionName: 'getSummary', args: [BigInt(s.agentId), trusted, '', ''], blockNumber })
    : [0n, 0n, 0];
  const same = Number(count) === s.summary.count && average.toString() === s.summary.average && Number(decimals) === s.summary.decimals;
  console.error(`${same ? '✓' : '✗'} ${s.key} #${s.agentId} @${s.summary.block}: page ${s.summary.count} × ${s.summary.average}, registry ${count} × ${average}`);
  if (!same) differences++;
}
if (differences) {
  console.error(`✗ check-reputation: ${differences} service(s) differ from the registry`);
  process.exit(1);
}
console.error('✓ check-reputation: dashboard numbers equal the registry');
