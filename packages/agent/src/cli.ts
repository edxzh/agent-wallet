#!/usr/bin/env node
/**
 * agent-wallet CLI (contracts/agent-cli.md). Base Sepolia only: every command checks the chain id
 * first and exits 1 otherwise. Prints one JSON line per event (--pretty for humans). Never prints keys.
 *
 * Exit codes: 0 ok · 1 wrong network or config · 2 an outcome differed from what was expected ·
 * 3 insufficient funds · 4 an ERC-8004 registry implementation changed (002, research R8).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  getAddress,
  isAddress,
  keccak256,
  parseEventLogs,
  toHex,
  zeroHash,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { policyWalletAbi, policyWalletBytecode, policyWalletFactoryAbi, policyWalletFactoryBytecode } from './abi.js';
import { blockRanges, formatUsdc, guardedPublicClient, parseUsdc, usdcAbi, walletClientFor, type PublicClient } from './chain.js';
import { WrongNetworkError } from './chainGuard.js';
import { DEPLOYMENTS_PATH, loadConfig, readDeployments, readPayees, ROOT, txUrl, USDC, type Deployments } from './config.js';
import { payUrl } from './pay.js';
import { rateOutcome } from './rate.js';
import { reasonName } from './reasons.js';
import { identityAbi, IDENTITY_REGISTRY, RegistryChangedError, REPUTATION_REGISTRY, reputationAbi } from './registries.js';
import { EXIT, runScenario } from './scenario.js';
import { readWalletState, taskIdOf } from './state.js';

class ConfigError extends Error {}

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    pretty: { type: 'boolean' },
    wallet: { type: 'string' },
    agent: { type: 'string' },
    name: { type: 'string' },
    cap: { type: 'string' },
    daily: { type: 'string' },
    budget: { type: 'string' },
    task: { type: 'string' },
    allow: { type: 'boolean' },
    deny: { type: 'boolean' },
    to: { type: 'string' },
    seed: { type: 'string' },
    blocks: { type: 'string' },
    api: { type: 'string' },
    'min-avg': { type: 'string' },
    'min-count': { type: 'string' },
    off: { type: 'boolean' },
    remove: { type: 'boolean' },
    rate: { type: 'boolean' },
    service: { type: 'string' },
  },
});
const [command, ...args] = positionals;

const out = (event: string, data: Record<string, unknown> = {}) => {
  const line = { event, ...data };
  const json = JSON.stringify(line, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  if (!flags.pretty) return console.log(json);
  console.log(`• ${event}`);
  for (const [k, v] of Object.entries(data)) console.log(`    ${k}: ${typeof v === 'object' ? JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)) : String(v)}`);
};

const cfg = loadConfig();
const need = <T>(v: T | undefined, what: string): T => {
  if (v === undefined || v === '') throw new ConfigError(`${what} is not set`);
  return v;
};
const operatorClient = () => walletClientFor(cfg.rpcUrl, need(cfg.operatorKey, 'OPERATOR_PRIVATE_KEY'));
const agentClient = () => walletClientFor(cfg.rpcUrl, need(cfg.agentKey, 'AGENT_PRIVATE_KEY'));

function saveDeployments(d: Deployments) {
  writeFileSync(DEPLOYMENTS_PATH, JSON.stringify(d, null, 2) + '\n');
}

/** --wallet <name|address>, else WALLET_ADDRESS, else the first wallet in config/deployments.json. */
function resolveWallet(): Address {
  const d = readDeployments();
  const want = flags.wallet ?? process.env.WALLET_ADDRESS;
  if (want && isAddress(want)) return getAddress(want);
  const found = want ? d.wallets.find((w) => w.name === want) : d.wallets[0];
  if (!found) throw new ConfigError(want ? `No wallet named ${want} in config/deployments.json` : 'No wallet yet: run create-wallet');
  return getAddress(found.address);
}

/** A reviewer: an address, or the name of a wallet in config/deployments.json. */
function resolveReviewer(v: string): Address {
  if (isAddress(v)) return getAddress(v);
  const w = readDeployments().wallets.find((x) => x.name === v);
  if (!w) throw new ConfigError(`${v} is neither an address nor a wallet in config/deployments.json`);
  return getAddress(w.address);
}

type Service = { key: string; route: string; agentId: string | number | null; payTo: string | null };
function readServices(): Service[] {
  const path = `${ROOT}config/services.json`;
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as { services: Service[] }).services : [];
}

function taskId(label: string): Hex {
  return label ? taskIdOf(label) : zeroHash;
}

