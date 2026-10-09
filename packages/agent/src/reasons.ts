/** Contract `Reason` values (contracts/src/Reason.sol). Index = on-chain uint8. Append only. */
export const REASONS = [
  'NONE',
  'PAUSED',
  'INVALID_AMOUNT',
  'PAYEE_NOT_ALLOWED',
  'OVER_PER_PAYMENT_CAP',
  'OVER_TASK_BUDGET',
  'OVER_DAILY_BUDGET',
  'INSUFFICIENT_FUNDS',
  // 002: trusted payees (ERC-8004)
  'PAYEE_IDENTITY_UNVERIFIED',
  'PAYEE_IDENTITY_MISMATCH',
  'REPUTATION_UNAVAILABLE',
  'NOT_ENOUGH_TRUSTED_REVIEWS',
  'PAYEE_REPUTATION_TOO_LOW',
] as const;
export type Reason = (typeof REASONS)[number];

export const reasonName = (code: number): Reason | `UNKNOWN_${number}` => REASONS[code] ?? `UNKNOWN_${code}`;

/** Plain-language text for 002's reasons (specs/002-trusted-payees-erc8004/contracts/dashboard.md). */
export const REPUTATION_REASON_TEXT: Record<
  'PAYEE_IDENTITY_UNVERIFIED' | 'PAYEE_IDENTITY_MISMATCH' | 'REPUTATION_UNAVAILABLE' | 'NOT_ENOUGH_TRUSTED_REVIEWS' | 'PAYEE_REPUTATION_TOO_LOW',
  { en: string; zh: string }
> = {
  PAYEE_IDENTITY_UNVERIFIED: { en: 'Service has no verified identity', zh: '服务没有经过验证的身份' },
  PAYEE_IDENTITY_MISMATCH: { en: "Service claimed someone else's identity", zh: '服务冒用了他人的身份' },
  REPUTATION_UNAVAILABLE: { en: "Couldn't read reputation, so it didn't pay", zh: '无法读取信誉，因此未付款' },
  NOT_ENOUGH_TRUSTED_REVIEWS: { en: 'Not enough reviews from trusted reviewers yet', zh: '可信评价数量还不够' },
  PAYEE_REPUTATION_TOO_LOW: { en: 'Trusted reviewers rate this service too low', zh: '可信评价方给这个服务的评分太低' },
};
