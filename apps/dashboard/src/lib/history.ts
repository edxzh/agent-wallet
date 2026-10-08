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
export type History = { network: string; generatedAt: string; lastBlock: number; wallets: WalletHistory[] };

// The snapshot is optional at build time (e.g. before the first deploy).
const files = import.meta.glob<{ default: History }>('../data/history.json', { eager: true });
export const history: History | undefined = Object.values(files)[0]?.default;

export function labelsFor(w: WalletHistory, lang: Lang): Labels {
  return {
    payees: Object.fromEntries(w.payees.map((p) => [p.address.toLowerCase(), lang === 'zh' ? (p.labelZh ?? p.label) : p.label])),
    tasks: Object.fromEntries(w.tasks.map((x) => [x.id, x.label])),
  };
}

export function rowTextFor(lang: Lang): RowText {
  const d = t(lang);
  return { ...d.row, reason: d.reason, verify: d.live.verify };
}
