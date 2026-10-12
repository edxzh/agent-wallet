# Quickstart: put the escrow on Base Sepolia (owner steps, T009–T010)

Run these on your machine, from the repo root, with `.env` holding `OPERATOR_PRIVATE_KEY` and
`AGENT_PRIVATE_KEY` (constitution IV: the operator key never leaves this machine). Every command
checks the chain id first and refuses anything but Base Sepolia. About 10 minutes.

`cli` below means `npm run cli -w packages/agent --`.

## 0. Gas

Checked 2026-10-12 at 0.006 gwei: the operator (`0xc6E7…Ad59`) holds 0.000035 ETH, enough for
steps 1, 3 and 4 (about 0.00002 ETH), but tight. Top it up from a Base Sepolia faucet if a step
fails with "insufficient funds".

## 1. Deploy the escrow (operator)

```bash
cli deploy-escrow --pretty
```

Prints `escrow-deployed` with the address and writes `escrow` and `escrowBlock` to
`config/deployments.json`. The operator key becomes the escrow's owner (it can only return
unattributed money, `recoverSurplus`). Running it again refuses to replace a deployed escrow.

## 2. The worker's agent key

```bash
cast wallet new        # prints an address and a private key
```

Put the private key in `.env` as `WORKER_AGENT_PRIVATE_KEY` (never in a commit or chat). Give its
address a little gas from the agent key (it holds ~0.00077 ETH):

```bash
source .env
cast send <worker agent address> --value 0.0002ether --private-key $AGENT_PRIVATE_KEY --rpc-url https://sepolia.base.org
```

## 3. The worker's wallet (operator)

```bash
cli create-wallet --name worker-bot-01 --agent <worker agent address> --cap 1 --daily 5 --pretty
```

The worker receives payments into this PolicyWallet; it needs no USDC to start.

## 4. Let research-bot-01 hire it (operator)

```bash
cli set-payee <escrow address> --allow --wallet research-bot-01 --pretty
cli set-payee <worker-bot-01 address> --allow --wallet research-bot-01 --pretty
```

The first lets the wallet pay the escrow at all (cap and budgets still apply to each job); the
second is the escrow's `checkPayee` on the worker.

## 5. Check (read-only)

```bash
W=0xC788272Fe9c76810ef1bA2539B56822405eDb0Fc   # research-bot-01
cast call $W "isPayeeAllowed(address)(bool)" <escrow address> --rpc-url https://sepolia.base.org                  # true
cast call $W "checkPayee(address,bool,uint256)(uint8)" <worker-bot-01 address> false 0 --rpc-url https://sepolia.base.org   # 0 (NONE)
cast call <escrow address> "owner()(address)" --rpc-url https://sepolia.base.org                                   # the operator
```

## 6. Record and share

```bash
git add config/deployments.json && git commit -m "chore(004): escrow and worker-bot-01 on Base Sepolia"
gh secret set WORKER_AGENT_PRIVATE_KEY      # paste the key when asked; for the scheduled run (T011)
```

Then tell Claude the escrow and worker-bot-01 addresses (or just that it's done: they are in
`config/deployments.json`), and T011 (the scheduled hire / dispute / timeout) can start.

## Rehearsed

2026-10-12, on a local anvil fork of Base Sepolia with a throwaway key (nothing broadcast):
`deploy-escrow` deployed and recorded the escrow, a second run refused to replace it, and
`create-wallet --name worker-bot-01` created the worker wallet. Steps 4–5 need the real operator
key, so they weren't rehearsed; they use the same `set-payee` command as 001.
