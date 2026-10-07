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
