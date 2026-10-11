/**
 * Live check for the "try to make it overspend" page (specs/003-try-to-overspend, SC-001): dry-runs
 * every preset against research-bot-01 on Base Sepolia, as the page does, and compares the
 * contract's answers with what today's snapshot says they should be. Read-only: no key, nothing sent.
 *   npx tsx scripts/check-try.ts
 */
import history from '../apps/dashboard/src/data/history.json' with { type: 'json' };
import { attacksFor, targetWallet } from '../apps/dashboard/src/lib/attacks.ts';
import type { History } from '../apps/dashboard/src/lib/history.ts';
import { dryRun } from '../apps/dashboard/src/lib/simulate.ts';

const h = history as unknown as History;
const wallet = targetWallet(h)!;
let bad = 0;
for (const a of attacksFor(h)) {
  const res = await dryRun(wallet.address, a.payments);
  const got = res.answers.map((x) => ('reason' in x ? x.reason : `ERROR ${x.error}`));
  const ok = a.expect.every((e, i) => e === '*' || e === got[i]);
  if (!ok) bad++;
  console.log(`${ok ? '✓' : '✗'} ${a.id.padEnd(9)} block ${res.block}  ${got.join(', ')}${ok ? '' : `  (expected ${a.expect.join(', ')})`}`);
}
process.exit(bad ? 1 : 0);
