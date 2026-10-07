import { Hono } from 'hono';

type Env = { NETWORK: string; PAYEE_ADDRESS: string; FACILITATOR_URL: string };

const TESTNET = 'eip155:84532';
const app = new Hono<{ Bindings: Env }>();

// Testnet only (constitution I): refuse to serve anything if misconfigured.
app.use('*', async (c, next) => {
  if (c.env.NETWORK !== TESTNET) return c.json({ error: `refusing to run on ${c.env.NETWORK}` }, 500);
  await next();
});

app.get('/health', (c) => c.json({ ok: true, network: c.env.NETWORK, testnetOnly: true }));

// GET /quote (x402-paid) is added in task T022.

export default app;
