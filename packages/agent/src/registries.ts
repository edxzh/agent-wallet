/**
 * The ERC-8004 registries on Base Sepolia (research R1, R8): pinned addresses from
 * config/erc8004.json, the viem ABIs for the parts we use, and the per-run pin check.
 */
import { readFileSync } from 'node:fs';
import { getAddress, parseAbi, type Address, type Hex } from 'viem';
import { ROOT } from './config.js';

export type Erc8004Config = {
  chainId: number;
  version: string;
  identity: { proxy: Address; implementation: Address };
  reputation: { proxy: Address; implementation: Address };
  implementationSlot: Hex;
  forkBlock: number;
};

export const ERC8004: Erc8004Config = JSON.parse(readFileSync(`${ROOT}config/erc8004.json`, 'utf8'));
export const IDENTITY_REGISTRY = getAddress(ERC8004.identity.proxy);
export const REPUTATION_REGISTRY = getAddress(ERC8004.reputation.proxy);
/** How a service names the registry in x402 `extra.erc8004.agentRegistry` (research R3). */
export const IDENTITY_REGISTRY_CAIP10 = `eip155:${ERC8004.chainId}:${IDENTITY_REGISTRY}`;

export const identityAbi = parseAbi([
  'function getAgentWallet(uint256 agentId) view returns (address)',
  'function ownerOf(uint256 agentId) view returns (address)',
  'function tokenURI(uint256 agentId) view returns (string)',
  'function getVersion() view returns (string)',
]);

export const reputationAbi = parseAbi([
  'function getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2) view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)',
  'function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)',
  'function getLastIndex(uint256 agentId, address clientAddress) view returns (uint64)',
  'function getVersion() view returns (string)',
  'event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)',
  'event FeedbackRevoked(uint256 indexed agentId, address indexed clientAddress, uint64 indexed feedbackIndex)',
]);

/** A registry's implementation or version differs from the pin: stop before paying (exit 4). */
export class RegistryChangedError extends Error {
  name = 'RegistryChangedError';
  constructor(
    public readonly registry: 'identity' | 'reputation',
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(`ERC-8004 ${registry} registry changed: expected ${expected}, found ${actual}`);
  }
}

type PinClient = {
  getStorageAt(args: { address: Address; slot: Hex }): Promise<Hex | undefined>;
  readContract(args: { address: Address; abi: readonly unknown[]; functionName: 'getVersion' }): Promise<unknown>;
};

/** Reads both proxies' ERC-1967 implementation slot and getVersion(); throws on any difference. */
export async function assertRegistriesPinned(client: PinClient, pins: Erc8004Config = ERC8004): Promise<void> {
  for (const registry of ['identity', 'reputation'] as const) {
    const { proxy, implementation } = pins[registry];
    const word = (await client.getStorageAt({ address: proxy, slot: pins.implementationSlot })) ?? '0x';
    const actual = word.length >= 42 ? getAddress(`0x${word.slice(-40)}`) : word;
    if (actual !== getAddress(implementation)) throw new RegistryChangedError(registry, getAddress(implementation), actual);
    const abi = registry === 'identity' ? identityAbi : reputationAbi;
    const version = String(await client.readContract({ address: proxy, abi, functionName: 'getVersion' }));
    if (version !== pins.version) throw new RegistryChangedError(registry, `version ${pins.version}`, `version ${version}`);
  }
}
