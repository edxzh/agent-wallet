import { getAddress, keccak256, toBytes, zeroHash, type Address, type Hex } from 'viem';
import { policyWalletAbi } from './abi.js';
import { USDC } from './config.js';
import { usdcAbi, type PublicClient } from './chain.js';
import type { Reason } from './reasons.js';

export const taskIdOf = (label: string): Hex => keccak256(toBytes(label));

export type WalletState = {
  paused: boolean;
  perPaymentCap: bigint;
  dailyBudget: bigint;
  spentToday: bigint;
  day: bigint;
  balance: bigint;
  tasks: Record<Hex, { budget: bigint; spent: bigint }>;
  payees: Record<Address, boolean>;
  now: bigint;
};

/** Reads the parts of a wallet's state that decide an attempt's outcome. */
export async function readWalletState(
  client: PublicClient,
  wallet: Address,
  taskIds: Hex[],
  payees: Address[],
): Promise<WalletState> {
  const block = await client.getBlock();
  const now = block.timestamp;
  const day = now / 86400n;
  const read = <T>(functionName: string, args: unknown[] = []) =>
    client.readContract({ address: wallet, abi: policyWalletAbi, functionName, args, blockNumber: block.number } as never) as Promise<T>;
  const [paused, perPaymentCap, dailyBudget, spentToday, balance] = await Promise.all([
    read<boolean>('paused'),
    read<bigint>('perPaymentCap'),
    read<bigint>('dailyBudget'),
    read<bigint>('spentOn', [day]),
    client.readContract({ address: USDC, abi: usdcAbi, functionName: 'balanceOf', args: [wallet], blockNumber: block.number }),
  ]);
  const tasks: WalletState['tasks'] = {};
  for (const id of taskIds) {
    const [budget, spent] = await read<[bigint, bigint]>('task', [id]);
    tasks[id] = { budget, spent };
  }
  const payeeMap: WalletState['payees'] = {};
  for (const p of payees) payeeMap[getAddress(p)] = await read<boolean>('isPayeeAllowed', [p]);
  return { paused, perPaymentCap, dailyBudget, spentToday, day, balance, tasks, payees: payeeMap, now };
}

/** Mirrors PolicyWallet._check (data-model.md order). Returns the reason the contract will give. */
export function expectedOutcome(
  s: WalletState,
  a: { payee: Address; amount: bigint; validBefore: bigint; taskId: Hex },
): Reason {
  if (s.paused) return 'PAUSED';
  if (a.amount === 0n || a.validBefore <= s.now) return 'INVALID_AMOUNT';
  if (!s.payees[getAddress(a.payee)]) return 'PAYEE_NOT_ALLOWED';
  if (a.amount > s.perPaymentCap) return 'OVER_PER_PAYMENT_CAP';
  if (a.taskId !== zeroHash) {
    const t = s.tasks[a.taskId] ?? { budget: 0n, spent: 0n };
    if (t.spent + a.amount > t.budget) return 'OVER_TASK_BUDGET';
  }
  if (s.spentToday + a.amount > s.dailyBudget) return 'OVER_DAILY_BUDGET';
  if (s.balance < a.amount) return 'INSUFFICIENT_FUNDS';
  return 'NONE';
}
