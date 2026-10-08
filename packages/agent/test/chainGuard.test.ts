import { describe, expect, it } from 'vitest';
import { assertBaseSepolia, WrongNetworkError } from '../src/chainGuard.js';

describe('assertBaseSepolia', () => {
  it('passes on Base Sepolia (84532)', async () => {
    await expect(assertBaseSepolia({ getChainId: async () => 84532 })).resolves.toBeUndefined();
  });

  it.each([8453, 1, 11155111, 31337])('refuses chain %i', async (chainId) => {
    await expect(assertBaseSepolia({ getChainId: async () => chainId })).rejects.toBeInstanceOf(WrongNetworkError);
  });
});
