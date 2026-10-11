import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, getAddress, recoverTypedDataAddress, zeroHash, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { jobEscrowAbi, policyWalletAbi } from '../src/abi.js';
import { fundingRequest, hashText, hireAgent, jobIdFor, outcomeName, type JobTerms } from '../src/escrow.js';

const agentKey = generatePrivateKey();
const agent = privateKeyToAccount(agentKey);
const wallet = getAddress('0x00000000000000000000000000000000000000aa');
const escrow = getAddress('0x00000000000000000000000000000000000000e5');
const worker = getAddress('0x00000000000000000000000000000000000000b0');
const arbiter = getAddress('0x00000000000000000000000000000000000000a7');
const nonce = ('0x' + '11'.repeat(32)) as Hex;
const authTx = ('0x' + 'a1'.repeat(32)) as Hex;
const openTx = ('0x' + 'b2'.repeat(32)) as Hex;
const terms: JobTerms = { worker, arbiter, amount: 500_000n, deliverIn: 86_400, reviewWindow: 7_200, disputeWindow: 259_200, spec: 'summarise ETH-USDC quotes' };

const walletLog = (eventName: 'PaymentAuthorized' | 'PaymentRefused') => ({
  address: wallet,
  topics: encodeEventTopics({ abi: policyWalletAbi, eventName, args: { nonce, payee: escrow, taskId: zeroHash } }),
  data:
    eventName === 'PaymentAuthorized'
      ? encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }], [terms.amount, 1n, zeroHash])
      : encodeAbiParameters([{ type: 'uint256' }, { type: 'uint8' }], [terms.amount, 4]),
});

const escrowLog = (eventName: 'JobOpened' | 'JobRefused') => {
  const jobId = jobIdFor(wallet, nonce);
  return eventName === 'JobOpened'
    ? {
        address: escrow,
        topics: encodeEventTopics({ abi: jobEscrowAbi, eventName, args: { jobId, client: wallet, worker } }),
        data: encodeAbiParameters(
          ['address', 'bytes32', 'uint256', 'uint64', 'uint32', 'uint32', 'bytes32', 'uint256'].map((type) => ({ type })),
          [arbiter, nonce, terms.amount, 1n, 7_200, 259_200, hashText(terms.spec), 0n],
        ),
      }
    : {
        address: escrow,
        topics: encodeEventTopics({ abi: jobEscrowAbi, eventName, args: { jobId, client: wallet, worker } }),
        data: encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint8' }], [nonce, 3]),
      };
};

function fakeClients(walletEvent: 'PaymentAuthorized' | 'PaymentRefused', escrowEvent: 'JobOpened' | 'JobRefused' = 'JobOpened', checkPayee = 0) {
  const writes: any[] = [];
  const reads: any[] = [];
  return {
    writes,
    reads,
    clients: {
      walletClient: {
        async writeContract(args: any) {
          writes.push(args);
          return args.functionName === 'open' ? openTx : authTx;
        },
      },
      publicClient: {
        async readContract(args: any) {
          reads.push(args);
          return checkPayee;
        },
        async waitForTransactionReceipt({ hash }: { hash: Hex }) {
          return { status: 'success' as const, logs: [hash === authTx ? walletLog(walletEvent) : escrowLog(escrowEvent)] as any };
        },
      },
    },
  };
}

describe('jobIdFor', () => {
  it('matches JobEscrow.jobIdFor (fixture shared with contracts/test/JobEscrow.t.sol)', () => {
    expect(jobIdFor(wallet, nonce)).toBe('0xef5cb546cac640baee42539553d7824bef1d6007efbe5b23cda0b12012e22441');
  });
});

describe('fundingRequest', () => {
  it('is a USDC TransferWithAuthorization from the wallet to the escrow', async () => {
    const req = fundingRequest({ wallet, escrow, amount: 10_000n, validBefore: 2_000_000_000n, nonce });
    expect(req.domain).toEqual({ name: 'USDC', version: '2', chainId: 84532, verifyingContract: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' });
    expect(req.message).toMatchObject({ from: wallet, to: escrow, value: 10_000n, validAfter: 0n, nonce });
    const sig = await agent.signTypedData(req as any);
    expect(await recoverTypedDataAddress({ ...(req as any), signature: sig })).toBe(agent.address);
  });
});

describe('hireAgent', () => {
  it('authorizes a payment to the escrow, then opens the job with the signed funding', async () => {
    const { clients, writes } = fakeClients('PaymentAuthorized');
    const out = await hireAgent({ wallet, escrow, agentKey, terms, nonce, now: 1_800_000_000n, clients });
    expect(out).toEqual({ kind: 'opened', jobId: jobIdFor(wallet, nonce), nonce, authorizeTx: authTx, openTx });
    expect(writes.map((w) => w.functionName)).toEqual(['authorize', 'open']);
    expect(writes[0].args.slice(1, 3)).toEqual([escrow, terms.amount]); // the wallet's rules see payee = escrow
    const p = writes[1].args[0];
    expect(p).toMatchObject({ client: wallet, worker, arbiter, amount: terms.amount, deliverBy: 1_800_086_400n, workerHasClaim: false });
    expect(p.specHash).toBe(hashText(terms.spec));
  });

  it('stops before opening when the wallet refuses the funding (nothing signed)', async () => {
    const { clients, writes } = fakeClients('PaymentRefused');
    const out = await hireAgent({ wallet, escrow, agentKey, terms, nonce, now: 1_800_000_000n, clients });
    expect(out).toEqual({ kind: 'refused-by-wallet', reason: 'OVER_PER_PAYMENT_CAP', nonce, authorizeTx: authTx });
    expect(writes.map((w) => w.functionName)).toEqual(['authorize']);
  });

  it('checks the worker for free first, and signs and sends nothing if the wallet would refuse', async () => {
    const { clients, writes, reads } = fakeClients('PaymentAuthorized', 'JobOpened', 3);
    const out = await hireAgent({ wallet, escrow, agentKey, terms: { ...terms, workerAgentId: 9614n }, nonce, now: 1_800_000_000n, clients });
    expect(out).toEqual({ kind: 'worker-not-payable', reason: 'PAYEE_NOT_ALLOWED' });
    expect(writes).toHaveLength(0);
    expect(reads[0]).toMatchObject({ address: wallet, functionName: 'checkPayee', args: [worker, true, 9614n] });
  });

  it('reports a worker the escrow refused anyway (e.g. rules changed between the check and open)', async () => {
    const { clients } = fakeClients('PaymentAuthorized', 'JobRefused');
    const out = await hireAgent({ wallet, escrow, agentKey, terms, nonce, now: 1_800_000_000n, clients });
    expect(out).toMatchObject({ kind: 'refused-worker', reason: 'PAYEE_NOT_ALLOWED', jobId: jobIdFor(wallet, nonce) });
  });

  it('passes a claimed worker identity to the escrow', async () => {
    const { clients, writes } = fakeClients('PaymentAuthorized');
    await hireAgent({ wallet, escrow, agentKey, terms: { ...terms, workerAgentId: 9614n }, nonce, now: 1_800_000_000n, clients });
    expect(writes[1].args[0]).toMatchObject({ workerHasClaim: true, workerAgentId: 9614n });
  });
});

describe('outcomeName', () => {
  it('follows IJobEscrow.Outcome', () => {
    expect([1, 4, 6, 9].map(outcomeName)).toEqual(['ACCEPTED', 'DELIVERY_TIMEOUT', 'ARBITER_TIMEOUT', 'UNKNOWN_9']);
  });
});
