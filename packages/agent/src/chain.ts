import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  type Account,
  type Chain,
  type Hex,
  type PublicClient as ViemPublicClient,
  type Transport,
  type WalletClient as ViemWalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { assertBaseSepolia } from './chainGuard.js';

export const usdcAbi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
]);

export type PublicClient = ViemPublicClient<Transport, Chain>;
export type WalletClient = ViemWalletClient<Transport, Chain, Account>;

export function publicClientFor(rpcUrl: string): PublicClient {
  return createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) }) as PublicClient;
}

export function walletClientFor(rpcUrl: string, key: Hex): WalletClient {
  return createWalletClient({ account: privateKeyToAccount(key), chain: baseSepolia, transport: http(rpcUrl) });
}

/** A public client that has passed the Base Sepolia guard. */
export async function guardedPublicClient(rpcUrl: string): Promise<PublicClient> {
  const client = publicClientFor(rpcUrl);
  await assertBaseSepolia(client);
  return client;
}

/** Splits [from, to] into inclusive ranges of at most `size` blocks (public RPC limit: 500). */
export function blockRanges(from: bigint, to: bigint, size = 500n): [bigint, bigint][] {
  const out: [bigint, bigint][] = [];
  for (let start = from; start <= to; start += size) {
    const end = start + size - 1n < to ? start + size - 1n : to;
    out.push([start, end]);
  }
  return out;
}

/** USDC has 6 decimals. "0.01" → 10000n. */
export function parseUsdc(value: string): bigint {
  if (!/^\d+(\.\d{1,6})?$/.test(value)) throw new Error(`Not a USDC amount: ${value}`);
  const [whole, frac = ''] = value.split('.');
  return BigInt(whole!) * 1_000_000n + BigInt(frac.padEnd(6, '0'));
}

export function formatUsdc(value: bigint): string {
  const sign = value < 0n ? '-' : '';
  const v = value < 0n ? -value : value;
  const frac = (v % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${sign}${v / 1_000_000n}${frac ? '.' + frac.padEnd(2, '0') : '.00'}`;
}
