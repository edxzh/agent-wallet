import { describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, getAddress, recoverTypedDataAddress, zeroHash, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { policyWalletAbi } from '../src/abi.js';
import { createPolicyWalletSigner, PolicyRefusedError, UnexpectedSignRequestError } from '../src/signer.js';

const agentKey = generatePrivateKey();
const agent = privateKeyToAccount(agentKey);
const wallet = getAddress('0x00000000000000000000000000000000000000aa');
const payee = getAddress('0x00000000000000000000000000000000000000bb');
const nonce = ('0x' + '11'.repeat(32)) as Hex;
const txHash = ('0x' + 'ab'.repeat(32)) as Hex;

const request = (overrides: Partial<{ from: string; primaryType: string }> = {}) => ({
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
  primaryType: overrides.primaryType ?? 'TransferWithAuthorization',
  message: { from: overrides.from ?? wallet, to: payee, value: '10000', validAfter: '0', validBefore: '9999999999', nonce },
});

const log = (eventName: 'PaymentRefused' | 'PaymentAuthorized') => {
  const topics = encodeEventTopics({
    abi: policyWalletAbi,
    eventName,
    args: { nonce, payee, taskId: zeroHash },
  } as never);
  const data =
    eventName === 'PaymentRefused'
      ? encodeAbiParameters([{ type: 'uint256' }, { type: 'uint8' }], [10000n, 6])
      : encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }], [10000n, 9999999999n, zeroHash]);
  return { address: wallet, topics, data } as never;
};

const mockClients = (eventName: 'PaymentRefused' | 'PaymentAuthorized') => {
  const writeContract = vi.fn(async () => txHash);
  return {
    writeContract,
    clients: {
      walletClient: { writeContract },
      publicClient: { waitForTransactionReceipt: vi.fn(async () => ({ status: 'success' as const, logs: [log(eventName)] })) },
    },
  };
};

describe('createPolicyWalletSigner', () => {
  it('uses the wallet as the payer address', () => {
    const { clients } = mockClients('PaymentAuthorized');
    expect(createPolicyWalletSigner({ wallet, agentKey, clients }).address).toBe(wallet);
  });

  it('authorizes on-chain, then returns a signature that recovers to the agent', async () => {
    const { clients, writeContract } = mockClients('PaymentAuthorized');
    const onAuthorized = vi.fn();
    const signer = createPolicyWalletSigner({ wallet, agentKey, clients, onAuthorized });
    const req = request();
    const signature = await signer.signTypedData(req);

    expect(writeContract).toHaveBeenCalledOnce();
    const call = writeContract.mock.calls[0]![0] as { functionName: string; args: unknown[] };
    expect(call.functionName).toBe('authorize');
    expect(call.args).toEqual([nonce, payee, 10000n, 0n, 9999999999n, zeroHash]);
    expect(onAuthorized).toHaveBeenCalledWith(expect.objectContaining({ nonce, txHash, amount: 10000n }));
    const recovered = await recoverTypedDataAddress({ ...(req as never), signature });
    expect(recovered).toBe(agent.address);
  });

  it('throws PolicyRefusedError with the reason and signs nothing when refused', async () => {
    const { clients } = mockClients('PaymentRefused');
    const signer = createPolicyWalletSigner({ wallet, agentKey, clients });
    const err = await signer.signTypedData(request()).catch((e) => e);
    expect(err).toBeInstanceOf(PolicyRefusedError);
    expect(err).toMatchObject({ reason: 'OVER_DAILY_BUDGET', nonce, txHash });
  });

  it('reports a refusal through onRefused even if the caller wraps the error', async () => {
    const { clients } = mockClients('PaymentRefused');
    const onRefused = vi.fn();
    const signer = createPolicyWalletSigner({ wallet, agentKey, clients, onRefused });
    await signer.signTypedData(request()).catch(() => undefined);
    expect(onRefused).toHaveBeenCalledWith(expect.objectContaining({ reason: 'OVER_DAILY_BUDGET', nonce }));
  });

  it('refuses a transfer from another address before any transaction', async () => {
    const { clients, writeContract } = mockClients('PaymentAuthorized');
    const signer = createPolicyWalletSigner({ wallet, agentKey, clients });
    await expect(signer.signTypedData(request({ from: payee }))).rejects.toBeInstanceOf(UnexpectedSignRequestError);
    expect(writeContract).not.toHaveBeenCalled();
  });

  it('refuses any other typed data before any transaction', async () => {
    const { clients, writeContract } = mockClients('PaymentAuthorized');
    const signer = createPolicyWalletSigner({ wallet, agentKey, clients });
    await expect(signer.signTypedData(request({ primaryType: 'Permit' }))).rejects.toBeInstanceOf(UnexpectedSignRequestError);
    expect(writeContract).not.toHaveBeenCalled();
  });
});
