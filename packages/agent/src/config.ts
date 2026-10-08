import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { getAddress, type Address, type Hex } from 'viem';

/** Base Sepolia only (constitution I). */
export const CHAIN_ID = 84532;
export const NETWORK = 'eip155:84532';
export const USDC: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
export const DEFAULT_RPC_URL = 'https://sepolia.base.org';
export const BASESCAN = 'https://sepolia.basescan.org';

export const txUrl = (hash: Hex) => `${BASESCAN}/tx/${hash}`;
export const addressUrl = (address: Address) => `${BASESCAN}/address/${address}`;

/** Repo root, resolved from this file (packages/agent/src). */
export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const DEPLOYMENTS_PATH = `${ROOT}config/deployments.json`;
export const PAYEES_PATH = `${ROOT}config/payees.json`;

let loaded = false;
/** Loads the repo-root .env once. Never logs values. */
export function loadConfig() {
  if (!loaded) {
    loadEnv({ path: `${ROOT}.env`, quiet: true });
    loaded = true;
  }
  return {
    rpcUrl: process.env.RPC_URL || DEFAULT_RPC_URL,
    operatorKey: process.env.OPERATOR_PRIVATE_KEY as Hex | undefined,
    agentKey: process.env.AGENT_PRIVATE_KEY as Hex | undefined,
    servicePayee: process.env.SERVICE_PAYEE ? getAddress(process.env.SERVICE_PAYEE) : undefined,
  };
}

export type Deployments = {
  network: string;
  implementation?: Address;
  factory?: Address;
  factoryBlock?: number;
  wallets: { name: string; address: Address; agent: Address; createdBlock: number }[];
  tasks?: { id: Hex; label: string }[];
};

export function readDeployments(): Deployments {
  if (!existsSync(DEPLOYMENTS_PATH)) return { network: NETWORK, wallets: [] };
  return JSON.parse(readFileSync(DEPLOYMENTS_PATH, 'utf8')) as Deployments;
}

export type PayeeLabel = { address: string; label: string; labelZh?: string };
export function readPayees(): PayeeLabel[] {
  return existsSync(PAYEES_PATH) ? (JSON.parse(readFileSync(PAYEES_PATH, 'utf8')) as PayeeLabel[]) : [];
}
