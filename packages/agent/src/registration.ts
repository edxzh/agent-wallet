/**
 * Registers the demo services' ERC-8004 identities (research R9, contracts/agent-cli.md): the
 * services-owner calls register(agentURI); each payee key signs an EIP-712 AgentWalletSet once so
 * the identity's wallet is the service's payTo. Owner-run only: these keys never go to CI.
 */
import { getAddress, parseAbi, type Address, type Hex } from 'viem';
import { ERC8004, IDENTITY_REGISTRY } from './registries.js';

export const API_BASE = 'https://api.demo.yunshu.ai';
/** The registry accepts deadlines up to now + 5 min. */
export const MAX_DEADLINE_S = 300;

export const registrationAbi = parseAbi([
  'function register(string agentURI) returns (uint256 agentId)',
  'function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes signature)',
  'function getAgentWallet(uint256 agentId) view returns (address)',
  'event Registered(uint256 indexed agentId, string agentURI, address indexed owner)',
]);

export type ServiceEntry = {
  key: string;
  route: string;
  agentId: string | number | null;
  payTo: string | null;
  label: { en: string; zh: string };
  claims: 'self' | 'reliable' | null;
};

/** The on-chain registration file (research R1/R9 shape) as a data: URI. */
export function buildAgentURI(s: Pick<ServiceEntry, 'route' | 'label'>): string {
  const file = {
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name: `Yunshu demo · ${s.label.en}`,
    description: 'Demo x402 quote service for the Yunshu agent wallet. Test network only.',
    image: 'https://demo.yunshu.ai/favicon.svg',
    endpoints: [{ name: 'x402', endpoint: `${API_BASE}${s.route}`, version: '2.0' }],
    x402Support: true,
    active: true,
    registrations: [],
    supportedTrust: ['reputation'],
  };
  return `data:application/json;base64,${Buffer.from(JSON.stringify(file)).toString('base64')}`;
}

/** EIP-712 AgentWalletSet, exactly as the deployed registry hashes it (verified source). */
export function agentWalletSetTypedData(m: { agentId: bigint; newWallet: Address; owner: Address; deadline: bigint }) {
  return {
    domain: { name: 'ERC8004IdentityRegistry', version: '1', chainId: ERC8004.chainId, verifyingContract: IDENTITY_REGISTRY },
    types: {
      AgentWalletSet: [
        { name: 'agentId', type: 'uint256' },
        { name: 'newWallet', type: 'address' },
        { name: 'owner', type: 'address' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'AgentWalletSet' as const,
    message: m,
  };
}

export type RegistrationDeps = {
  owner: Address;
  now: () => Promise<bigint>; // chain time (seconds)
  getAgentWallet: (agentId: bigint) => Promise<Address>;
  register: (agentURI: string) => Promise<{ agentId: bigint; tx: Hex }>;
  /** Signs AgentWalletSet with the key of `payee`. */
  signWalletSet: (payee: Address, typedData: ReturnType<typeof agentWalletSetTypedData>) => Promise<Hex>;
  setAgentWallet: (agentId: bigint, payee: Address, deadline: bigint, signature: Hex) => Promise<Hex>;
  save: (s: ServiceEntry) => void;
  log: (event: string, data: Record<string, unknown>) => void;
};

/**
 * For each service that claims its own identity: register it if it has no id, then point its
 * wallet at its payTo. Idempotent: skips an id whose wallet already equals payTo.
 */
export async function registerServices(services: ServiceEntry[], payees: Record<string, Address | undefined>, d: RegistrationDeps) {
  for (const s of services.filter((x) => x.claims === 'self')) {
    const payTo = payees[s.key];
    if (!payTo) throw new Error(`No payee address for ${s.key}`);
    let agentId = s.agentId === null ? undefined : BigInt(s.agentId);
    if (agentId !== undefined && getAddress(await d.getAgentWallet(agentId)) === getAddress(payTo)) {
      d.log('service-skipped', { key: s.key, agentId, payTo, reason: 'already registered to this payee' });
      d.save({ ...s, payTo: getAddress(payTo) });
      continue;
    }
    if (agentId === undefined) {
      const r = await d.register(buildAgentURI(s));
      agentId = r.agentId;
      d.log('service-registered', { key: s.key, agentId, tx: r.tx });
      d.save({ ...s, agentId: agentId.toString() }); // saved at once, so a rerun never registers twice
    }
    const deadline = (await d.now()) + BigInt(MAX_DEADLINE_S - 60);
    const signature = await d.signWalletSet(payTo, agentWalletSetTypedData({ agentId, newWallet: payTo, owner: d.owner, deadline }));
    const tx = await d.setAgentWallet(agentId, payTo, deadline, signature);
    d.log('service-wallet-set', { key: s.key, agentId, payTo, tx });
    d.save({ ...s, agentId: agentId.toString(), payTo: getAddress(payTo) });
  }
  // The impostor and anonymous routes need no registration, only their payTo recorded.
  for (const s of services.filter((x) => x.claims !== 'self')) {
    const payTo = payees[s.key];
    if (payTo) d.save({ ...s, payTo: getAddress(payTo) });
  }
}
