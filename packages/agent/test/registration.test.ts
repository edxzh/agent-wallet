import { describe, expect, it, vi } from 'vitest';
import { concat, encodeAbiParameters, getAddress, hashTypedData, keccak256, recoverTypedDataAddress, toHex, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { agentWalletSetTypedData, buildAgentURI, MAX_DEADLINE_S, registerServices, type ServiceEntry } from '../src/registration.js';
import { IDENTITY_REGISTRY } from '../src/registries.js';

const svc = (key: string, claims: ServiceEntry['claims'], agentId: string | null = null): ServiceEntry => ({
  key,
  route: key === 'quote' ? '/quote' : `/s/${key}/quote`,
  agentId,
  payTo: null,
  label: { en: `${key} label`, zh: '中文' },
  claims,
});

describe('buildAgentURI (research R9)', () => {
  it('is a base64 data: URI with the registration-v1 shape', () => {
    const uri = buildAgentURI(svc('reliable', 'self'));
    expect(uri.startsWith('data:application/json;base64,')).toBe(true);
    const file = JSON.parse(Buffer.from(uri.split(',')[1]!, 'base64').toString('utf8'));
    expect(file).toEqual({
      type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
      name: 'Yunshu demo · reliable label',
      description: 'Demo x402 quote service for the Yunshu agent wallet. Test network only.',
      image: 'https://demo.yunshu.ai/favicon.svg',
      endpoints: [{ name: 'x402', endpoint: 'https://api.demo.yunshu.ai/s/reliable/quote', version: '2.0' }],
      x402Support: true,
      active: true,
      registrations: [],
      supportedTrust: ['reputation'],
    });
  });
});

describe('AgentWalletSet typed data', () => {
  const owner = getAddress('0x00000000000000000000000000000000000000a1');
  const newWallet = getAddress('0x00000000000000000000000000000000000000b2');
  const td = agentWalletSetTypedData({ agentId: 7n, newWallet, owner, deadline: 1_800_000_000n });

  it('uses the registry domain and type', () => {
    expect(td.domain).toEqual({ name: 'ERC8004IdentityRegistry', version: '1', chainId: 84532, verifyingContract: IDENTITY_REGISTRY });
    expect(td.types.AgentWalletSet.map((f) => `${f.type} ${f.name}`).join(',')).toBe('uint256 agentId,address newWallet,address owner,uint256 deadline');
  });

  it('hashes exactly as the deployed registry does (keccak by hand)', () => {
    const domainSep = keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
        [
          keccak256(toHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')),
          keccak256(toHex('ERC8004IdentityRegistry')),
          keccak256(toHex('1')),
          84532n,
          IDENTITY_REGISTRY,
        ],
      ),
    );
    const structHash = keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }],
        [keccak256(toHex('AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)')), 7n, newWallet, owner, 1_800_000_000n],
      ),
    );
    expect(hashTypedData(td)).toBe(keccak256(concat(['0x1901', domainSep, structHash])));
  });
});

function deps(over: { wallets?: Record<string, Address> } = {}) {
  const ownerKey = generatePrivateKey();
  const keys: Record<string, Hex> = {};
  const saved: ServiceEntry[] = [];
  let nextId = 5n;
  const d = {
    owner: privateKeyToAccount(ownerKey).address,
    now: vi.fn(async () => 1_800_000_000n),
    getAgentWallet: vi.fn(async (id: bigint) => over.wallets?.[id.toString()] ?? getAddress('0x0000000000000000000000000000000000000000')),
    register: vi.fn(async () => ({ agentId: nextId++, tx: '0x01' as Hex })),
    signWalletSet: vi.fn(async (payee: Address, td: ReturnType<typeof agentWalletSetTypedData>) => privateKeyToAccount(keys[payee]!).signTypedData(td)),
    setAgentWallet: vi.fn(async () => '0x02' as Hex),
    save: (s: ServiceEntry) => saved.push(s),
    log: vi.fn(),
  };
  const payee = (name: string) => {
    const k = generatePrivateKey();
    const a = privateKeyToAccount(k).address;
    keys[a] = k;
    return a;
  };
  return { d, saved, payee };
}

describe('registerServices', () => {
  it('registers, then sets each wallet with the payee signature and a deadline within 5 minutes', async () => {
    const { d, saved, payee } = deps();
    const payees = { quote: payee('q'), reliable: payee('r'), impostor: payee('i') };
    await registerServices([svc('quote', 'self'), svc('reliable', 'self'), svc('impostor', 'reliable')], payees, d);
    expect(d.register).toHaveBeenCalledTimes(2);
    expect(d.setAgentWallet).toHaveBeenCalledTimes(2);
    for (const [agentId, wallet, deadline, sig] of d.setAgentWallet.mock.calls as unknown as [bigint, Address, bigint, Hex][]) {
      expect(deadline).toBeLessThanOrEqual(1_800_000_000n + BigInt(MAX_DEADLINE_S));
      const recovered = await recoverTypedDataAddress({ ...agentWalletSetTypedData({ agentId, newWallet: wallet, owner: d.owner, deadline }), signature: sig });
      expect(recovered).toBe(wallet); // signed by the payee itself
    }
    const final = Object.fromEntries(saved.map((s) => [s.key, s]));
    expect(final.quote).toMatchObject({ agentId: '5', payTo: payees.quote });
    expect(final.reliable).toMatchObject({ agentId: '6', payTo: payees.reliable });
    expect(final.impostor).toMatchObject({ agentId: null, payTo: payees.impostor });
  });

  it('is idempotent: skips an id whose wallet already equals payTo', async () => {
    const { d, payee } = deps();
    const p = payee('r');
    const again = deps({ wallets: { '6': p } }).d;
    await registerServices([svc('reliable', 'self', '6')], { reliable: p }, again);
    expect(again.register).not.toHaveBeenCalled();
    expect(again.setAgentWallet).not.toHaveBeenCalled();
    expect(d.register).not.toHaveBeenCalled();
  });

  it('re-points an existing id whose wallet differs, without registering again', async () => {
    const { d, payee } = deps({ wallets: { '6': getAddress('0x00000000000000000000000000000000000000ff') } });
    await registerServices([svc('reliable', 'self', '6')], { reliable: payee('r') }, d);
    expect(d.register).not.toHaveBeenCalled();
    expect(d.setAgentWallet).toHaveBeenCalledTimes(1);
  });
});
