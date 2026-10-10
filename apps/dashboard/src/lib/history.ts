import type { Entry, Labels, RowText } from './rows';
import { t, type Lang } from '../i18n';

export type WalletHistory = {
  address: string;
  name: string;
  paused: boolean;
  policy: { perPaymentCap: string; dailyBudget: string };
  payees: { address: string; label: string; labelZh?: string; allowed: boolean }[];
  tasks: { id: string; label: string; budget: string; spent: string }[];
  today: { day: number; spent: string };
  balance: string;
  events: Entry[];
};
export type ServiceSnapshot = { time: string; block: number; count: number; average: string; decimals: number; payable: boolean; reason?: string };
export type ServiceView = {
  key: string;
  label: { en: string; zh: string };
  agentId: string | null;
  claims: 'self' | 'reliable' | null;
  name?: string;
  description?: string;
  payTo: string | null;
  registeredWallet?: string;
  summary?: { count: number; average: string; decimals: number; block: number };
  payable: boolean;
  reason?: string;
  since: string;
  snapshots: ServiceSnapshot[];
};
export type History = {
  network: string;
  generatedAt: string;
  lastBlock: number;
  wallets: WalletHistory[];
  // 002: trusted payees (absent until set up)
  erc8004?: { identity: string; reputation: string; implementations: { identity: string; reputation: string }; pinnedOk: boolean };
  reputationRule?: { wallet: string; enabled: boolean; minAverage: number; minCount: number; trustedReviewers: { address: string; label: string }[] };
  services?: ServiceView[];
};

// The snapshot is optional at build time (e.g. before the first deploy).
const files = import.meta.glob<{ default: History }>('../data/history.json', { eager: true });
export const history: History | undefined = Object.values(files)[0]?.default;

export function labelsFor(w: WalletHistory, lang: Lang): Labels {
  const services = (history?.services ?? []).filter((s) => s.claims === 'self' && s.agentId !== null);
  return {
    payees: Object.fromEntries(w.payees.map((p) => [p.address.toLowerCase(), lang === 'zh' ? (p.labelZh ?? p.label) : p.label])),
    tasks: Object.fromEntries(w.tasks.map((x) => [x.id, x.label])),
    services: Object.fromEntries(services.map((s) => [s.agentId!, s.label[lang]])),
    serviceKeys: Object.fromEntries((history?.services ?? []).map((s) => [s.key, s.label[lang]])),
  };
}

export function rowTextFor(lang: Lang): RowText {
  const d = t(lang);
  return { ...d.row, reason: { ...d.reason, NOT_CONFIGURED: d.trust.notConfigured }, verify: d.live.verify };
}
