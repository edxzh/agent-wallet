import { CHAIN_ID } from './config.js';

export class WrongNetworkError extends Error {
  constructor(public readonly chainId: number) {
    super(`Refusing to run on chain ${chainId}: Base Sepolia (${CHAIN_ID}) only`);
    this.name = 'WrongNetworkError';
  }
}

/** Throws unless the RPC reports Base Sepolia (constitution I). Every CLI entry point calls this first. */
export async function assertBaseSepolia(client: { getChainId(): Promise<number> }): Promise<void> {
  const chainId = await client.getChainId();
  if (chainId !== CHAIN_ID) throw new WrongNetworkError(chainId);
}
