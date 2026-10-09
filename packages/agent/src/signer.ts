import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  isAddressEqual,
  parseEventLogs,
  zeroHash,
  type Address,
  type Hex,
  type TransactionReceipt,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { policyWalletAbi } from './abi.js';
import { DEFAULT_RPC_URL } from './config.js';
import { reasonName, type Reason } from './reasons.js';

export const AUTHORIZE_CONFIRMATIONS = 3;
/**
 * Gas limit for authorizeWithIdentity. The contract reverts below (IDENTITY_GAS + REGISTRY_GAS)
 * × 64/63 + 200k ≈ 5.38 M of gas left, so an estimate (which only measures what the happy path
 * uses) would be too low. Only the gas actually used is paid.
 */
export const AUTHORIZE_WITH_IDENTITY_GAS = 6_000_000n;

/** Thrown when the wallet refused the payment on-chain. Nothing was signed. */
export class PolicyRefusedError extends Error {
  constructor(
    public readonly reason: ReturnType<typeof reasonName>,
    public readonly nonce: Hex,
    public readonly txHash: Hex,
  ) {
    super(`Payment refused by the policy wallet: ${reason}`);
    this.name = 'PolicyRefusedError';
  }
}

/** Thrown before any transaction when asked to sign something other than a payment from this wallet. */
export class UnexpectedSignRequestError extends Error {
  name = 'UnexpectedSignRequestError';
}

export type TypedDataRequest = {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown>;
};

export type AuthorizedPayment = {
  nonce: Hex;
  payee: Address;
  amount: bigint;
  validBefore: bigint;
  txHash: Hex;
  /** The claimed ERC-8004 identity, when the wallet verified it (PayeeIdentityVerified). */
  agentId?: bigint;
};

type Clients = {
  publicClient: {
    waitForTransactionReceipt(args: { hash: Hex; confirmations?: number }): Promise<Pick<TransactionReceipt, 'logs' | 'status'>>;
  };
  walletClient: { writeContract(args: any): Promise<Hex> };
};

export type PolicyWalletSignerOptions = {
  wallet: Address;
  /** Agent private key. Read from env by callers; never logged. */
  agentKey: Hex;
  taskId?: Hex;
  rpcUrl?: string;
  /** Called after a successful on-chain authorization, before the signature is returned. */
  onAuthorized?: (p: AuthorizedPayment) => void;
  /** Called when the wallet refused on-chain (x402 wraps thrown errors without a cause). */
  onRefused?: (e: PolicyRefusedError) => void;
  /** The payee's claimed ERC-8004 agentId for the current request (from the x402 hook), if any. */
  claim?: () => bigint | undefined;
  /** For tests: injected viem clients. */
  clients?: Clients;
};

/**
 * An x402 `ClientEvmSigner` whose address is the PolicyWallet. Before signing an EIP-3009
 * TransferWithAuthorization it calls `wallet.authorize(...)` on-chain with the agent key.
 * If that emits PaymentRefused it throws PolicyRefusedError and nothing is signed.
 */
export function createPolicyWalletSigner(opts: PolicyWalletSignerOptions) {
  const wallet = getAddress(opts.wallet);
  const account = privateKeyToAccount(opts.agentKey);
  const transport = http(opts.rpcUrl ?? DEFAULT_RPC_URL);
  const clients: Clients = opts.clients ?? {
    publicClient: createPublicClient({ chain: baseSepolia, transport }),
    walletClient: createWalletClient({ account, chain: baseSepolia, transport }),
  };
  const taskId = opts.taskId ?? zeroHash;

  return {
    address: wallet,
    async signTypedData(request: TypedDataRequest): Promise<Hex> {
      if (request.primaryType !== 'TransferWithAuthorization') {
        throw new UnexpectedSignRequestError(`Refusing to sign ${request.primaryType}: only TransferWithAuthorization`);
      }
      const m = request.message;
      if (typeof m.from !== 'string' || !isAddressEqual(m.from as Address, wallet)) {
        throw new UnexpectedSignRequestError(`Refusing to sign a transfer from ${String(m.from)}: not this wallet`);
      }
      const nonce = m.nonce as Hex;
      const payee = getAddress(m.to as string);
      const amount = BigInt(m.value as string | bigint);
      const validAfter = BigInt(m.validAfter as string | bigint);
      const validBefore = BigInt(m.validBefore as string | bigint);

      const agentId = opts.claim?.();
      const txHash = await clients.walletClient.writeContract(
        agentId === undefined
          ? { address: wallet, abi: policyWalletAbi, functionName: 'authorize', args: [nonce, payee, amount, validAfter, validBefore, taskId], account, chain: baseSepolia }
          : {
              address: wallet,
              abi: policyWalletAbi,
              functionName: 'authorizeWithIdentity',
              args: [nonce, payee, amount, validAfter, validBefore, taskId, agentId],
              gas: AUTHORIZE_WITH_IDENTITY_GAS,
              account,
              chain: baseSepolia,
            },
      );
      // Wait for 3 confirmations (~4 s on Base): the facilitator checks isValidSignature on its own
      // node, which may lag a block or two behind ours. Without this it sees no reservation yet and
      // rejects the payment as invalid_exact_evm_signature (observed in T024).
      const receipt = await clients.publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: AUTHORIZE_CONFIRMATIONS });
      if (receipt.status !== 'success') throw new Error(`authorize transaction reverted: ${txHash}`);

      const events = parseEventLogs({ abi: policyWalletAbi, logs: receipt.logs, strict: false });
      const refused = events.find((e) => e.eventName === 'PaymentRefused' && e.args.nonce === nonce);
      if (refused && refused.eventName === 'PaymentRefused') {
        const err = new PolicyRefusedError(reasonName(Number(refused.args.reason)), nonce, txHash);
        opts.onRefused?.(err);
        throw err;
      }
      if (!events.some((e) => e.eventName === 'PaymentAuthorized' && e.args.nonce === nonce)) {
        throw new Error(`No PaymentAuthorized event for nonce ${nonce} in ${txHash}`);
      }
      const verified = events.some((e) => e.eventName === 'PayeeIdentityVerified' && e.args.nonce === nonce);
      opts.onAuthorized?.({ nonce, payee, amount, validBefore, txHash, agentId: verified ? agentId : undefined });
      return account.signTypedData(request as Parameters<typeof account.signTypedData>[0]);
    },
  };
}

export type { Reason };
