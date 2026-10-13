/**
 * Gas check for the scheduled run (read-only, no keys).
 *   npx tsx scripts/check-gas.ts --start   record the balances at the start of the run
 *   npx tsx scripts/check-gas.ts           compare, print the runway, flag low accounts
 * In GitHub Actions it also writes the table to the job summary, sets the step output `low`, and
 * writes gas-alert.md for the alert issue. Never fails the run: a low balance is a warning.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { getAddress, parseEther, type Address } from 'viem';
import { guardedPublicClient } from '../packages/agent/src/chain.js';
import { loadConfig, readDeployments } from '../packages/agent/src/config.js';
import { policyWalletAbi } from '../packages/agent/src/abi.js';
import { assessGas, gasReport } from './lib/gas.js';

const START = new URL('../.gas-start.json', import.meta.url);
const pub = await guardedPublicClient(loadConfig().rpcUrl);
const d = readDeployments();
const bot = d.wallets.find((w) => w.name === 'research-bot-01') ?? d.wallets[0]!;
const worker = d.wallets.find((w) => w.name === 'worker-bot-01');
const operator = getAddress((await pub.readContract({ address: bot.address, abi: policyWalletAbi, functionName: 'operator' })) as Address);

// Floors apply when a run spends nothing from the account (the operator never pays for runs).
const accounts: { name: string; address: Address; floor: bigint }[] = [
  { name: `agent key (${bot.name}, pays every run)`, address: getAddress(bot.agent), floor: parseEther('0.00015') },
  ...(worker ? [{ name: `worker key (${worker.name}, pays its deliveries)`, address: getAddress(worker.agent), floor: parseEther('0.00002') }] : []),
  { name: 'operator (setup and rule changes, by hand)', address: operator, floor: parseEther('0.00001') },
];
const balances = Object.fromEntries(await Promise.all(accounts.map(async (a) => [a.address, await pub.getBalance({ address: a.address })] as const)));

if (process.argv.includes('--start')) {
  writeFileSync(START, JSON.stringify(Object.fromEntries(Object.entries(balances).map(([k, v]) => [k, v.toString()]))));
  console.error(`✓ gas: start balances recorded for ${accounts.length} accounts`);
  process.exit(0);
}

const start: Record<string, string> = existsSync(START) ? JSON.parse(readFileSync(START, 'utf8')) : {};
const verdicts = assessGas(
  accounts.map((a) => ({ ...a, balance: balances[a.address]!, startBalance: start[a.address] !== undefined ? BigInt(start[a.address]!) : undefined })),
);
const table = gasReport(verdicts);
const low = verdicts.filter((v) => v.low);
console.log(table);
for (const v of low) console.log(`::warning title=Gas low::${v.name} ${v.address}: ${v.reason}. Top it up from a Base Sepolia faucet.`);

if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Gas\n\n${table}\n`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `low=${low.length > 0}\n`);
if (low.length) {
  writeFileSync(
    new URL('../gas-alert.md', import.meta.url),
    [
      `The scheduled agent run found ${low.length === 1 ? 'an account' : `${low.length} accounts`} low on Base Sepolia ETH (test network, no real money):`,
      '',
      ...low.map((v) => `- **${v.name}** \`${v.address}\`: ${v.reason}`),
      '',
      table,
      '',
      'Top up from a Base Sepolia faucet. A run that runs out of gas fails part-way and the dashboard stops updating.',
      '',
      `Checked ${new Date().toISOString().slice(0, 16)}Z. This issue is updated by each run while any account stays low; close it once topped up.`,
    ].join('\n'),
  );
}
