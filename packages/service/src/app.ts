import { Hono, type MiddlewareHandler } from 'hono';
import { HTTPFacilitatorClient, type FacilitatorClient } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { paymentMiddleware, x402ResourceServer } from '@x402/hono';

export type Env = { NETWORK: string; PAYEE_ADDRESS: string; FACILITATOR_URL: string };

export const TESTNET = 'eip155:84532';
export const PRICE = '$0.01'; // 10000 USDC base units
const PAIR = /^[A-Z]{2,10}-[A-Z]{2,10}$/;
const PRICES: Record<string, string> = { 'ETH-USDC': '2400.00', 'BTC-USDC': '60000.00', 'SOL-USDC': '150.00' };

/** Deterministic illustrative price: fixed table, else derived from the pair's letters. */
export function samplePrice(pair: string): string {
  if (PRICES[pair]) return PRICES[pair];
  let h = 0;
  for (const ch of pair) h = (h * 31 + ch.charCodeAt(0)) % 100_000;
  return (1 + h / 100).toFixed(2);
}

/**
 * The demo paid API (contracts/paid-service.md). `GET /quote` is paid through x402 `exact`
 * (0.01 test USDC on Base Sepolia, settled by the x402.org facilitator).
 */
export function createApp(opts: { facilitator?: (url: string) => FacilitatorClient } = {}) {
  const facilitatorFor = opts.facilitator ?? ((url: string) => new HTTPFacilitatorClient({ url }));
  const app = new Hono<{ Bindings: Env }>();
  const payment = new Map<string, MiddlewareHandler>();

  // Testnet only (constitution I): refuse to serve anything if misconfigured.
  app.use('*', async (c, next) => {
    if (c.env.NETWORK !== TESTNET) return c.json({ error: `refusing to run on ${c.env.NETWORK}` }, 500);
    await next();
  });

  app.get('/health', (c) => c.json({ ok: true, network: c.env.NETWORK, testnetOnly: true }));

  // Validate before payment, so a malformed request is never charged.
  app.use('/quote', async (c, next) => {
    const pair = c.req.query('pair') ?? 'ETH-USDC';
    if (!PAIR.test(pair)) return c.json({ error: 'bad pair; expected e.g. ETH-USDC' }, 400);
    await next();
  });

  app.use('/quote', async (c, next) => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(c.env.PAYEE_ADDRESS)) return c.json({ error: 'PAYEE_ADDRESS not configured' }, 500);
    const key = `${c.env.PAYEE_ADDRESS}|${c.env.FACILITATOR_URL}`;
    let mw = payment.get(key);
    if (!mw) {
      const server = new x402ResourceServer(facilitatorFor(c.env.FACILITATOR_URL)).register(
        TESTNET,
        new ExactEvmScheme(),
      );
      mw = paymentMiddleware(
        {
          'GET /quote': {
            accepts: { scheme: 'exact', price: PRICE, network: TESTNET, payTo: c.env.PAYEE_ADDRESS },
            description: 'Sample quote for the Yunshu agent wallet demo (test network only)',
          },
        },
        server,
      );
      payment.set(key, mw);
    }
    return mw(c, next);
  });

  app.get('/quote', (c) => {
    const pair = c.req.query('pair') ?? 'ETH-USDC';
    return c.json({
      pair,
      price: samplePrice(pair),
      asOf: new Date().toISOString(),
      note: 'Sample data for the Yunshu agent wallet demo. Test network only.',
    });
  });

  app.notFound((c) => c.json({ error: 'not found' }, 404));
  return app;
}
