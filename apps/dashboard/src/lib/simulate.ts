/**
 * Dry run of the wallet's authorize call (specs/003-try-to-overspend). A public Base Sepolia node
 * runs the deployed contract on its latest state with `eth_simulateV1`, sent from the agent's
 * address, and returns the event the contract would emit. No key, no signature, no transaction:
 * nothing is written and no money moves.
 */
import { decodeEventLog, decodeFunctionResult, encodeFunctionData, parseAbi, type Hex } from 'viem';
import type { Payment } from './attacks';

export const RPC = 'https://sepolia.base.org';
export const CHAIN_ID = 84532;
const ZERO = `0x${'0'.repeat(64)}` as Hex;

const abi = parseAbi([
  'function agent() view returns (address)',
  'function authorize(bytes32 nonce, address payee, uint256 amount, uint256 validAfter, uint256 validBefore, bytes32 taskId) returns (bool)',
  'function authorizeWithIdentity(bytes32 nonce, address payee, uint256 amount, uint256 validAfter, uint256 validBefore, bytes32 taskId, uint256 payeeAgentId) returns (bool)',
  'event PaymentAuthorized(bytes32 indexed nonce, address indexed payee, bytes32 indexed taskId, uint256 amount, uint256 validBefore, bytes32 digest)',
  'event PaymentRefused(bytes32 indexed nonce, address indexed payee, bytes32 indexed taskId, uint256 amount, uint8 reason)',
]);

/** contracts/src/Reason.sol, append only. */
export const REASONS = [
  'NONE', 'PAUSED', 'INVALID_AMOUNT', 'PAYEE_NOT_ALLOWED', 'OVER_PER_PAYMENT_CAP', 'OVER_TASK_BUDGET', 'OVER_DAILY_BUDGET', 'INSUFFICIENT_FUNDS',
  'PAYEE_IDENTITY_UNVERIFIED', 'PAYEE_IDENTITY_MISMATCH', 'REPUTATION_UNAVAILABLE', 'NOT_ENOUGH_TRUSTED_REVIEWS', 'PAYEE_REPUTATION_TOO_LOW',
] as const;

/** One payment's answer: `NONE` means the contract would authorize it. */
export type Answer = { reason: string } | { error: string };
export type DryRun = { block: number; answers: Answer[] };

let rpcId = 0;
async function rpc<T>(method: string, params: unknown[], fetchImpl: typeof fetch): Promise<T> {
  const res = await fetchImpl(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  const json = (await res.json()) as { result?: T; error?: { message?: string } };
  if (json.error || json.result === undefined) throw new Error(json.error?.message ?? `${method} failed`);
  return json.result;
}

function randomNonce(): Hex {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return `0x${[...b].map((x) => x.toString(16).padStart(2, '0')).join('')}` as Hex;
}

function callData(p: Payment, validBefore: bigint): Hex {
  const base = [randomNonce(), p.payee as Hex, BigInt(p.amount), 0n, validBefore, (p.taskId ?? ZERO) as Hex] as const;
  return p.claim === null
    ? encodeFunctionData({ abi, functionName: 'authorize', args: base })
    : encodeFunctionData({ abi, functionName: 'authorizeWithIdentity', args: [...base, BigInt(p.claim)] });
}

type SimCall = { status: Hex; logs: { topics: Hex[]; data: Hex }[]; error?: { message?: string } };

/** Ask the contract what it would do with these payments, in order, in one block. */
export async function dryRun(wallet: string, payments: Payment[], fetchImpl: typeof fetch = fetch): Promise<DryRun> {
  // Testnet only (constitution I): never simulate anywhere else.
  const chain = Number(await rpc<Hex>('eth_chainId', [], fetchImpl));
  if (chain !== CHAIN_ID) throw new Error(`refusing to run on chain ${chain}`);
  const [agentRaw, latest] = await Promise.all([
    rpc<Hex>('eth_call', [{ to: wallet, data: encodeFunctionData({ abi, functionName: 'agent' }) }, 'latest'], fetchImpl),
    rpc<{ number: Hex; timestamp: Hex }>('eth_getBlockByNumber', ['latest', false], fetchImpl),
  ]);
  const agent = decodeFunctionResult({ abi, functionName: 'agent', data: agentRaw });
  const validBefore = BigInt(latest.timestamp) + 600n;
  const calls = payments.map((p) => ({ from: agent, to: wallet, data: callData(p, validBefore) }));
  const blocks = await rpc<{ number: Hex; calls: SimCall[] }[]>('eth_simulateV1', [{ blockStateCalls: [{ calls }] }, 'latest'], fetchImpl);
  const sim = blocks[0];
  if (!sim || sim.calls.length !== payments.length) throw new Error('unexpected simulation result');
  return { block: Number(sim.number), answers: sim.calls.map(answerOf) };
}

function answerOf(c: SimCall): Answer {
  if (c.status !== '0x1') return { error: c.error?.message ?? 'reverted' };
  for (const log of c.logs) {
    try {
      const e = decodeEventLog({ abi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      if (e.eventName === 'PaymentAuthorized') return { reason: 'NONE' };
      if (e.eventName === 'PaymentRefused') return { reason: REASONS[e.args.reason] ?? `REASON_${e.args.reason}` };
    } catch {
      // Another event (e.g. PayeeIdentityVerified): keep looking.
    }
  }
  return { error: 'no payment event' };
}
