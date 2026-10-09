/**
 * How a payee's claimed ERC-8004 identity reaches the wallet (research R3): services put
 * `{ agentRegistry, agentId }` in the selected x402 requirement's `extra.erc8004`. A hook reads it
 * before the payment is created; the policy signer then calls authorizeWithIdentity.
 */
import { getAddress, isAddress } from 'viem';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { x402Client } from '@x402/fetch';
import { NETWORK } from './config.js';
import { IDENTITY_REGISTRY, ERC8004 } from './registries.js';
import { createPolicyWalletSigner, type PolicyWalletSignerOptions } from './signer.js';

/** The claimed agentId, or undefined when unclaimed, malformed, or naming another registry. */
export function parseErc8004Claim(extra: unknown): bigint | undefined {
  const claim = (extra as { erc8004?: { agentRegistry?: unknown; agentId?: unknown } } | undefined)?.erc8004;
  if (!claim || typeof claim.agentRegistry !== 'string' || typeof claim.agentId !== 'string') return undefined;
  const parts = claim.agentRegistry.split(':'); // eip155:<chainId>:<address>
  if (parts.length !== 3 || parts[0] !== 'eip155' || parts[1] !== String(ERC8004.chainId) || !isAddress(parts[2]!)) return undefined;
  if (getAddress(parts[2]!) !== IDENTITY_REGISTRY) return undefined;
  if (!/^(0|[1-9]\d{0,76})$/.test(claim.agentId)) return undefined;
  return BigInt(claim.agentId);
}

/** Per request: the claim seen by the hook, read by the signer. */
export type ClaimState = { agentId?: bigint };

/** An onBeforePaymentCreation hook that records the claimed agentId. Never aborts. */
export function erc8004Hook(state: ClaimState) {
  return async (ctx: { selectedRequirements: { extra?: Record<string, unknown> } }) => {
    state.agentId = parseErc8004Claim(ctx.selectedRequirements.extra);
  };
}

/**
 * An x402 client paying from the PolicyWallet: with a claimed identity the signer calls
 * authorizeWithIdentity(…, agentId), otherwise 001's authorize(…). Returns the claim state so
 * callers can tell whether the payment had an identity.
 */
export function createPolicyWalletClient(opts: PolicyWalletSignerOptions) {
  const state: ClaimState = {};
  const signer = createPolicyWalletSigner({ ...opts, claim: () => state.agentId });
  const client = new x402Client().register(NETWORK, new ExactEvmScheme(signer as never)).onBeforePaymentCreation(erc8004Hook(state) as never);
  return { client, state, signer };
}
