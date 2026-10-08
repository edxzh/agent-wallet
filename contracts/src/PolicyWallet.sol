// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {IPolicyWallet} from "./IPolicyWallet.sol";
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
contract PolicyWallet is IPolicyWallet, Initializable {
    using SafeERC20 for IERC20;

    bytes32 private constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes4 private constant ERC1271_INVALID = 0xffffffff;

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

    /// USDC. Immutable in the implementation, so every clone shares it.
    address public immutable token;

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

    error NotOperator();
    error NotAgent();
    error NonceAlreadyUsed(bytes32 nonce);
    error InvalidPolicy();
    error ZeroAddress();
    error NothingToRelease(bytes32 nonce);
    error NotExpired(bytes32 nonce);
    error AlreadySettled(bytes32 nonce);
    error WrongChain();

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    modifier onlyAgent() {
        if (msg.sender != agent) revert NotAgent();
        _;
    }

    constructor(address token_) {
        if (block.chainid != 84532 && block.chainid != 31337) revert WrongChain(); // Base Sepolia, or local tests
        if (token_ == address(0)) revert ZeroAddress();
        token = token_;
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
        if (nonceUsed[nonce]) revert NonceAlreadyUsed(nonce);
        nonceUsed[nonce] = true;

        uint256 day = block.timestamp / 1 days;
        Reason reason = _check(payee, amount, validBefore, taskId, day);
        if (reason != Reason.NONE) {
            emit PaymentRefused(nonce, payee, taskId, amount, reason);
            return false;
        }

        spentOn[day] += amount;
        if (taskId != bytes32(0)) _tasks[taskId].spent += amount;

        bytes32 digest = _digest(payee, amount, validAfter, validBefore, nonce);
        reservedDigest[digest] = true;
        reservations[nonce] = Reservation({
            amount: uint128(amount),
            day: uint64(day),
            validBefore: uint64(validBefore),
            taskId: taskId,
            digest: digest,
            active: true
        });
        emit PaymentAuthorized(nonce, payee, taskId, amount, validBefore, digest);
        return true;
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

    /// The rule checks, in data-model.md order. The first failing rule is the reason.
    function _check(address payee, uint256 amount, uint256 validBefore, bytes32 taskId, uint256 day)
        internal
        view
        returns (Reason)
    {
        if (paused) return Reason.PAUSED;
        if (amount == 0 || amount > type(uint128).max || validBefore <= block.timestamp || validBefore > type(uint64).max) {
            return Reason.INVALID_AMOUNT;
        }
        if (!isPayeeAllowed[payee]) return Reason.PAYEE_NOT_ALLOWED;
        if (amount > perPaymentCap) return Reason.OVER_PER_PAYMENT_CAP;
        if (taskId != bytes32(0)) {
            Task storage t = _tasks[taskId];
            if (t.spent + amount > t.budget) return Reason.OVER_TASK_BUDGET;
        }
        if (spentOn[day] + amount > dailyBudget) return Reason.OVER_DAILY_BUDGET;
        if (IERC20(token).balanceOf(address(this)) < amount) return Reason.INSUFFICIENT_FUNDS;
        return Reason.NONE;
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
