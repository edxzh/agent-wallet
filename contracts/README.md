# Contracts (Foundry)

`PolicyWallet` and `PolicyWalletFactory`: see `../specs/001-agent-wallet-demo/contracts/policy-wallet.md`.

Setup (once, needs [Foundry](https://book.getfoundry.sh/getting-started/installation)):

```bash
npm install                                  # installs @openzeppelin/contracts into ../node_modules
cd contracts
forge install foundry-rs/forge-std --no-git  # test library into lib/forge-std
forge build && forge test
```

OpenZeppelin comes from its official npm package (`@openzeppelin/contracts`), mapped in
`foundry.toml`. `forge-std` comes from Foundry's own installer.

## Trusted payees (feature 002)

`PolicyWallet` also enforces a reputation rule against the ERC-8004 registries on Base Sepolia
(`../specs/002-trusted-payees-erc8004/contracts/policy-wallet-reputation.md`). The implementation
is constructed with `(USDC, identityRegistry, reputationRegistry)`; `script/Deploy.s.sol` reads
the pinned registry proxies from `../config/erc8004.json`.

**Existing wallets keep their old code.** Wallets are EIP-1167 clones of one implementation, so
wallets created by 001's factory (including `research-bot-01`) don't have the new functions.
Recreate them from the new factory and move their funds (tasks.md T043).

Tests:

```bash
forge test                                      # unit, fuzz, invariant (fork tests skip)
RPC_URL=https://sepolia.base.org forge test     # + fork tests against the real USDC and registries
```

The ERC-8004 fork tests run at the pinned `forkBlock` in `../config/erc8004.json`.
