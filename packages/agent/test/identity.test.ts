import { describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, getAddress, zeroHash, type Hex } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { policyWalletAbi } from '../src/abi.js';
import { erc8004Hook, parseErc8004Claim, type ClaimState } from '../src/identity.js';
import { IDENTITY_REGISTRY_CAIP10 } from '../src/registries.js';
import { AUTHORIZE_WITH_IDENTITY_GAS, createPolicyWalletSigner, PolicyRefusedError, type AuthorizedPayment } from '../src/signer.js';

const wallet = getAddress('0x00000000000000000000000000000000000000aa');
const payee = getAddress('0x00000000000000000000000000000000000000bb');
const nonce = ('0x' + '22'.repeat(32)) as Hex;
const txHash = ('0x' + 'cd'.repeat(32)) as Hex;

describe('parseErc8004Claim (research R3)', () => {
  const extra = (agentRegistry: unknown, agentId: unknown) => ({ name: 'USDC', version: '2', erc8004: { agentRegistry, agentId } });
  it('parses a decimal agentId for the pinned registry, including "0"', () => {
    expect(parseErc8004Claim(extra(IDENTITY_REGISTRY_CAIP10, '7'))).toBe(7n);
    expect(parseErc8004Claim(extra(IDENTITY_REGISTRY_CAIP10, '0'))).toBe(0n);
    expect(parseErc8004Claim(extra(IDENTITY_REGISTRY_CAIP10.toLowerCase(), '12345678901234567890'))).toBe(12345678901234567890n);
  });
  it('treats another registry, chain or a malformed id as unclaimed', () => {
    expect(parseErc8004Claim(extra('eip155:84532:0x000000000000000000000000000000000000dEaD', '7'))).toBeUndefined();
    expect(parseErc8004Claim(extra(IDENTITY_REGISTRY_CAIP10.replace('84532', '8453'), '7'))).toBeUndefined();
    for (const bad of ['-1', '07', '1.5', '0x7', '', ' 7', 7]) expect(parseErc8004Claim(extra(IDENTITY_REGISTRY_CAIP10, bad))).toBeUndefined();
  });
  it('treats a missing key as unclaimed', () => {
    expect(parseErc8004Claim({ name: 'USDC', version: '2' })).toBeUndefined();
    expect(parseErc8004Claim(undefined)).toBeUndefined();
  });
  it('the hook records the claim and leaves extra.name/version untouched', async () => {
    const state: ClaimState = {};
    const requirements = { extra: { name: 'USDC', version: '2', erc8004: { agentRegistry: IDENTITY_REGISTRY_CAIP10, agentId: '3' } } };
    await expect(erc8004Hook(state)({ selectedRequirements: requirements })).resolves.toBeUndefined();
    expect(state.agentId).toBe(3n);
    expect(requirements.extra).toMatchObject({ name: 'USDC', version: '2' });
    await erc8004Hook(state)({ selectedRequirements: { extra: { name: 'USDC', version: '2' } } });
    expect(state.agentId).toBeUndefined(); // a later unclaimed request resets it
  });
});

const request = {
  domain: { name: 'USDC', version: '2', chainId: 84532, verifyingContract: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' },
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
  message: { from: wallet, to: payee, value: '10000', validAfter: '0', validBefore: '9999999999', nonce },
};

const authorizedLog = () => ({
  address: wallet,
  topics: encodeEventTopics({ abi: policyWalletAbi, eventName: 'PaymentAuthorized', args: { nonce, payee, taskId: zeroHash } } as never),
  data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }], [10000n, 9999999999n, zeroHash]),
});
const verifiedLog = (agentId: bigint) => ({
  address: wallet,
  topics: encodeEventTopics({ abi: policyWalletAbi, eventName: 'PayeeIdentityVerified', args: { nonce, agentId, payee } } as never),
  data: '0x' as Hex,
});
const refusedLog = (reason: number) => ({
  address: wallet,
  topics: encodeEventTopics({ abi: policyWalletAbi, eventName: 'PaymentRefused', args: { nonce, payee, taskId: zeroHash } } as never),
  data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint8' }], [10000n, reason]),
});

function signerWith(logs: unknown[], claim?: bigint) {
  const writeContract = vi.fn(async (_args: any) => txHash);
  let authorized: AuthorizedPayment | undefined;
  let refused: PolicyRefusedError | undefined;
  const signer = createPolicyWalletSigner({
    wallet,
    agentKey: generatePrivateKey(),
    claim: () => claim,
    onAuthorized: (p) => (authorized = p),
    onRefused: (e) => (refused = e),
    clients: { walletClient: { writeContract }, publicClient: { waitForTransactionReceipt: vi.fn(async () => ({ status: 'success' as const, logs: logs as never })) } },
  });
  return { signer, writeContract, get authorized() { return authorized; }, get refused() { return refused; } };
}

describe('identity-aware signer', () => {
  it('calls authorizeWithIdentity with the claimed id and an explicit gas limit above the guard', async () => {
    const t = signerWith([authorizedLog(), verifiedLog(5n)], 5n);
    await t.signer.signTypedData(request);
    const call = t.writeContract.mock.calls[0]![0];
    expect(call.functionName).toBe('authorizeWithIdentity');
    expect(call.args.at(-1)).toBe(5n);
    // (IDENTITY_GAS + REGISTRY_GAS) * 64 / 63 + 200_000 = 5_381_587, plus the tx's own overhead.
    expect(call.gas).toBe(AUTHORIZE_WITH_IDENTITY_GAS);
    expect(AUTHORIZE_WITH_IDENTITY_GAS).toBeGreaterThan(5_381_587n + 200_000n);
    expect(t.authorized?.agentId).toBe(5n);
  });

  it("calls 001's authorize when nothing is claimed", async () => {
    const t = signerWith([authorizedLog()]);
    await t.signer.signTypedData(request);
    const call = t.writeContract.mock.calls[0]![0];
    expect(call.functionName).toBe('authorize');
    expect(call.gas).toBeUndefined();
    expect(t.authorized?.agentId).toBeUndefined();
  });

  it('reports no agentId when the identity could not be verified (allowlisted payee, registry down)', async () => {
    const t = signerWith([authorizedLog()], 5n);
    await t.signer.signTypedData(request);
    expect(t.authorized?.agentId).toBeUndefined();
  });

  it.each([
    [8, 'PAYEE_IDENTITY_UNVERIFIED'],
    [9, 'PAYEE_IDENTITY_MISMATCH'],
    [10, 'REPUTATION_UNAVAILABLE'],
    [11, 'NOT_ENOUGH_TRUSTED_REVIEWS'],
    [12, 'PAYEE_REPUTATION_TOO_LOW'],
  ])('throws PolicyRefusedError for reason %i (%s)', async (code, name) => {
    const t = signerWith([refusedLog(code)], 5n);
    await expect(t.signer.signTypedData(request)).rejects.toBeInstanceOf(PolicyRefusedError);
    expect(t.refused?.reason).toBe(name);
  });
});
