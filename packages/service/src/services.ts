/**
 * Feature 002's demo services (specs/002-trusted-payees-erc8004/contracts/paid-services.md): one
 * Worker, separate routes, each with its own payTo and ERC-8004 identity, claimed in the x402
 * requirement's `extra.erc8004`. Behaviour depends only on server time (research R5).
 */
export const IDENTITY_REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
export const AGENT_REGISTRY = `eip155:84532:${IDENTITY_REGISTRY}`;

export type ServiceEnv = {
  PAYEE_ADDRESS: string;
  PAYEE_RELIABLE?: string;
  PAYEE_FLAKY?: string;
  PAYEE_NEWCOMER?: string;
  PAYEE_IMPOSTOR?: string;
  AGENT_ID_QUOTE?: string;
  AGENT_ID_RELIABLE?: string;
  AGENT_ID_FLAKY?: string;
  AGENT_ID_NEWCOMER?: string;
  FLAKY_DEGRADE_AT?: string;
  NEWCOMER_OPENS_AT?: string;
};

export type Service = {
  /** Route key: "quote" is 001's /quote, the rest are /s/<key>/quote. */
  key: 'quote' | 'reliable' | 'flaky' | 'newcomer' | 'impostor' | 'anonymous';
  payTo: (env: ServiceEnv) => string | undefined;
  /** The claimed agentId (decimal string), or undefined for none. */
  agentId: (env: ServiceEnv) => string | undefined;
};

/** Empty or placeholder vars count as unset. An agentId must be a canonical decimal. */
const id = (v: string | undefined) => (v && /^(0|[1-9]\d*)$/.test(v) ? v : undefined);
const addr = (v: string | undefined) => (v && /^0x[0-9a-fA-F]{40}$/.test(v) ? v : undefined);

export const SERVICES: Service[] = [
  { key: 'quote', payTo: (e) => addr(e.PAYEE_ADDRESS), agentId: (e) => id(e.AGENT_ID_QUOTE) },
  { key: 'reliable', payTo: (e) => addr(e.PAYEE_RELIABLE), agentId: (e) => id(e.AGENT_ID_RELIABLE) },
  { key: 'flaky', payTo: (e) => addr(e.PAYEE_FLAKY), agentId: (e) => id(e.AGENT_ID_FLAKY) },
  { key: 'newcomer', payTo: (e) => addr(e.PAYEE_NEWCOMER), agentId: (e) => id(e.AGENT_ID_NEWCOMER) },
  // US6: claims reliable's identity but asks to be paid somewhere else.
  { key: 'impostor', payTo: (e) => addr(e.PAYEE_IMPOSTOR), agentId: (e) => id(e.AGENT_ID_RELIABLE) },
  // US6 #2: no identity at all.
  { key: 'anonymous', payTo: (e) => addr(e.PAYEE_IMPOSTOR), agentId: () => undefined },
];

/** The `extra` added to a route's requirement; x402 merges it with USDC's name and version. */
export const identityExtra = (agentId: string | undefined) => (agentId === undefined ? undefined : { erc8004: { agentRegistry: AGENT_REGISTRY, agentId } });

const at = (v: string | undefined) => (v && !Number.isNaN(Date.parse(v)) ? Date.parse(v) : undefined);

/** Newcomer: closed (503, no 402, nothing to pay) until NEWCOMER_OPENS_AT. Unset means open. */
export function closedUntil(key: Service['key'], env: ServiceEnv, now: number): string | undefined {
  const opens = at(env.NEWCOMER_OPENS_AT);
  return key === 'newcomer' && opens !== undefined && now < opens ? new Date(opens).toISOString() : undefined;
}

/** Flaky: fresh until FLAKY_DEGRADE_AT, then always 1 hour stale. Everything else is fresh. */
export function asOfFor(key: Service['key'], env: ServiceEnv, now: number): string {
  const degrade = at(env.FLAKY_DEGRADE_AT);
  const stale = key === 'flaky' && degrade !== undefined && now >= degrade;
  return new Date(stale ? now - 3_600_000 : now).toISOString();
}
