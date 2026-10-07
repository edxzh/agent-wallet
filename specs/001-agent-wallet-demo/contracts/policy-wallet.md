# Contract: PolicyWallet and PolicyWalletFactory (Solidity, Base Sepolia)

The public on-chain interface. Event shapes are the public record (FR-011, FR-012). Changing
them is a breaking change for the dashboard and anyone verifying independently.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

enum Reason { NONE, PAUSED, INVALID_AMOUNT, PAYEE_NOT_ALLOWED, OVER_PER_PAYMENT_CAP,
              OVER_TASK_BUDGET, OVER_DAILY_BUDGET, INSUFFICIENT_FUNDS }

interface IPolicyWalletFactory {
    event WalletCreated(address indexed wallet, address indexed operator, address indexed agent, string name);
    /// Deploys an EIP-1167 clone; msg.sender becomes the operator.
    function createWallet(address agent, string calldata name, uint256 perPaymentCap, uint256 dailyBudget)
        external returns (address wallet);
}

interface IPolicyWallet /* is IERC1271 */ {
    // ── Record (never removed, never edited) ─────────────────────────────────────────
    event PaymentAuthorized(bytes32 indexed nonce, address indexed payee, bytes32 indexed taskId,
                            uint256 amount, uint256 validBefore, bytes32 digest);
    event PaymentRefused(bytes32 indexed nonce, address indexed payee, bytes32 indexed taskId,
                         uint256 amount, Reason reason);
    event PaymentExpired(bytes32 indexed nonce, uint256 amount);          // budget returned by release()
    event RuleChanged(bytes32 indexed field, bytes32 indexed key, uint256 oldValue, uint256 newValue);
    //   field ∈ "perPaymentCap" | "dailyBudget" | "payee" (key=payee, 0/1) | "taskBudget" (key=taskId) | "agent"
    event Paused();
    event Unpaused();

    // ── Agent ────────────────────────────────────────────────────────────────────────
    /// Checks the rules in the order defined in data-model.md. On violation: emits PaymentRefused and
    /// returns false WITHOUT reverting. On success: reserves budget, stores the EIP-712 digest of the
    /// USDC TransferWithAuthorization(from=this, to=payee, value=amount, validAfter, validBefore, nonce),
    /// emits PaymentAuthorized, returns true.
    /// Reverts only if msg.sender != agent, or the nonce was seen before.
    function authorize(bytes32 nonce, address payee, uint256 amount, uint256 validAfter,
                       uint256 validBefore, bytes32 taskId) external returns (bool);

    /// ERC-1271. Returns 0x1626ba7e iff `digest` is reserved and `signature` recovers to `agent`.
    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4);

    // ── Anyone ───────────────────────────────────────────────────────────────────────
    /// After validBefore, if USDC.authorizationState(this, nonce) is false: returns the reserved
    /// amount to the task and day budgets and emits PaymentExpired. Otherwise reverts.
    function release(bytes32 nonce) external;

    // ── Operator only (revert for anyone else, including the agent) ──────────────────
    function setPolicy(uint256 perPaymentCap, uint256 dailyBudget) external;
    function setPayee(address payee, bool allowed) external;
    function setTask(bytes32 taskId, uint256 budget) external;
    function setAgent(address agent) external;
    function pause() external;
    function unpause() external;
    function withdraw(address to, uint256 amount) external;   // test funds only

    // ── Views (dashboard and SDK) ────────────────────────────────────────────────────
    function operator() external view returns (address);
    function agent() external view returns (address);
    function token() external view returns (address);
    function paused() external view returns (bool);
    function perPaymentCap() external view returns (uint256);
    function dailyBudget() external view returns (uint256);
    function spentOn(uint256 day) external view returns (uint256);   // day = timestamp / 86400
    function task(bytes32 taskId) external view returns (uint256 budget, uint256 spent);
    function isPayeeAllowed(address payee) external view returns (bool);
}
```

**Design B fallback** (research R2): add
`function pay(bytes32 paymentId, address payee, uint256 amount, bytes32 taskId) external returns (bool)`,
which runs the same checks and either transfers USDC and emits
`PaymentSettled(paymentId, payee, taskId, amount)` or emits `PaymentRefused`. In that design,
`authorize`, `isValidSignature` and `release` are not used.

**Guarantees, each proven by Foundry tests:**
- Fuzz: for every reason, a refused call leaves the wallet's USDC balance unchanged (SC-001).
- Invariant: across random sequences of authorize, release and rule changes,
  `spentOn(today) ≤ dailyBudget` holds at the time of each authorization, and
  `task.spent ≤ task.budget` (SC-002).
- Unit: every operator-only function reverts for the agent (FR-003). A duplicate nonce reverts
  (FR-010). `isValidSignature` rejects unreserved digests and non-agent signatures.
