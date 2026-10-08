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
] as const;
export type Reason = (typeof REASONS)[number];

export const reasonName = (code: number): Reason | `UNKNOWN_${number}` => REASONS[code] ?? `UNKNOWN_${code}`;
