import { describe, expect, it, vi } from 'vitest';
import { pad, type Hex } from 'viem';
import { assertRegistriesPinned, ERC8004, RegistryChangedError } from '../src/registries.js';

const slotOf = (address: string) => pad(address.toLowerCase() as Hex, { size: 32 });
const client = (over: { identityImpl?: string; reputationImpl?: string; version?: string } = {}) => ({
  getStorageAt: vi.fn(async ({ address }: { address: string }) =>
    address === ERC8004.identity.proxy ? slotOf(over.identityImpl ?? ERC8004.identity.implementation) : slotOf(over.reputationImpl ?? ERC8004.reputation.implementation),
  ),
  readContract: vi.fn(async () => over.version ?? '2.0.0'),
});

describe('assertRegistriesPinned (research R8)', () => {
  it('passes when both implementations and versions match the pins', async () => {
    const c = client();
    await expect(assertRegistriesPinned(c)).resolves.toBeUndefined();
    expect(c.getStorageAt).toHaveBeenCalledWith({ address: ERC8004.identity.proxy, slot: ERC8004.implementationSlot });
  });
  it('throws RegistryChangedError when an implementation slot differs', async () => {
    const err = await assertRegistriesPinned(client({ reputationImpl: '0x000000000000000000000000000000000000dEaD' })).catch((e) => e);
    expect(err).toBeInstanceOf(RegistryChangedError);
    expect(err.registry).toBe('reputation');
  });
  it('throws RegistryChangedError when the version differs', async () => {
    const err = await assertRegistriesPinned(client({ version: '2.1.0' })).catch((e) => e);
    expect(err).toBeInstanceOf(RegistryChangedError);
    expect(err.actual).toBe('version 2.1.0');
  });
});
