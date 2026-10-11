/**
 * Hiring another agent through the job escrow (specs/004-agent-hires-agent). The funding step is
 * the existing PolicyWallet signer: it calls `wallet.authorize(…, payee = escrow, …)` on-chain and
 * throws PolicyRefusedError if any rule refuses, so nothing is signed. Then `escrow.open` asks the
 * wallet about the worker (allowlist / identity / reputation) and pulls the money, or records a
 * JobRefused event and moves nothing.
 */
import { encodeAbiParameters, getAddress, keccak256, parseEventLogs, toHex, type Address, type Hex, type TransactionReceipt } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { jobEscrowAbi } from './abi.js';
import { USDC } from './config.js';
import { reasonName } from './reasons.js';
import { createPolicyWalletSigner, type PolicyWalletSignerOptions } from './signer.js';

export const OUTCOMES = ['NONE', 'ACCEPTED', 'REVIEW_TIMEOUT', 'ARBITER_PAID', 'DELIVERY_TIMEOUT', 'ARBITER_REFUNDED', 'ARBITER_TIMEOUT'] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** USDC's EIP-712 domain on Base Sepolia (FiatToken v2.2). */
export const USDC_DOMAIN = { name: 'USDC', version: '2', chainId: baseSepolia.id, verifyingContract: USDC } as const;

export type JobTerms = {
  worker: Address;
  /** The worker's ERC-8004 agentId, if it claims one. */
  workerAgentId?: bigint;
  arbiter: Address;
  amount: bigint;
  /** Seconds from now. */
  deliverIn: number;
  reviewWindow: number;
  disputeWindow: number;
  /** What the hirer asks for; only its hash goes on-chain. */
  spec: string;
};

export type HireOutcome =
  | { kind: 'opened'; jobId: Hex; nonce: Hex; authorizeTx: Hex; openTx: Hex }
  | { kind: 'refused-by-wallet'; reason: string; nonce: Hex; authorizeTx: Hex }
  | { kind: 'refused-worker'; reason: string; jobId: Hex; nonce: Hex; authorizeTx: Hex; openTx: Hex };

type Clients = NonNullable<PolicyWalletSignerOptions['clients']> & {
  publicClient: { waitForTransactionReceipt(args: { hash: Hex; confirmations?: number }): Promise<Pick<TransactionReceipt, 'logs' | 'status'>> };
};

/** Same as JobEscrow.jobIdFor: keccak256(abi.encode(client, nonce)). */
export const jobIdFor = (client: Address, nonce: Hex): Hex =>
  keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [getAddress(client), nonce]));

export const hashText = (s: string): Hex => keccak256(toHex(s));

/** The EIP-3009 request the hirer's wallet signs: from = wallet, to = escrow. */
export function fundingRequest(a: { wallet: Address; escrow: Address; amount: bigint; validBefore: bigint; nonce: Hex }) {
  return {
    domain: USDC_DOMAIN,
    types: {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'TransferWithAuthorization',
    message: { from: getAddress(a.wallet), to: getAddress(a.escrow), value: a.amount, validAfter: 0n, validBefore: a.validBefore, nonce: a.nonce },
  };
}

export async function hireAgent(opts: {
  wallet: Address;
  escrow: Address;
  agentKey: Hex;
  terms: JobTerms;
  nonce: Hex;
  /** Current chain time, in seconds. */
  now: bigint;
  taskId?: Hex;
  rpcUrl?: string;
  clients?: Clients;
}): Promise<HireOutcome> {
  const { terms } = opts;
  const account = privateKeyToAccount(opts.agentKey);
  const validBefore = opts.now + 300n;
  let authorizeTx: Hex | undefined;
  const signer = createPolicyWalletSigner({
    wallet: opts.wallet,
    agentKey: opts.agentKey,
    taskId: opts.taskId,
    rpcUrl: opts.rpcUrl,
    clients: opts.clients,
    onAuthorized: (p) => (authorizeTx = p.txHash),
  });

  let signature: Hex;
  try {
    signature = await signer.signTypedData(fundingRequest({ wallet: opts.wallet, escrow: opts.escrow, amount: terms.amount, validBefore, nonce: opts.nonce }));
  } catch (e) {
    const err = e as { reason?: string; txHash?: Hex };
    if (err.reason && err.txHash) return { kind: 'refused-by-wallet', reason: err.reason, nonce: opts.nonce, authorizeTx: err.txHash };
    throw e;
  }
  if (!opts.clients) throw new Error('hireAgent needs viem clients for the open call');

  const openTx = await opts.clients.walletClient.writeContract({
    address: getAddress(opts.escrow),
    abi: jobEscrowAbi,
    functionName: 'open',
    args: [
      {
        client: getAddress(opts.wallet),
        nonce: opts.nonce,
        amount: terms.amount,
        validBefore,
        signature,
        worker: getAddress(terms.worker),
        workerHasClaim: terms.workerAgentId !== undefined,
        workerAgentId: terms.workerAgentId ?? 0n,
        arbiter: getAddress(terms.arbiter),
        deliverBy: opts.now + BigInt(terms.deliverIn),
        reviewWindow: terms.reviewWindow,
        disputeWindow: terms.disputeWindow,
        specHash: hashText(terms.spec),
      },
    ],
    account,
    chain: baseSepolia,
  });
  const receipt = await opts.clients.publicClient.waitForTransactionReceipt({ hash: openTx });
  if (receipt.status !== 'success') throw new Error(`open transaction reverted: ${openTx}`);
  const jobId = jobIdFor(opts.wallet, opts.nonce);
  const events = parseEventLogs({ abi: jobEscrowAbi, logs: receipt.logs, strict: false });
  const refused = events.find((e) => e.eventName === 'JobRefused' && e.args.jobId === jobId);
  if (refused && refused.eventName === 'JobRefused') {
    return { kind: 'refused-worker', reason: reasonName(Number(refused.args.reason)), jobId, nonce: opts.nonce, authorizeTx: authorizeTx!, openTx };
  }
  if (!events.some((e) => e.eventName === 'JobOpened' && e.args.jobId === jobId)) throw new Error(`No JobOpened event for ${jobId} in ${openTx}`);
  return { kind: 'opened', jobId, nonce: opts.nonce, authorizeTx: authorizeTx!, openTx };
}

/** Names a JobClosed outcome code. */
export const outcomeName = (code: number): Outcome | `UNKNOWN_${number}` => OUTCOMES[code] ?? `UNKNOWN_${code}`;
