/**
 * T010 payment-design test (research R2): can a contract wallet (ERC-1271) pay through the
 * standard x402 `exact` scheme and the public x402.org facilitator on Base Sepolia?
 *
 * 1. Deploys SpikeWallet1271 (agent = AGENT key) from the operator, or reuses SPIKE_WALLET.
 * 2. Funds it with 0.05 test USDC from the operator if it holds less than 0.01.
 * 3. Runs an @x402/hono endpoint in-process (price 0.01 USDC, payTo SERVICE_PAYEE).
 * 4. Pays it with @x402/fetch using a signer whose address is the wallet and whose
 *    signTypedData is the agent key.
 *
 * Usage: npx tsx scripts/spike-x402-1271.ts      (reads .env; Base Sepolia only; never prints keys)
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, formatUnits, getAddress, http, parseAbi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { Hono } from 'hono';
import { paymentMiddleware, x402ResourceServer } from '@x402/hono';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { ExactEvmScheme as ExactEvmServer } from '@x402/evm/exact/server';
import { ExactEvmScheme as ExactEvmClient } from '@x402/evm/exact/client';
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from '@x402/fetch';

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const;
const FACILITATOR = 'https://www.x402.org/facilitator';
const NETWORK = 'eip155:84532';
const usdcAbi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
]);

const env = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set in .env`);
  return v;
};
const log = (step: string, data: unknown) => console.log(`\n── ${step}\n${typeof data === 'string' ? data : JSON.stringify(data, null, 2)}`);
const usdc = (v: bigint) => `${formatUnits(v, 6)} USDC`;

const rpc = http(process.env.RPC_URL ?? 'https://sepolia.base.org');
const pub = createPublicClient({ chain: baseSepolia, transport: rpc });
const operator = privateKeyToAccount(env('OPERATOR_PRIVATE_KEY') as Hex);
const agent = privateKeyToAccount(env('AGENT_PRIVATE_KEY') as Hex);
const payee = getAddress(env('SERVICE_PAYEE'));
const opWallet = createWalletClient({ account: operator, chain: baseSepolia, transport: rpc });

// Testnet guard (constitution I).
const chainId = await pub.getChainId();
if (chainId !== 84532) throw new Error(`Refusing to run on chain ${chainId}; Base Sepolia (84532) only`);
log('accounts', { operator: operator.address, agent: agent.address, payee });

// 1. Wallet
let wallet = process.env.SPIKE_WALLET ? getAddress(process.env.SPIKE_WALLET) : undefined;
if (!wallet) {
  const artifact = JSON.parse(readFileSync(new URL('../contracts/out/SpikeWallet1271.sol/SpikeWallet1271.json', import.meta.url), 'utf8'));
  const hash = await opWallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [agent.address] });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error('deploy failed');
  wallet = receipt.contractAddress;
  log('deployed SpikeWallet1271', { wallet, tx: `https://sepolia.basescan.org/tx/${hash}`, gasUsed: receipt.gasUsed.toString() });
} else {
  log('reusing SpikeWallet1271', { wallet });
}

// 2. Funding
let walletBal = await pub.readContract({ address: USDC, abi: usdcAbi, functionName: 'balanceOf', args: [wallet] });
if (walletBal < 10_000n) {
  const hash = await opWallet.writeContract({ address: USDC, abi: usdcAbi, functionName: 'transfer', args: [wallet, 50_000n] });
  await pub.waitForTransactionReceipt({ hash });
  // Don't re-read: the public RPC can serve a stale node right after the receipt.
  walletBal += 50_000n;
  log('funded wallet', { amount: usdc(50_000n), tx: `https://sepolia.basescan.org/tx/${hash}` });
}
const payeeBefore = await pub.readContract({ address: USDC, abi: usdcAbi, functionName: 'balanceOf', args: [payee] });
log('balances before', { wallet: usdc(walletBal), payee: usdc(payeeBefore) });

// 3. Paid endpoint, in-process
const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: FACILITATOR })).register(NETWORK, new ExactEvmServer());
const app = new Hono();
app.use(
  paymentMiddleware(
    { 'GET /quote': { accepts: { scheme: 'exact', price: '$0.01', network: NETWORK, payTo: payee }, description: 'T010 spike quote' } },
    server,
  ),
);
app.get('/quote', (c) => c.json({ pair: 'ETH-USDC', price: '2400.00', asOf: new Date().toISOString(), note: 'T010 spike' }));
const localFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(app.fetch(new Request(input, init)));
const url = 'http://spike.local/quote';

const unpaid = await localFetch(url);
log('unpaid request', {
  status: unpaid.status,
  headers: Object.fromEntries([...unpaid.headers].filter(([k]) => /payment|x-/i.test(k)).map(([k, v]) => [k, v.length > 120 ? `${v.slice(0, 120)}… (${v.length} chars)` : v])),
  body: await unpaid.text(),
});
const required = unpaid.headers.get('PAYMENT-REQUIRED');
if (required) log('PAYMENT-REQUIRED (decoded)', JSON.parse(Buffer.from(required, 'base64').toString('utf8')));

// 4. Pay from the contract wallet, signing with the agent key
const signer = {
  address: wallet,
  signTypedData: (m: Parameters<typeof agent.signTypedData>[0]) => agent.signTypedData(m),
};
const client = new x402Client().register(NETWORK, new ExactEvmClient(signer as never));
const payingFetch = wrapFetchWithPayment(localFetch as typeof fetch, client);

try {
  const res = await payingFetch(url);
  const header = res.headers.get('PAYMENT-RESPONSE') ?? res.headers.get('X-PAYMENT-RESPONSE');
  const settlement = header ? decodePaymentResponseHeader(header) : null;
  log('paid request', {
    status: res.status,
    responseHeaders: [...res.headers.keys()],
    body: await res.text(),
    settlement,
  });
  const tx = (settlement as { transaction?: Hex } | null)?.transaction;
  if (tx) {
    const receipt = await pub.waitForTransactionReceipt({ hash: tx });
    log('settlement tx', { status: receipt.status, tx: `https://sepolia.basescan.org/tx/${tx}`, from: receipt.from, to: receipt.to });
  }
} catch (err) {
  const e = err as Error & { cause?: unknown };
  log('payment FAILED', { message: e.message, cause: e.cause instanceof Error ? e.cause.message : e.cause });
}

const walletAfter = await pub.readContract({ address: USDC, abi: usdcAbi, functionName: 'balanceOf', args: [wallet] });
const payeeAfter = await pub.readContract({ address: USDC, abi: usdcAbi, functionName: 'balanceOf', args: [payee] });
log('balances after', {
  wallet: usdc(walletAfter),
  payee: usdc(payeeAfter),
  walletDelta: usdc(walletAfter - walletBal),
  payeeDelta: usdc(payeeAfter - payeeBefore),
});
