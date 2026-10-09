// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {IPolicyWallet} from "./IPolicyWallet.sol";
import {IPolicyWalletReputation} from "./IPolicyWalletReputation.sol";
import {IERC8004Identity, IERC8004Reputation} from "./interfaces/IERC8004.sol";
import {Reason} from "./Reason.sol";

/// The parts of USDC (FiatToken v2.2, EIP-3009) the wallet reads.
interface IEIP3009 {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
}

/// @title PolicyWallet
/// @notice An agent's wallet with spending rules enforced at authorization time (Base Sepolia only).
/// The agent asks `authorize` before signing an EIP-3009 transfer from this wallet. A rule violation
/// emits `PaymentRefused` with one reason and returns false, never reverting, so refusals are on the
/// public record. A passing attempt reserves budget and its digest; USDC then accepts the agent's
/// signature only for that digest, through `isValidSignature` (ERC-1271, research R2 Design A).
/// Deployed once as an implementation and used through EIP-1167 clones (see PolicyWalletFactory).
///
/// Feature 002 adds a reputation rule: a payee that isn't allowlisted may be paid only if it claims
/// an ERC-8004 identity whose registered wallet is the payee, with enough good ratings from
/// operator-trusted reviewers. After a settled, identity-checked payment the wallet itself rates
/// the service (`rate`). Registry reads fail closed as recorded refusals, never reverts.
contract PolicyWallet is IPolicyWallet, IPolicyWalletReputation, Initializable {
    using SafeERC20 for IERC20;

    bytes32 private constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes4 private constant ERC1271_INVALID = 0xffffffff;

    /// Gas forwarded to each registry read (research R2, R7). Fixed, so a hostile registry can't
    /// take more, and checked up front, so an agent can't fake an outage by sending too little.
    uint256 public constant IDENTITY_GAS = 100_000;
    uint256 public constant REGISTRY_GAS = 5_000_000;
    /// Work done before the summary read (nonce store, rule reads, copying the reviewer list).
    /// Measured: 20k is too little and 50k enough with 5 reviewers; 200k leaves room for cold state.
    uint256 public constant GAS_GUARD_MARGIN = 200_000;
    uint256 public constant MAX_TRUSTED_REVIEWERS = 5;
    string private constant RATING_TAG2 = "agent-wallet/v1";

    struct Task {
        uint256 budget;
        uint256 spent;
    }

    struct Reservation {
        uint128 amount;
        uint64 day;
        uint64 validBefore;
        bytes32 taskId;
        bytes32 digest;
        bool active;
    }

    struct ReputationRule {
        bool enabled;
        uint8 minAverage;
        uint64 minCount;
    }

    /// Per nonce, set by authorizeWithIdentity (kept apart from Reservation, whose shape is public).
    struct Attempt {
        bool hasIdentity;
        bool rated;
        uint256 payeeAgentId;
    }

    /// USDC. Immutable in the implementation, so every clone shares it.
    address public immutable token;
    /// ERC-8004 registries (proxies). Immutable in the implementation, so every clone shares them.
    address public immutable identityRegistry;
    address public immutable reputationRegistry;

    address public operator;
    address public agent;
    string public name;
    bool public paused;
    uint256 public perPaymentCap;
    uint256 public dailyBudget;

    mapping(uint256 day => uint256) public spentOn;
    mapping(bytes32 taskId => Task) private _tasks;
    mapping(address payee => bool) public isPayeeAllowed;
    /// Every nonce ever attempted. A nonce is attempted once; reuse reverts (replay protection).
    mapping(bytes32 nonce => bool) public nonceUsed;
    mapping(bytes32 nonce => Reservation) public reservations;
    mapping(bytes32 digest => bool) public reservedDigest;

    ReputationRule private _rule;
    address[] private _trusted;
    mapping(address reviewer => bool) public isTrustedReviewer;
    mapping(bytes32 nonce => Attempt) private _attempts;

    error NotOperator();
    error NotAgent();
    error NonceAlreadyUsed(bytes32 nonce);
    error InvalidPolicy();
    error ZeroAddress();
    error NothingToRelease(bytes32 nonce);
    error NotExpired(bytes32 nonce);
    error AlreadySettled(bytes32 nonce);
    error WrongChain();
    error InvalidReputationRule();
    error InvalidReviewer(address reviewer);
    error TooManyReviewers();
    error LastReviewer();
    error InsufficientGas();
    error NotRatable(bytes32 nonce);
    error NotSettled(bytes32 nonce);
    error AlreadyRated(bytes32 nonce);
    error InvalidRating();

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    modifier onlyAgent() {
        if (msg.sender != agent) revert NotAgent();
        _;
    }

    constructor(address token_, address identityRegistry_, address reputationRegistry_) {
        if (block.chainid != 84532 && block.chainid != 31337) revert WrongChain(); // Base Sepolia, or local tests
        if (token_ == address(0) || identityRegistry_ == address(0) || reputationRegistry_ == address(0)) revert ZeroAddress();
        token = token_;
        identityRegistry = identityRegistry_;
        reputationRegistry = reputationRegistry_;
        _disableInitializers();
    }

    function initialize(address operator_, address agent_, string calldata name_, uint256 cap_, uint256 daily_)
        external
        initializer
    {
        if (operator_ == address(0) || agent_ == address(0)) revert ZeroAddress();
        if (cap_ == 0 || daily_ == 0) revert InvalidPolicy();
        operator = operator_;
        agent = agent_;
        name = name_;
        perPaymentCap = cap_;
        dailyBudget = daily_;
    }

    // ── Agent ─────────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IPolicyWallet
    function authorize(bytes32 nonce, address payee, uint256 amount, uint256 validAfter, uint256 validBefore, bytes32 taskId)
        external
        onlyAgent
        returns (bool)
    {
        return _authorize(Request(nonce, payee, amount, validAfter, validBefore, taskId, false, 0));
    }

    /// @inheritdoc IPolicyWalletReputation
    function authorizeWithIdentity(
        bytes32 nonce,
        address payee,
        uint256 amount,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 taskId,
        uint256 payeeAgentId
    ) external onlyAgent returns (bool) {
        // Too little gas isn't a policy outcome: revert rather than record a false REPUTATION_UNAVAILABLE.
        if (gasleft() < (IDENTITY_GAS + REGISTRY_GAS) * 64 / 63 + GAS_GUARD_MARGIN) revert InsufficientGas();
        return _authorize(Request(nonce, payee, amount, validAfter, validBefore, taskId, true, payeeAgentId));
    }

    struct Request {
        bytes32 nonce;
        address payee;
        uint256 amount;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 taskId;
        bool hasClaim;
        uint256 payeeAgentId;
    }

    function _authorize(Request memory q) internal returns (bool) {
        if (nonceUsed[q.nonce]) revert NonceAlreadyUsed(q.nonce);
        nonceUsed[q.nonce] = true;

        uint256 day = block.timestamp / 1 days;
        (Reason reason, bool hasIdentity) = _check(q, day);
        if (reason != Reason.NONE) {
            emit PaymentRefused(q.nonce, q.payee, q.taskId, q.amount, reason);
            return false;
        }

        spentOn[day] += q.amount;
        if (q.taskId != bytes32(0)) _tasks[q.taskId].spent += q.amount;

        bytes32 digest = _digest(q.payee, q.amount, q.validAfter, q.validBefore, q.nonce);
        reservedDigest[digest] = true;
        reservations[q.nonce] = Reservation({
            amount: uint128(q.amount),
            day: uint64(day),
            validBefore: uint64(q.validBefore),
            taskId: q.taskId,
            digest: digest,
            active: true
        });
        emit PaymentAuthorized(q.nonce, q.payee, q.taskId, q.amount, q.validBefore, digest);
        if (hasIdentity) {
            _attempts[q.nonce] = Attempt({hasIdentity: true, rated: false, payeeAgentId: q.payeeAgentId});
            emit PayeeIdentityVerified(q.nonce, q.payeeAgentId, q.payee);
        }
        return true;
    }

    /// @inheritdoc IPolicyWalletReputation
    function rate(bytes32 nonce, uint8 score, string calldata tag, string calldata endpoint) external onlyAgent {
        Attempt storage a = _attempts[nonce];
        if (!a.hasIdentity) revert NotRatable(nonce);
        if (!IEIP3009(token).authorizationState(address(this), nonce)) revert NotSettled(nonce);
        if (a.rated) revert AlreadyRated(nonce);
        if (score > 100 || bytes(tag).length == 0 || bytes(tag).length > 32 || bytes(endpoint).length > 200) {
            revert InvalidRating();
        }
        a.rated = true; // effects before the external call
        uint256 agentId = a.payeeAgentId; // from the attempt record, never from the caller (research R4)
        uint64 feedbackIndex = _giveFeedback(agentId, score, tag, endpoint, nonce);
        emit PaymentRated(nonce, agentId, score, tag, feedbackIndex);
    }

    /// giveFeedback(agentId, score, 0, tag, "agent-wallet/v1", endpoint, "", nonce), then the
    /// registry's index for it. A registry revert reverts rate (not a policy outcome).
    function _giveFeedback(uint256 agentId, uint8 score, string memory tag, string memory endpoint, bytes32 nonce)
        private
        returns (uint64)
    {
        IERC8004Reputation reg = IERC8004Reputation(reputationRegistry);
        reg.giveFeedback(agentId, int128(uint128(score)), 0, tag, RATING_TAG2, endpoint, "", nonce);
        return reg.getLastIndex(agentId, address(this));
    }

    /// @inheritdoc IERC1271
    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4) {
        if (!reservedDigest[digest]) return ERC1271_INVALID;
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        return err == ECDSA.RecoverError.NoError && signer == agent ? IERC1271.isValidSignature.selector : ERC1271_INVALID;
    }

    // ── Anyone ────────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IPolicyWallet
    function release(bytes32 nonce) external {
        Reservation storage r = reservations[nonce];
        if (!r.active) revert NothingToRelease(nonce);
        if (block.timestamp < r.validBefore) revert NotExpired(nonce);
        if (IEIP3009(token).authorizationState(address(this), nonce)) revert AlreadySettled(nonce);

        r.active = false;
        delete reservedDigest[r.digest];
        spentOn[r.day] -= r.amount;
        if (r.taskId != bytes32(0)) _tasks[r.taskId].spent -= r.amount;
        emit PaymentExpired(nonce, r.amount);
    }

    // ── Operator only ─────────────────────────────────────────────────────────────────────

    function setPolicy(uint256 cap_, uint256 daily_) external onlyOperator {
        if (cap_ == 0 || daily_ == 0) revert InvalidPolicy();
        emit RuleChanged("perPaymentCap", bytes32(0), perPaymentCap, cap_);
        emit RuleChanged("dailyBudget", bytes32(0), dailyBudget, daily_);
        perPaymentCap = cap_;
        dailyBudget = daily_;
    }

    function setPayee(address payee, bool allowed) external onlyOperator {
        if (payee == address(0)) revert ZeroAddress();
        emit RuleChanged("payee", bytes32(uint256(uint160(payee))), _b(isPayeeAllowed[payee]), _b(allowed));
        isPayeeAllowed[payee] = allowed;
    }

    function setTask(bytes32 taskId, uint256 budget) external onlyOperator {
        if (taskId == bytes32(0)) revert InvalidPolicy();
        emit RuleChanged("taskBudget", taskId, _tasks[taskId].budget, budget);
        _tasks[taskId].budget = budget;
    }

    function setAgent(address agent_) external onlyOperator {
        if (agent_ == address(0)) revert ZeroAddress();
        emit RuleChanged("agent", bytes32(0), uint256(uint160(agent)), uint256(uint160(agent_)));
        agent = agent_;
    }

    /// @inheritdoc IPolicyWalletReputation
    function setReputationRule(bool enabled, uint8 minAverage, uint64 minCount) external onlyOperator {
        if (minAverage > 100 || (enabled && (minCount == 0 || _trusted.length == 0))) revert InvalidReputationRule();
        ReputationRule memory old = _rule;
        emit RuleChanged("repEnabled", bytes32(0), _b(old.enabled), _b(enabled));
        emit RuleChanged("repMinAverage", bytes32(0), old.minAverage, minAverage);
        emit RuleChanged("repMinCount", bytes32(0), old.minCount, minCount);
        _rule = ReputationRule(enabled, minAverage, minCount);
    }

    /// @inheritdoc IPolicyWalletReputation
    function setTrustedReviewer(address reviewer, bool trusted) external onlyOperator {
        if (reviewer == address(0)) revert ZeroAddress();
        if (trusted == isTrustedReviewer[reviewer]) revert InvalidReviewer(reviewer); // duplicate, or not a reviewer
        if (trusted) {
            if (_trusted.length == MAX_TRUSTED_REVIEWERS) revert TooManyReviewers();
            _trusted.push(reviewer);
        } else {
            if (_rule.enabled && _trusted.length == 1) revert LastReviewer();
            uint256 n = _trusted.length;
            for (uint256 i; i < n; i++) {
                if (_trusted[i] == reviewer) {
                    _trusted[i] = _trusted[n - 1];
                    _trusted.pop();
                    break;
                }
            }
        }
        isTrustedReviewer[reviewer] = trusted;
        emit RuleChanged("trustedReviewer", bytes32(uint256(uint160(reviewer))), _b(!trusted), _b(trusted));
    }

    function pause() external onlyOperator {
        paused = true;
        emit Paused();
    }

    function unpause() external onlyOperator {
        paused = false;
        emit Unpaused();
    }

    /// Returns test funds to the operator's chosen address.
    function withdraw(address to, uint256 amount) external onlyOperator {
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
    }

    // ── Views ─────────────────────────────────────────────────────────────────────────────

    function task(bytes32 taskId) external view returns (uint256 budget, uint256 spent) {
        Task storage t = _tasks[taskId];
        return (t.budget, t.spent);
    }

    function reputationRule() external view returns (bool enabled, uint8 minAverage, uint64 minCount) {
        ReputationRule memory r = _rule;
        return (r.enabled, r.minAverage, r.minCount);
    }

    function trustedReviewers() external view returns (address[] memory) {
        return _trusted;
    }

    /// @inheritdoc IPolicyWalletReputation
    function checkPayee(address payee, bool hasClaim, uint256 payeeAgentId) external view returns (Reason reason) {
        (reason,) = _checkScope(payee, hasClaim, payeeAgentId);
    }

    function attempt(bytes32 nonce) external view returns (bool hasIdentity, uint256 payeeAgentId, bool rated) {
        Attempt memory a = _attempts[nonce];
        return (a.hasIdentity, a.payeeAgentId, a.rated);
    }

    /// The rule checks, in data-model.md order. The first failing rule is the reason.
    function _check(Request memory q, uint256 day) internal view returns (Reason, bool hasIdentity) {
        if (paused) return (Reason.PAUSED, false);
        if (q.amount == 0 || q.amount > type(uint128).max || q.validBefore <= block.timestamp || q.validBefore > type(uint64).max) {
            return (Reason.INVALID_AMOUNT, false);
        }
        Reason scope;
        (scope, hasIdentity) = _checkScope(q.payee, q.hasClaim, q.payeeAgentId);
        if (scope != Reason.NONE) return (scope, false);
        if (q.amount > perPaymentCap) return (Reason.OVER_PER_PAYMENT_CAP, false);
        if (q.taskId != bytes32(0)) {
            Task storage t = _tasks[q.taskId];
            if (t.spent + q.amount > t.budget) return (Reason.OVER_TASK_BUDGET, false);
        }
        if (spentOn[day] + q.amount > dailyBudget) return (Reason.OVER_DAILY_BUDGET, false);
        if (IERC20(token).balanceOf(address(this)) < q.amount) return (Reason.INSUFFICIENT_FUNDS, false);
        return (Reason.NONE, hasIdentity);
    }

    /// Step 3, "may this payee be paid" (data-model.md 3a–3e). With no claim and the rule off,
    /// this is exactly 001's allowlist check.
    function _checkScope(address payee, bool hasClaim, uint256 agentId) internal view returns (Reason, bool hasIdentity) {
        bool allowed = isPayeeAllowed[payee];
        // 3a. A claimed identity must point at this payee, even for an allowlisted payee.
        if (hasClaim) {
            (bool ok, address registered) = _readAgentWallet(agentId);
            if (!ok) {
                if (!allowed) return (Reason.REPUTATION_UNAVAILABLE, false);
            } else if (registered == address(0) || registered != payee) {
                return (Reason.PAYEE_IDENTITY_MISMATCH, false);
            } else {
                hasIdentity = true;
            }
        }
        // 3b–3d.
        if (allowed) return (Reason.NONE, hasIdentity);
        ReputationRule memory r = _rule;
        if (!r.enabled) return (Reason.PAYEE_NOT_ALLOWED, false);
        if (!hasIdentity) return (Reason.PAYEE_IDENTITY_UNVERIFIED, false);
        // 3e. Trusted reviewers' all-time average, read exactly as the registry reports it.
        (bool ok2, uint64 count, int128 value, uint8 decimals) = _readSummary(agentId);
        if (!ok2) return (Reason.REPUTATION_UNAVAILABLE, false);
        if (count < r.minCount) return (Reason.NOT_ENOUGH_TRUSTED_REVIEWS, false);
        if (int256(value) < int256(uint256(r.minAverage)) * int256(10 ** uint256(decimals))) {
            return (Reason.PAYEE_REPUTATION_TOO_LOW, false);
        }
        return (Reason.NONE, true);
    }

    /// getAgentWallet(agentId) with a fixed gas budget and a fixed 32-byte output buffer: a
    /// failing, gas-burning or hostile registry gives ok = false, never a revert (research R2).
    function _readAgentWallet(uint256 agentId) internal view returns (bool ok, address registered) {
        address reg = identityRegistry;
        bytes4 selector = IERC8004Identity.getAgentWallet.selector;
        uint256 gasBudget = IDENTITY_GAS;
        uint256 word;
        bool success;
        uint256 size;
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            mstore(ptr, selector)
            mstore(add(ptr, 4), agentId)
            success := staticcall(gasBudget, reg, ptr, 0x24, ptr, 0x20)
            size := returndatasize()
            word := mload(ptr)
        }
        // Exactly one word, and a clean address (upper 12 bytes zero).
        if (!success || size != 32 || word >> 160 != 0) return (false, address(0));
        return (true, address(uint160(word)));
    }

    /// getSummary(agentId, trustedReviewers, "", "") with a fixed gas budget and a fixed 96-byte
    /// output buffer; every word is range-checked by hand.
    function _readSummary(uint256 agentId)
        internal
        view
        returns (bool ok, uint64 count, int128 value, uint8 decimals)
    {
        bytes memory data = abi.encodeWithSelector(IERC8004Reputation.getSummary.selector, agentId, _trusted, "", "");
        address reg = reputationRegistry;
        uint256 gasBudget = REGISTRY_GAS;
        bool success;
        uint256 size;
        uint256 w0;
        int256 w1;
        uint256 w2;
        assembly ("memory-safe") {
            let out := mload(0x40)
            success := staticcall(gasBudget, reg, add(data, 0x20), mload(data), out, 0x60)
            size := returndatasize()
            w0 := mload(out)
            w1 := mload(add(out, 0x20))
            w2 := mload(add(out, 0x40))
        }
        if (!success || size != 96) return (false, 0, 0, 0);
        if (w0 > type(uint64).max || w1 < type(int128).min || w1 > type(int128).max || w2 > 18) return (false, 0, 0, 0);
        return (true, uint64(w0), int128(w1), uint8(w2));
    }

    /// EIP-712 digest of USDC's TransferWithAuthorization(from = this wallet).
    function _digest(address payee, uint256 amount, uint256 validAfter, uint256 validBefore, bytes32 nonce)
        internal
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(
            abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, address(this), payee, amount, validAfter, validBefore, nonce)
        );
        return keccak256(abi.encodePacked("\x19\x01", IEIP3009(token).DOMAIN_SEPARATOR(), structHash));
    }

    function _b(bool v) private pure returns (uint256) {
        return v ? 1 : 0;
    }
}
