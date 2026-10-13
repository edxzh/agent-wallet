/**
 * Gas runway for the scheduled run's accounts (pure, unit-tested). Each scheduled run reads the
 * balances at its start and end, so the burn per run measures itself; an account is low when it
 * has fewer than `minRuns` runs of gas left, or (when nothing was spent this run, e.g. the
 * operator, which runs never use) when it is below its floor.
 */
export type GasAccount = {
  name: string;
  address: string;
  /** Wei, at the end of the run. */
  balance: bigint;
  /** Wei, at the start of the run, if it was recorded. */
  startBalance?: bigint;
  /** Wei: warn below this when the burn can't be measured. */
  floor: bigint;
};

export type GasVerdict = {
  name: string;
  address: string;
  balance: bigint;
  /** Wei spent during this run (0 if not measured or nothing was spent). */
  burn: bigint;
  /** Whole runs left at this run's burn, or undefined if nothing was spent. */
  runsLeft?: number;
  low: boolean;
  reason?: string;
};

export const MIN_RUNS = 8; // about 2 days at four scheduled runs a day

export function assessGas(accounts: GasAccount[], minRuns = MIN_RUNS): GasVerdict[] {
  return accounts.map((a) => {
    const burn = a.startBalance !== undefined && a.startBalance > a.balance ? a.startBalance - a.balance : 0n;
    if (burn > 0n) {
      const runsLeft = Number(a.balance / burn);
      const low = runsLeft < minRuns;
      return { name: a.name, address: a.address, balance: a.balance, burn, runsLeft, low, reason: low ? `about ${runsLeft} run(s) of gas left` : undefined };
    }
    const low = a.balance < a.floor;
    return { name: a.name, address: a.address, balance: a.balance, burn, low, reason: low ? 'below its minimum balance' : undefined };
  });
}

const eth = (wei: bigint) => {
  const s = wei.toString().padStart(19, '0');
  return `${s.slice(0, -18)}.${s.slice(-18, -12)}`.replace(/^0+(?=\d)/, '') + ' ETH';
};

/** A Markdown table for the job summary and the alert issue. */
export function gasReport(verdicts: GasVerdict[]): string {
  const rows = verdicts.map(
    (v) =>
      `| ${v.low ? '⚠️' : '✓'} ${v.name} | \`${v.address}\` | ${eth(v.balance)} | ${v.burn > 0n ? eth(v.burn) : '–'} | ${v.runsLeft ?? '–'} |`,
  );
  return ['| Account | Address | Balance | Spent this run | Runs left |', '|---|---|---|---|---|', ...rows].join('\n');
}
