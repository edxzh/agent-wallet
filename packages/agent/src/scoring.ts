/** Deterministic rating of a quote response (research R6, FR-011). Pure: no I/O, no clock. */

export type ScoreTag = 'accurate' | 'stale' | 'wrong-data' | 'malformed';
export const STALE_AFTER_S = 300;

export function scoreQuote(res: { status: number; body: unknown }, req: { pair: string; now: Date }): { score: number; tag: ScoreTag } {
  let body = res.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return { score: 10, tag: 'malformed' };
    }
  }
  const q = body as { pair?: unknown; price?: unknown; asOf?: unknown } | null;
  if (!q || typeof q !== 'object' || typeof q.pair !== 'string' || typeof q.price !== 'string' || typeof q.asOf !== 'string') {
    return { score: 10, tag: 'malformed' };
  }
  const asOf = Date.parse(q.asOf);
  const price = Number(q.price);
  if (Number.isNaN(asOf) || Number.isNaN(price)) return { score: 10, tag: 'malformed' };
  if (q.pair !== req.pair || !(price > 0)) return { score: 20, tag: 'wrong-data' };
  if ((req.now.getTime() - asOf) / 1000 > STALE_AFTER_S) return { score: 40, tag: 'stale' };
  return { score: 90, tag: 'accurate' };
}
