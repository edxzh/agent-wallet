# Quickstart: put the escrow on Base Sepolia (owner steps, T009–T010)

Run these on your machine, from the repo root, with `.env` holding `OPERATOR_PRIVATE_KEY` and
`AGENT_PRIVATE_KEY` (constitution IV: the operator key never leaves this machine). Every command
checks the chain id first and refuses anything but Base Sepolia. About 10 minutes.

Use your own terminal (not a chat), from the repo root. Each step prints only addresses and
transaction links, never a key.

```bash
cd ~/project/agent-wallet
alias cli='npm run -s cli -w packages/agent --'
RPC=https://sepolia.base.org
```

## 0. Gas

The operator (`0xc6E78B511c87688BC33C9db7539E5E0334B2Ad59`) pays for steps 1, 3 and 4, about
0.00002 ETH at 0.006 gwei. If a step fails with "insufficient funds", top it up from a Base
Sepolia faucet and rerun that step.

## 1. Deploy the escrow (operator)

```bash
cli deploy-escrow --pretty
ESCROW=$(node -p "require('./config/deployments.json').escrow"); echo $ESCROW
```

Writes `escrow` and `escrowBlock` to `config/deployments.json`. The operator key becomes the
escrow's owner (it can only return unattributed money, `recoverSurplus`). If it says
`escrow-exists`, the deploy already worked: go on to step 2.

## 2. The worker's agent key

Creates the key straight into `.env` (git-ignored) and prints only its address:

```bash
cast wallet new --json | python3 -c "import json,sys; x=json.load(sys.stdin)['data'][0]; open('.env','a').write('\nWORKER_AGENT_PRIVATE_KEY='+x['private_key']+'\n'); print(x['address'])"
WORKER_AGENT=<the address it printed>
```

Give it a little gas from the agent key, for its `deliver` calls:

```bash
set -a; source .env; set +a
cast send $WORKER_AGENT --value 0.0002ether --private-key $AGENT_PRIVATE_KEY --rpc-url $RPC
```

## 3. The worker's wallet (operator)

```bash
cli create-wallet --name worker-bot-01 --agent $WORKER_AGENT --cap 1 --daily 5 --pretty
WORKER=$(node -p "require('./config/deployments.json').wallets.find(w=>w.name==='worker-bot-01').address"); echo $WORKER
```

The worker is paid into this PolicyWallet; it needs no USDC to start.

## 4. Let research-bot-01 hire it (operator)

```bash
cli set-payee $ESCROW --allow --wallet research-bot-01 --pretty
cli set-payee $WORKER --allow --wallet research-bot-01 --pretty
```

The first lets the wallet pay the escrow at all (the cap and budgets still apply to each job);
the second is what the escrow's `checkPayee` asks about the worker.

## 5. Check (read-only)

Expect `true`, `0`, then the operator address:

```bash
BOT=0xC788272Fe9c76810ef1bA2539B56822405eDb0Fc   # research-bot-01
cast call $BOT "isPayeeAllowed(address)(bool)" $ESCROW --rpc-url $RPC
cast call $BOT "checkPayee(address,bool,uint256)(uint8)" $WORKER false 0 --rpc-url $RPC
cast call $ESCROW "owner()(address)" --rpc-url $RPC
```

## 6. Record and share

```bash
git add config/deployments.json && git commit -m "chore(004): escrow and worker-bot-01 on Base Sepolia"
grep '^WORKER_AGENT_PRIVATE_KEY=' .env | cut -d= -f2 | gh secret set WORKER_AGENT_PRIVATE_KEY
```

## Done (2026-10-12)

| | Address |
|---|---|
| JobEscrow | [`0xf12b4e917c64ca692f6af8c635409740e66ff721`](https://sepolia.basescan.org/address/0xf12b4e917c64ca692f6af8c635409740e66ff721) (block 48003819) |
| worker-bot-01 (wallet) | [`0x6D964D762C6610DCb9f5eD380591d5E8B3B15bce`](https://sepolia.basescan.org/address/0x6D964D762C6610DCb9f5eD380591d5E8B3B15bce) |
| worker-bot-01 (agent key) | `0x6ad2A4f2622ADB774A38198686610Ee2b4dBa40A` |

Verified read-only: the escrow's token is Base Sepolia USDC and its owner is the operator;
research-bot-01 allows the escrow and the worker, and `checkPayee(worker)` is `NONE`; the worker
wallet's agent is the new key, with 0.0002 ETH for gas. `WORKER_AGENT_PRIVATE_KEY` is set as a
GitHub secret.

## Rehearsed

2026-10-12, on a local anvil fork of Base Sepolia with a throwaway key (nothing broadcast):
`deploy-escrow` deployed and recorded the escrow, a second run refused to replace it, and
`create-wallet --name worker-bot-01` created the worker wallet. Steps 4–5 need the real operator
key, so they weren't rehearsed; they use the same `set-payee` command as 001.