/** The public RPC load-balances across nodes that can lag a block: wait until code is visible. */
async function waitForCode(pub: PublicClient, address: Address) {
  for (let i = 0; i < 30; i++) {
    if (await pub.getCode({ address })) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`No code at ${address} after 30 s`);
}

async function send(pub: PublicClient, hash: Hex, event: string, data: Record<string, unknown> = {}) {
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`Transaction reverted: ${txUrl(hash)}`);
  out(event, { ...data, tx: txUrl(hash) });
  return receipt;
}

async function operatorWrite(pub: PublicClient, functionName: string, args: unknown[], event: string, data: Record<string, unknown> = {}) {
  const wallet = resolveWallet();
  const hash = await operatorClient().writeContract({ address: wallet, abi: policyWalletAbi, functionName, args } as never);
  return send(pub, hash, event, { wallet, ...data });
}

const commands: Record<string, (pub: PublicClient) => Promise<number>> = {
  /** Deploy the PolicyWallet implementation and factory (operator, once). */
  async 'deploy-factory'(pub) {
    const op = operatorClient();
    let impl = readDeployments().implementation;
    // Reuse only an implementation with this code's ERC-8004 registries (001's has none).
    const current = impl
      ? await pub.readContract({ address: impl, abi: policyWalletAbi, functionName: 'identityRegistry' }).catch(() => undefined)
      : undefined;
    if (impl && current === IDENTITY_REGISTRY) {
      out('implementation-reused', { implementation: impl });
    } else {
      const implHash = await op.deployContract({ abi: policyWalletAbi, bytecode: policyWalletBytecode, args: [USDC, IDENTITY_REGISTRY, REPUTATION_REGISTRY] });
      impl = (await pub.waitForTransactionReceipt({ hash: implHash })).contractAddress!;
      saveDeployments({ ...readDeployments(), implementation: impl });
      out('implementation-deployed', { implementation: impl, tx: txUrl(implHash) });
    }
    await waitForCode(pub, impl);
    const facHash = await op.deployContract({ abi: policyWalletFactoryAbi, bytecode: policyWalletFactoryBytecode, args: [impl] });
    const receipt = await pub.waitForTransactionReceipt({ hash: facHash });
    const factory = receipt.contractAddress!;
    out('factory-deployed', { factory, tx: txUrl(facHash) });
    saveDeployments({ ...readDeployments(), implementation: impl, factory, factoryBlock: Number(receipt.blockNumber) });
    return EXIT.OK;
  },

  /** create-wallet --name <n> --cap <usdc> --daily <usdc> [--agent <addr>] (operator) */
  async 'create-wallet'(pub) {
    const d = readDeployments();
    const factory = need(d.factory, 'factory (run deploy-factory first)');
    const agent = flags.agent ? getAddress(flags.agent) : privateKeyToAccount(need(cfg.agentKey, 'AGENT_PRIVATE_KEY or --agent')).address;
    const name = need(flags.name, '--name');
    const hash = await operatorClient().writeContract({
      address: factory,
      abi: policyWalletFactoryAbi,
      functionName: 'createWallet',
      args: [agent, name, parseUsdc(need(flags.cap, '--cap')), parseUsdc(need(flags.daily, '--daily'))],
    });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    const created = parseEventLogs({ abi: policyWalletFactoryAbi, logs: receipt.logs, eventName: 'WalletCreated' })[0];
    if (!created) throw new Error('No WalletCreated event');
    const address = created.args.wallet;
    await waitForCode(pub, address);
    d.wallets = [...d.wallets.filter((w) => w.name !== name), { name, address, agent, createdBlock: Number(receipt.blockNumber) }];
    saveDeployments(d);
    out('wallet-created', { name, wallet: address, agent, tx: txUrl(hash) });
    return EXIT.OK;
  },

  /** fund <usdc> — operator sends test USDC to the wallet. */
  async fund(pub) {
    const wallet = resolveWallet();
    const amount = parseUsdc(need(args[0], 'amount'));
    const hash = await operatorClient().writeContract({ address: USDC, abi: usdcAbi, functionName: 'transfer', args: [wallet, amount] });
    await send(pub, hash, 'funded', { wallet, amount: formatUsdc(amount) });
    return EXIT.OK;
  },

  /** set-payee <addr> --allow|--deny (operator) */
  async 'set-payee'(pub) {
    const payee = getAddress(need(args[0], 'payee address'));
    if (flags.allow === flags.deny) throw new ConfigError('Pass exactly one of --allow or --deny');
    await operatorWrite(pub, 'setPayee', [payee, Boolean(flags.allow)], 'payee-set', { payee, allowed: Boolean(flags.allow) });
    return EXIT.OK;
  },

  /** set-task <label> --budget <usdc> (operator) */
  async 'set-task'(pub) {
    const label = need(args[0], 'task label');
    const budget = parseUsdc(need(flags.budget, '--budget'));
    const id = taskIdOf(label);
    await operatorWrite(pub, 'setTask', [id, budget], 'task-set', { task: label, taskId: id, budget: formatUsdc(budget) });
    const d = readDeployments();
    d.tasks = [...(d.tasks ?? []).filter((t) => t.id !== id), { id, label }];
    saveDeployments(d);
    return EXIT.OK;
  },

  /** set-cap <usdc> (operator) */
  async 'set-cap'(pub) {
    const wallet = resolveWallet();
    const daily = (await pub.readContract({ address: wallet, abi: policyWalletAbi, functionName: 'dailyBudget' })) as bigint;
    const cap = parseUsdc(need(args[0], 'cap'));
    await operatorWrite(pub, 'setPolicy', [cap, daily], 'policy-set', { perPaymentCap: formatUsdc(cap), dailyBudget: formatUsdc(daily) });
    return EXIT.OK;
  },

  /** set-daily <usdc> (operator) */
  async 'set-daily'(pub) {
    const wallet = resolveWallet();
    const cap = (await pub.readContract({ address: wallet, abi: policyWalletAbi, functionName: 'perPaymentCap' })) as bigint;
    const daily = parseUsdc(need(args[0], 'daily budget'));
    await operatorWrite(pub, 'setPolicy', [cap, daily], 'policy-set', { perPaymentCap: formatUsdc(cap), dailyBudget: formatUsdc(daily) });
    return EXIT.OK;
  },

  async pause(pub) {
    await operatorWrite(pub, 'pause', [], 'paused');
    return EXIT.OK;
  },

  async unpause(pub) {
    await operatorWrite(pub, 'unpause', [], 'unpaused');
    return EXIT.OK;
  },

  /** withdraw <usdc> [--to <addr>] (operator; test funds back to the operator by default) */
  async withdraw(pub) {
    const amount = parseUsdc(need(args[0], 'amount'));
    const to = flags.to ? getAddress(flags.to) : operatorClient().account.address;
    await operatorWrite(pub, 'withdraw', [to, amount], 'withdrawn', { to, amount: formatUsdc(amount) });
    return EXIT.OK;
  },

  /** pay <url> [--task <label>] [--rate] (agent). --rate scores a settled, identity-checked payment and rates it. */
  async pay(pub) {
    const url = need(args[0], 'url');
    const wallet = resolveWallet();
    const r = await payUrl(url, { wallet, agentKey: need(cfg.agentKey, 'AGENT_PRIVATE_KEY'), taskId: taskId(flags.task ?? ''), rpcUrl: cfg.rpcUrl });
    if (r.kind === 'settled') {
      out('authorized', { wallet, nonce: r.nonce, amount: formatUsdc(r.amount), payee: r.payee, agentId: r.agentId, tx: txUrl(r.authorizeTx) });
      out('settled', { status: r.status, settlementTx: r.settlementTx ? txUrl(r.settlementTx) : undefined, body: r.body });
      if (flags.rate) {
        const d = await rateOutcome(r, { url, now: new Date(), wallet, clients: { publicClient: pub, walletClient: agentClient() } });
        if (d.kind === 'rated') {
          out('rated', { wallet, nonce: r.nonce, agentId: d.agentId, score: d.score, tag: d.tag, feedbackIndex: d.feedbackIndex, tx: txUrl(d.txHash) });
        } else out('not-rated', { reason: d.reason });
      }
      return EXIT.OK;
    }
    if (r.kind === 'refused') {
      out('refused', { wallet, reason: r.reason, nonce: r.nonce, tx: txUrl(r.authorizeTx) });
      return r.reason === 'INSUFFICIENT_FUNDS' ? EXIT.INSUFFICIENT_FUNDS : EXIT.MISMATCH;
    }
    out('failed', { ...r, authorizeTx: r.authorizeTx ? txUrl(r.authorizeTx) : undefined });
    return EXIT.MISMATCH;
  },

  /** set-reputation --wallet <w> --min-avg <0-100> --min-count <n> [--off] (operator, 002) */
  async 'set-reputation'(pub) {
    const enabled = !flags.off;
    const minAvg = Number(need(flags['min-avg'], '--min-avg'));
    const minCount = BigInt(need(flags['min-count'], '--min-count'));
    if (!Number.isInteger(minAvg) || minAvg < 0 || minAvg > 100) throw new ConfigError('--min-avg must be 0–100');
    await operatorWrite(pub, 'setReputationRule', [enabled, minAvg, minCount], 'reputation-rule-set', { enabled, minAverage: minAvg, minCount });
    return EXIT.OK;
  },

  /** trust-reviewer --wallet <w> <addr> [--remove] (operator, 002) */
  async 'trust-reviewer'(pub) {
    const reviewer = resolveReviewer(need(args[0], 'reviewer address or wallet name'));
    await operatorWrite(pub, 'setTrustedReviewer', [reviewer, !flags.remove], 'trusted-reviewer-set', { reviewer, trusted: !flags.remove });
    return EXIT.OK;
  },

  /** reputation [--service <key>] [--wallet <w>] — per demo service: identity, registry wallet, trusted summary, checkPayee (read-only, 002). */
  async reputation(pub) {
    const wallet = resolveWallet();
    const trusted = (await pub.readContract({ address: wallet, abi: policyWalletAbi, functionName: 'trustedReviewers' })) as readonly Address[];
    const [enabled, minAverage, minCount] = (await pub.readContract({ address: wallet, abi: policyWalletAbi, functionName: 'reputationRule' })) as readonly [boolean, number, bigint];
    out('reputation-rule', { wallet, enabled, minAverage, minCount, trustedReviewers: trusted });
    for (const s of readServices().filter((x) => !flags.service || x.key === flags.service)) {
      if (s.agentId === null || s.agentId === undefined) {
        out('service', { key: s.key, registered: false });
        continue;
      }
      const id = BigInt(s.agentId);
      const [owner, registeredWallet] = await Promise.all([
        pub.readContract({ address: IDENTITY_REGISTRY, abi: identityAbi, functionName: 'ownerOf', args: [id] }).catch(() => null),
        pub.readContract({ address: IDENTITY_REGISTRY, abi: identityAbi, functionName: 'getAgentWallet', args: [id] }),
      ]);
      const summary = trusted.length
        ? await pub.readContract({ address: REPUTATION_REGISTRY, abi: reputationAbi, functionName: 'getSummary', args: [id, trusted, '', ''] })
        : null;
      const payTo = s.payTo ? getAddress(s.payTo) : registeredWallet;
      const check = (await pub.readContract({ address: wallet, abi: policyWalletAbi, functionName: 'checkPayee', args: [payTo, true, id] })) as number;
      out('service', {
        key: s.key,
        agentId: id,
        owner,
        registeredWallet,
        payTo,
        walletMatches: getAddress(registeredWallet) === getAddress(payTo),
        trustedCount: summary?.[0],
        trustedAverage: summary?.[1],
        decimals: summary?.[2],
        payable: check === 0,
        reason: reasonName(check),
      });
    }
    return EXIT.OK;
  },

  /** status — rules, spend, balances (read-only). */
  async status(pub) {
    const wallet = resolveWallet();
    const d = readDeployments();
    const payees = readPayees().filter((p) => isAddress(p.address)).map((p) => getAddress(p.address));
    const tasks = d.tasks ?? [];
    const s = await readWalletState(pub, wallet, tasks.map((t) => t.id), payees);
    const [operator, agent, name] = await Promise.all(
      (['operator', 'agent', 'name'] as const).map((fn) => pub.readContract({ address: wallet, abi: policyWalletAbi, functionName: fn })),
    );
    out('status', {
      wallet,
      name,
      operator,
      agent,
      paused: s.paused,
      perPaymentCap: formatUsdc(s.perPaymentCap),
      dailyBudget: formatUsdc(s.dailyBudget),
      spentToday: formatUsdc(s.spentToday),
      remainingToday: formatUsdc(s.dailyBudget > s.spentToday ? s.dailyBudget - s.spentToday : 0n),
      balance: formatUsdc(s.balance),
      tasks: tasks.map((t) => ({ label: t.label, budget: formatUsdc(s.tasks[t.id]!.budget), spent: formatUsdc(s.tasks[t.id]!.spent) })),
      payees: readPayees().map((p) => ({ label: p.label, address: p.address, allowed: s.payees[getAddress(p.address)] ?? false })),
    });
    return EXIT.OK;
  },

  /** release-expired [--blocks n] — return budget held by authorizations that expired unused. */
  async 'release-expired'(pub) {
    const wallet = resolveWallet();
    const latest = await pub.getBlockNumber();
    const created = BigInt(readDeployments().wallets.find((w) => getAddress(w.address) === wallet)?.createdBlock ?? 0);
    const span = BigInt(flags.blocks ?? '15000'); // ≈ 8 h at 2 s blocks; runs are every 6 h
    const from = latest - span > created ? latest - span : created;
    const now = (await pub.getBlock()).timestamp;
    let released = 0;
    for (const [fromBlock, toBlock] of blockRanges(from, latest)) {
      const logs = await pub.getContractEvents({ address: wallet, abi: policyWalletAbi, eventName: 'PaymentAuthorized', fromBlock, toBlock });
      for (const log of logs) {
        const { nonce, validBefore } = log.args as { nonce: Hex; validBefore: bigint };
        if (validBefore > now) continue;
        const [, , , , , active] = (await pub.readContract({ address: wallet, abi: policyWalletAbi, functionName: 'reservations', args: [nonce] })) as readonly unknown[];
        if (!active) continue;
        const used = await pub.readContract({ address: USDC, abi: usdcAbi, functionName: 'authorizationState', args: [wallet, nonce] });
        if (used) continue;
        const hash = await agentClient().writeContract({ address: wallet, abi: policyWalletAbi, functionName: 'release', args: [nonce] });
        await send(pub, hash, 'released', { wallet, nonce });
        released++;
      }
    }
    out('release-expired-done', { wallet, scannedFromBlock: from, released });
    return EXIT.OK;
  },

  /** run-scenario [--seed n] [--api <base url>] — the scripted agent (US5). */
  async 'run-scenario'(pub) {
    const wallet = resolveWallet();
    const agentKey = need(cfg.agentKey, 'AGENT_PRIVATE_KEY');
    const servicePayee = need(cfg.servicePayee ?? readPayees().map((p) => p.address).find((a) => isAddress(a)) as Address | undefined, 'SERVICE_PAYEE');
    const api = (flags.api ?? process.env.API_URL ?? 'https://api.demo.yunshu.ai').replace(/\/$/, '');
    const seed = Number(flags.seed ?? Math.floor(Date.now() / 21_600_000)); // a new plan every 6 h
    const marketTask = taskIdOf('market-research');
    const probeTask = taskIdOf('archive-research');
    const agent = agentClient();
    out('scenario-start', { wallet, api, seed });
    return runScenario(
      {
        readState: () => readWalletState(pub, wallet, [marketTask, probeTask], [servicePayee]),
        pay: (pair) => payUrl(`${api}/quote?pair=${pair}`, { wallet, agentKey, taskId: marketTask, rpcUrl: cfg.rpcUrl }),
        async probe(a) {
          const nonce = keccak256(toHex(`probe:${wallet}:${Date.now()}:${Math.random()}`));
          const hash = await agent.writeContract({
            address: wallet,
            abi: policyWalletAbi,
            functionName: 'authorize',
            args: [nonce, a.payee, a.amount, 0n, a.validBefore, a.taskId],
          });
          const receipt = await pub.waitForTransactionReceipt({ hash });
          const events = parseEventLogs({ abi: policyWalletAbi, logs: receipt.logs });
          const refused = events.find((e) => e.eventName === 'PaymentRefused');
          return refused && refused.eventName === 'PaymentRefused'
            ? { kind: 'refused', reason: reasonName(Number(refused.args.reason)), nonce, txHash: hash }
            : { kind: 'authorized', reason: 'NONE', nonce, txHash: hash };
        },
        servicePayee,
        quoteAmount: 10_000n,
        marketTask,
        probeTask,
        strangerAddress: privateKeyToAccount(generatePrivateKey()).address,
        log: (line) => out('scenario-step', line),
      },
      seed,
    );
  },
};

async function main(): Promise<number> {
  const run = command ? commands[command] : undefined;
  if (!run) {
    console.error(`Usage: agent-wallet <${Object.keys(commands).join(' | ')}> [--pretty]`);
    return EXIT.CONFIG;
  }
  const pub = await guardedPublicClient(cfg.rpcUrl); // Base Sepolia only, before anything else
  return run(pub);
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const e = err as Error & { shortMessage?: string; details?: string };
    out('error', { name: e.name, message: e.shortMessage ?? e.message, details: e.details });
    if (err instanceof RegistryChangedError) process.exit(EXIT.REGISTRY_CHANGED);
    process.exit(err instanceof WrongNetworkError || err instanceof ConfigError ? EXIT.CONFIG : EXIT.MISMATCH);
  });

