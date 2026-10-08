# Contract: PolicyWallet reputation extension (Solidity, Base Sepolia)

These are **additions** to [001's PolicyWallet interface](../../001-agent-wallet-demo/contracts/policy-wallet.md).
Nothing in 001's interface is removed or changed:
- 001's `authorize` keeps its signature and behaviour (no identity claimed);
- the `Reason` enum is extended **by appending only**.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

enum Reason { NONE, PAUSED, INVALID_AMOUNT, PAYEE_NOT_ALLOWED, OVER_PER_PAYMENT_CAP,
              OVER_TASK_BUDGET, OVER_DAILY_BUDGET, INSUFFICIENT_FUNDS,
              // ── 002 ──
              PAYEE_IDENTITY_UNVERIFIED,   // 8
              PAYEE_IDENTITY_MISMATCH,     // 9
              REPUTATION_UNAVAILABLE,      // 10
              NOT_ENOUGH_TRUSTED_REVIEWS,  // 11
              PAYEE_REPUTATION_TOO_LOW }   // 12

/// Vendored subset of the deployed ERC-8004 v2.0.0 registries (research R1). Nothing else is called.
interface IERC8004Identity {
    function getAgentWallet(uint256 agentId) external view returns (address);
}
interface IERC8004Reputation {
    function getSummary(uint256 agentId, address[] calldata clients, string calldata tag1, string calldata tag2)
        external view returns (uint64 count, int128 value, uint8 decimals);
    function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string calldata tag1,
        string calldata tag2, string calldata endpoint, string calldata feedbackURI, bytes32 feedbackHash) external;
    function getLastIndex(uint256 agentId, address client) external view returns (uint64);
}

interface IPolicyWalletReputation /* extends IPolicyWallet (001) */ {
    // ── Record (new events; 001's events unchanged) ──────────────────────────────────
    /// Emitted by authorizeWithIdentity on success, right after 001's PaymentAuthorized for the same nonce.
    event PayeeIdentityVerified(bytes32 indexed nonce, uint256 indexed agentId, address indexed payee);
    /// Emitted by rate(); the registry's own NewFeedback event is emitted in the same transaction.
    event PaymentRated(bytes32 indexed nonce, uint256 indexed agentId, uint8 score, string tag, uint64 feedbackIndex);
    // RuleChanged (001) gains fields: "repEnabled" | "repMinAverage" | "repMinCount" | "trustedReviewer" (key = reviewer, 0/1)

    // ── Agent ────────────────────────────────────────────────────────────────────────
    /// Same as 001 authorize(), plus a claimed ERC-8004 identity for the payee. Check order:
    /// data-model.md, "Check order". Never reverts on a policy failure. It reverts only for
    /// a non-agent caller, a reused nonce, or gasleft() too low for the registry calls.
    function authorizeWithIdentity(bytes32 nonce, address payee, uint256 amount, uint256 validAfter,
        uint256 validBefore, bytes32 taskId, uint256 payeeAgentId) external returns (bool);

    /// Publishes one rating for a settled, identity-checked payment of this wallet, with the
    /// wallet as the reviewer. Calls giveFeedback(agentId, score, 0, tag, "agent-wallet/v1",
    /// endpoint, "", nonce). The agentId comes from the attempt record, never from the caller.
    /// Reverts unless: caller is the agent; the attempt hasIdentity; it settled (Design A:
    /// USDC.authorizationState(this, nonce); Design B: the pay record); not yet rated;
    /// score <= 100; tag 1–32 bytes; endpoint <= 200 bytes.
    function rate(bytes32 nonce, uint8 score, string calldata tag, string calldata endpoint) external;

    // ── Operator only ────────────────────────────────────────────────────────────────
    /// Reverts if enabling with no trusted reviewers, minAverage > 100, or enabling with minCount == 0.
    function setReputationRule(bool enabled, uint8 minAverage, uint64 minCount) external;
    /// Reverts if: zero address; adding a duplicate; more than MAX_TRUSTED_REVIEWERS (5);
    /// removing the last reviewer while the rule is enabled.
    function setTrustedReviewer(address reviewer, bool trusted) external;

    // ── Views ────────────────────────────────────────────────────────────────────────
    function identityRegistry() external view returns (address);     // immutable, set in the implementation constructor
    function reputationRegistry() external view returns (address);   // immutable
    function reputationRule() external view returns (bool enabled, uint8 minAverage, uint64 minCount);
    function trustedReviewers() external view returns (address[] memory);
    /// The scope check (data-model step 3) as a view, for the dashboard and the snapshot job
    /// (payableByGated). Uses the same internal function as authorize. Returns NONE if it passes.
    function checkPayee(address payee, bool hasClaim, uint256 payeeAgentId) external view returns (Reason);
    function attempt(bytes32 nonce) external view
        returns (bool hasIdentity, uint256 payeeAgentId, bool rated);
}
```

**Design B fallback** (if 001's task T010 selects it): add
`payWithIdentity(bytes32 paymentId, address payee, uint256 amount, bytes32 taskId, uint256 payeeAgentId)`
with the same checks. `rate` then requires the `pay` record to be settled. Nothing else changes.

**Registry calls** use an assembly `staticcall` with fixed gas (`IDENTITY_GAS = 100_000`,
`REGISTRY_GAS = 5_000_000`) and a **fixed-size output buffer** (32 bytes for `getAgentWallet`, 96
for `getSummary`). Only those bytes are ever copied, so a huge return payload can't exhaust gas:
- `returndatasize()` is checked against the expected size;
- the words are range-checked by hand;
- any failure maps to `REPUTATION_UNAVAILABLE`;
- neither `try/catch` nor OpenZeppelin `Address` is used. `try/catch` can't catch decoding
  failures, and `Address` reverts on failure.

`rate` sets `attempt.rated = true` before calling `giveFeedback` (checks-effects-interactions).

`rate`'s `giveFeedback` call is a normal call, so a registry revert reverts `rate`, which is fine
because it isn't a policy outcome. The wallet reads `getLastIndex` afterwards for the event's
`feedbackIndex`.

**Guarantees, each proven by Foundry tests** (constitution III):
- **Fuzz, one per new reason**: amount, payee, agentId, registry state and timestamps are fuzzed.
  Each case asserts `false`, exactly that reason in `PaymentRefused`, no revert, and the USDC
  balance and budgets unchanged (SC-001: at least 50 runs across the five reasons; we run 1,000
  each).
- **Fuzz, SC-002**: N random untrusted reviewers add arbitrary feedback to the mock registry; the
  decision and reason are identical to without them.
- **Invariant**:
  - `attempt.rated ⇒ hasIdentity ∧ settled`;
  - no nonce rated twice;
  - the rule is never enabled with zero reviewers;
  - all of 001's invariants still hold.
- **Unit**:
  - every new setter reverts for the agent and for strangers;
  - a registry mock that reverts, burns all gas, returns garbage or returns a 1 MB payload gives
    `REPUTATION_UNAVAILABLE`, never a pass or a revert;
  - too little gas reverts;
  - an allowlisted payee passes when reputation is low or unavailable, but a mismatch is still
    refused.
- **Fork** (Base Sepolia at a pinned block, real registries):
  - register an identity and point its wallet at a payee;
  - authorise, settle (simulated with `deal` + `transferWithAuthorization`) and rate;
  - `getSummary` reflects the rating;
  - a wallet that owns the identity can't rate it (registry revert);
  - `checkPayee` matches `authorizeWithIdentity`.
