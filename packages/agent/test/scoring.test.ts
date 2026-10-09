import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { scoreQuote } from '../src/scoring.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/quotes/${name}`, import.meta.url), 'utf8');
const NOW = new Date('2026-10-09T12:00:00.000Z');
const score = (name: string) => scoreQuote({ status: 200, body: fixture(name) }, { pair: 'ETH-USDC', now: NOW });

describe('scoreQuote (research R6)', () => {
  it('rates a body that is not JSON 10 malformed', () => expect(score('not-json.txt')).toEqual({ score: 10, tag: 'malformed' }));
  it('rates a missing asOf 10 malformed', () => expect(score('missing-asof.json')).toEqual({ score: 10, tag: 'malformed' }));
  it('rates the wrong pair 20 wrong-data', () => expect(score('wrong-pair.json')).toEqual({ score: 20, tag: 'wrong-data' }));
  it('rates price "0" 20 wrong-data', () => expect(score('zero-price.json')).toEqual({ score: 20, tag: 'wrong-data' }));
  it('rates asOf 301 s old 40 stale', () => expect(score('stale-301s.json')).toEqual({ score: 40, tag: 'stale' }));
  it('rates a fresh quote 90 accurate', () => expect(score('fresh.json')).toEqual({ score: 90, tag: 'accurate' }));
  it('accepts an already-parsed body', () =>
    expect(scoreQuote({ status: 200, body: JSON.parse(fixture('fresh.json')) }, { pair: 'ETH-USDC', now: NOW })).toEqual({ score: 90, tag: 'accurate' }));
  it('is deterministic: same input, same output (FR-011)', () => {
    for (const f of ['not-json.txt', 'missing-asof.json', 'wrong-pair.json', 'zero-price.json', 'stale-301s.json', 'fresh.json']) {
      expect(score(f)).toEqual(score(f));
    }
  });
  it('treats exactly 300 s as fresh', () =>
    expect(scoreQuote({ status: 200, body: { pair: 'ETH-USDC', price: '1', asOf: '2026-10-09T11:55:00.000Z' } }, { pair: 'ETH-USDC', now: NOW }).tag).toBe('accurate'));
});
