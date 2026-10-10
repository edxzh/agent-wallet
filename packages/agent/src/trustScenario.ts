/**
 * The scheduled run for feature 002 (contracts/agent-cli.md, research R5), in order:
 *   1. assertRegistriesPinned: exit 4 before any payment if a registry changed;
 *   2. both scouts pay and rate every open demo service (they keep reputation fresh);
 *   3. 001's scenario on the gated wallet, with its unlisted-payee probe on scout-02;
 *   4. the gated wallet tries reliable, flaky, newcomer, impostor and anonymous.
 * Every expected outcome comes from the wallet's own checkPayee just before the attempt, never
 * hard-coded, and every settled payment with a verified identity is rated.
 */
import { getAddress, zeroHash, type Address } from 'viem';
import type { PayOutcome } from './pay.js';
import type { RateDecision } from './rate.js';
import type { Reason } from './reasons.js';
import { RegistryChangedError } from './registries.js';
import { EXIT } from './scenario.js';
import { expectedOutcome, type WalletState } from './state.js';

/** What a service's unpaid request says: its 402 requirement, or that it's closed. */
export type Requirement = { open: true; payTo: Address; agentId?: bigint } | { open: false; status: number };

export type TrustDeps = {
  assertPinned(): Promise<void>;
  /** The demo services the agent tries, by key, with their URLs. */
  services: { key: string; url: string }[];
  scouts: { name: string; wallet: Address }[];
  gated: Address;
  requirement(url: string): Promise<Requirement>;
  readState(wallet: Address): Promise<WalletState>;
  checkPayee(wallet: Address, payee: Address, agentId: bigint | undefined): Promise<Reason | string>;
  pay(wallet: Address, url: string): Promise<PayOutcome>;
  rate(wallet: Address, out: PayOutcome, url: string): Promise<RateDecision>;
  /** 001's scenario on the gated wallet (its unlisted probe on scout-02, its payments rated). */
  run001(rateSettled: (out: Extract<PayOutcome, { kind: 'settled' }>, url: string) => Promise<boolean>): Promise<number>;
  quoteAmount: bigint;
  log(line: Record<string, unknown>): void;
};

export const SCOUT_SERVICES = ['reliable', 'flaky', 'newcomer'];
export const GATED_SERVICES = ['reliable', 'flaky', 'newcomer', 'impostor', 'anonymous'];

/**
 * The contract's full check order given checkPayee's scope result: PAUSED and INVALID_AMOUNT come
 * first, then the scope (step 3), then cap, task, daily budget and funds.
 */
export function expectedWithScope(s: WalletState, a: { payee: Address; amount: bigint; validBefore: bigint }, scope: Reason | string): Reason | string {
  const rest = expectedOutcome({ ...s, payees: { ...s.payees, [getAddress(a.payee)]: true } }, { ...a, taskId: zeroHash });
  if (rest === 'PAUSED' || rest === 'INVALID_AMOUNT') return rest;
  return scope !== 'NONE' ? scope : rest;
}

export async function runTrustScenario(d: TrustDeps): Promise<number> {
  try {
    await d.assertPinned();
  } catch (e) {
    if (e instanceof RegistryChangedError) {
      d.log({ step: 'stop', reason: 'ERC-8004 registry changed: demo paused for review', registry: e.registry, expected: e.expected, actual: e.actual });
      return EXIT.REGISTRY_CHANGED;
    }
    throw e;
  }

  let mismatches = 0;
  let outOfFunds = false;
  const url = (key: string) => d.services.find((s) => s.key === key)?.url;

  const rateIfVerified = async (wallet: Address, out: PayOutcome, u: string, step: string) => {
    if (out.kind !== 'settled' || out.agentId === undefined) return true;
    try {
      const r = await d.rate(wallet, out, u);
      d.log({ step: `rate ${step}`, wallet, ...(r.kind === 'rated' ? { score: r.score, tag: r.tag, feedbackIndex: r.feedbackIndex, tx: r.txHash } : r) });
      return r.kind === 'rated';
    } catch (e) {
      d.log({ step: `rate ${step}`, wallet, ok: false, error: (e as Error).message });
      return false;
    }
  };

  /** One attempt: read the requirement, predict with checkPayee, pay, compare, rate. */
  const attempt = async (who: string, wallet: Address, key: string) => {
    const u = url(key);
    if (!u) return;
    const req = await d.requirement(u);
    const step = `${who} → ${key}`;
    if (!req.open) {
      d.log({ step, skipped: `service answered ${req.status} (not open)` });
      return;
    }
    const s = await d.readState(wallet);
    const scope = await d.checkPayee(wallet, req.payTo, req.agentId);
    const expected = expectedWithScope(s, { payee: req.payTo, amount: d.quoteAmount, validBefore: s.now + 300n }, scope);
    const out = await d.pay(wallet, u);
    const actual = out.kind === 'settled' ? 'NONE' : out.kind === 'refused' ? out.reason : `FAILED: ${out.error}`;
    const ok = actual === expected;
    if (!ok) mismatches++;
    if (actual === 'INSUFFICIENT_FUNDS') outOfFunds = true;
    const failure = out.kind === 'failed' ? { status: out.status, authorizeTx: out.authorizeTx, diagnostics: out.diagnostics } : {};
    d.log({ step, wallet, expected, actual, ok, agentId: req.agentId, nonce: out.nonce, settlementTx: out.kind === 'settled' ? out.settlementTx : undefined, ...failure });
    if (!(await rateIfVerified(wallet, out, u, step))) mismatches++;
  };

  // 2. Scouts first, so a newcomer's first ratings land before the gated wallet tries it.
  for (const scout of d.scouts) for (const key of SCOUT_SERVICES) await attempt(scout.name, scout.wallet, key);

  // 3. 001's scenario (exit 3 stops it; any other non-zero is a mismatch already logged).
  // Rate against the URL actually paid (its pair), or a good quote scores as wrong-data.
  const code001 = await d.run001((out, paidUrl) => rateIfVerified(d.gated, out, paidUrl, 'gated → quote'));
  if (code001 === EXIT.INSUFFICIENT_FUNDS) return EXIT.INSUFFICIENT_FUNDS;
  if (code001 !== EXIT.OK) mismatches++;

  // 4. The gated wallet against every demo service.
  for (const key of GATED_SERVICES) await attempt('gated', d.gated, key);

  d.log({ step: 'trust done', mismatches });
  if (outOfFunds) return EXIT.INSUFFICIENT_FUNDS;
  return mismatches === 0 ? EXIT.OK : EXIT.MISMATCH;
}

