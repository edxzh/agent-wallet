import { describe, expect, it } from 'vitest';
import { assessGas, gasReport, MIN_RUNS } from './lib/gas.js';

const e = (x: number) => BigInt(Math.round(x * 1e12)) * 1_000_000n; // ETH with 12-digit precision → wei

describe('assessGas', () => {
  it('measures runs left from this run’s burn', () => {
    const [v] = assessGas([{ name: 'agent', address: '0xa', balance: e(0.000384), startBalance: e(0.00043), floor: e(0.00015) }]);
    expect(v!.burn).toBe(e(0.000046));
    expect(v!.runsLeft).toBe(8);
    expect(v!.low).toBe(false);
  });

  it(`is low below ${MIN_RUNS} runs`, () => {
    const [v] = assessGas([{ name: 'agent', address: '0xa', balance: e(0.0003), startBalance: e(0.000346), floor: 0n }]);
    expect(v!.runsLeft).toBe(6);
    expect(v!.low).toBe(true);
    expect(v!.reason).toBe('about 6 run(s) of gas left');
  });

  it('falls back to the floor when nothing was spent (e.g. the operator)', () => {
    const [ok, low] = assessGas([
      { name: 'worker', address: '0xb', balance: e(0.0002), startBalance: e(0.0002), floor: e(0.00002) },
      { name: 'operator', address: '0xc', balance: e(0.000008), floor: e(0.00001) },
    ]);
    expect(ok).toMatchObject({ low: false, burn: 0n });
    expect(ok!.runsLeft).toBeUndefined();
    expect(low).toMatchObject({ low: true, reason: 'below its minimum balance' });
  });

  it('a balance that went up (a top-up mid-run) is not a burn', () => {
    const [v] = assessGas([{ name: 'agent', address: '0xa', balance: e(0.001), startBalance: e(0.0004), floor: e(0.00015) }]);
    expect(v).toMatchObject({ burn: 0n, low: false });
  });
});

describe('gasReport', () => {
  it('renders one row per account, flagging the low ones', () => {
    const md = gasReport(assessGas([
      { name: 'agent', address: '0xa', balance: e(0.0003), startBalance: e(0.000346), floor: 0n },
      { name: 'operator', address: '0xc', balance: e(0.00002), floor: e(0.00001) },
    ]));
    expect(md).toContain('| ⚠️ agent | `0xa` | 0.000300 ETH | 0.000046 ETH | 6 |');
    expect(md).toContain('| ✓ operator | `0xc` | 0.000020 ETH | – | – |');
  });
});
