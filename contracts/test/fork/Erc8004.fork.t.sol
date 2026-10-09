// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {PolicyWallet} from "../../src/PolicyWallet.sol";
import {PolicyWalletFactory} from "../../src/PolicyWalletFactory.sol";
import {Reason} from "../../src/Reason.sol";
import {IERC8004Reputation} from "../../src/interfaces/IERC8004.sol";
import {MockErc8004} from "../mocks/MockErc8004.sol";

/// The parts of the real v2.0.0 registries these tests drive (verified source, research R1).
interface IIdentityFull {
    function register(string calldata agentURI) external returns (uint256);
    function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes calldata signature) external;
    function getAgentWallet(uint256 agentId) external view returns (address);
    function setApprovalForAll(address operator, bool approved) external;
    function transferFrom(address from, address to, uint256 tokenId) external;
    function getVersion() external view returns (string memory);
}

interface IReputationFull is IERC8004Reputation {
    function revokeFeedback(uint256 agentId, uint64 feedbackIndex) external;
    function getVersion() external view returns (string memory);
}

interface IUSDC {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function authorizationState(address, bytes32) external view returns (bool);
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external;
}

/// T010, T020, T029: against the real ERC-8004 registries on Base Sepolia at the pinned block in
/// config/erc8004.json. Skipped when RPC_URL is unset.
contract Erc8004ForkTest is Test {
    IUSDC constant USDC = IUSDC(0x036CbD53842c5426634e7929541eC2318f3dCF7e);
    address constant FUNDER = 0xc6E78B511c87688BC33C9db7539E5E0334B2Ad59; // demo operator, holds test USDC
    bytes32 constant TWA_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 constant WALLET_SET_TYPEHASH = keccak256("AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)");
    string constant URL = "https://api.demo.yunshu.ai/s/reliable/quote";

    IIdentityFull identity;
    IReputationFull reputation;
    PolicyWallet wallet;
    address agent;
    uint256 agentKey;
    address svcOwner = makeAddr("fork-services-owner");
    address[3] trusted;
    bool skip_;

    function setUp() public {
        string memory rpc = vm.envOr("RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            skip_ = true;
            return;
        }
        string memory cfg = vm.readFile(string.concat(vm.projectRoot(), "/../config/erc8004.json"));
        vm.createSelectFork(rpc, vm.parseJsonUint(cfg, ".forkBlock"));
        identity = IIdentityFull(vm.parseJsonAddress(cfg, ".identity.proxy"));
        reputation = IReputationFull(vm.parseJsonAddress(cfg, ".reputation.proxy"));

        (agent, agentKey) = makeAddrAndKey("fork-agent");
        PolicyWalletFactory factory =
            new PolicyWalletFactory(address(new PolicyWallet(address(USDC), address(identity), address(reputation))));
        wallet = PolicyWallet(factory.createWallet(agent, "fork-gated", 1e6, 5e6)); // this contract is the operator
        trusted = [makeAddr("fork-r1"), makeAddr("fork-r2"), makeAddr("fork-r3")];
        for (uint256 i; i < 3; i++) wallet.setTrustedReviewer(trusted[i], true);
        wallet.setReputationRule(true, 70, 3);
        // Funds, so a passing scope check isn't then refused as INSUFFICIENT_FUNDS.
        if (USDC.balanceOf(FUNDER) < 200_000) {
            skip_ = true;
            return;
        }
        vm.prank(FUNDER);
        USDC.transfer(address(wallet), 100_000);
    }

    // ── helpers ───────────────────────────────────────────────────────────────────────────

    /// Registers an identity from the services-owner and points its wallet at a fresh payee,
    /// with the payee's EIP-712 AgentWalletSet signature (as register-services will).
    function _service(string memory label) internal returns (uint256 id, address payTo) {
        vm.prank(svcOwner);
        id = identity.register(string.concat("data:,", label));
        payTo = _pointWallet(id, label);
    }

    /// setAgentWallet(id, <fresh payee for label>) with the payee's EIP-712 AgentWalletSet signature.
    function _pointWallet(uint256 id, string memory label) internal returns (address payTo) {
        uint256 payKey;
        (payTo, payKey) = makeAddrAndKey(label);
        uint256 deadline = block.timestamp + 60;
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("ERC8004IdentityRegistry"),
                keccak256("1"),
                block.chainid,
                address(identity)
            )
        );
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", domain, keccak256(abi.encode(WALLET_SET_TYPEHASH, id, payTo, svcOwner, deadline)))
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(payKey, digest);
        vm.prank(svcOwner);
        identity.setAgentWallet(id, payTo, deadline, abi.encodePacked(r, s, v));
        assertEq(identity.getAgentWallet(id), payTo);
    }

    function _rate(address reviewer, uint256 id, int128 value, uint8 decimals) internal {
        vm.prank(reviewer);
        reputation.giveFeedback(id, value, decimals, "accurate", "", "", "", bytes32(0));
    }

    /// checkPayee must agree with authorizeWithIdentity.
    function _gate(address payTo, uint256 id, Reason want) internal returns (bytes32 nonce) {
        nonce = keccak256(abi.encode("fork", payTo, id, gasleft()));
        assertEq(uint8(wallet.checkPayee(payTo, true, id)), uint8(want), "checkPayee");
        vm.prank(agent);
        bool ok = wallet.authorizeWithIdentity(nonce, payTo, 10_000, 0, block.timestamp + 300, bytes32(0), id);
        assertEq(ok, want == Reason.NONE, "authorizeWithIdentity");
    }

    // ── T010: pins and mock parity ────────────────────────────────────────────────────────

    function test_fork_registriesArePinned() public {
        vm.skip(skip_);
        string memory cfg = vm.readFile(string.concat(vm.projectRoot(), "/../config/erc8004.json"));
        bytes32 slot = vm.parseJsonBytes32(cfg, ".implementationSlot");
        assertEq(address(uint160(uint256(vm.load(address(identity), slot)))), vm.parseJsonAddress(cfg, ".identity.implementation"));
        assertEq(address(uint160(uint256(vm.load(address(reputation), slot)))), vm.parseJsonAddress(cfg, ".reputation.implementation"));
        assertEq(identity.getVersion(), "2.0.0");
        assertEq(reputation.getVersion(), "2.0.0");
    }

    function test_fork_mockMatchesRealRegistry() public {
        vm.skip(skip_);
        MockErc8004 mock = new MockErc8004();
        vm.prank(svcOwner);
        uint256 realId = identity.register("data:,parity");
        vm.prank(svcOwner);
        uint256 mockId = mock.register("data:,parity");

        address[] memory clients = new address[](4);
        int128[4] memory values = [int128(90), 40, 75, 8125];
        uint8[4] memory decimals = [uint8(0), 0, 0, 2];
        for (uint256 i; i < 4; i++) {
            clients[i] = makeAddr(string.concat("parity-", vm.toString(i)));
            vm.prank(clients[i]);
            reputation.giveFeedback(realId, values[i], decimals[i], "t", "", "", "", bytes32(0));
            vm.prank(clients[i]);
            mock.giveFeedback(mockId, values[i], decimals[i], "t", "", "", "", bytes32(0));
        }
        _assertSameSummary(mock, realId, mockId, clients);
        vm.prank(clients[1]); // revoke the 40
        reputation.revokeFeedback(realId, 1);
        vm.prank(clients[1]);
        mock.revokeFeedback(mockId, 1);
        _assertSameSummary(mock, realId, mockId, clients);
    }

    function _assertSameSummary(MockErc8004 mock, uint256 realId, uint256 mockId, address[] memory clients) internal view {
        (uint64 c1, int128 v1, uint8 d1) = reputation.getSummary(realId, clients, "", "");
        (uint64 c2, int128 v2, uint8 d2) = mock.getSummary(mockId, clients, "", "");
        assertEq(c1, c2, "count");
        assertEq(v1, v2, "value");
        assertEq(d1, d2, "decimals");
    }

    // ── T020: the rule against the real registries ────────────────────────────────────────

    function test_fork_goodReputationPasses() public {
        vm.skip(skip_);
        (uint256 id, address payTo) = _service("svc-good");
        for (uint256 i; i < 5; i++) _rate(trusted[i % 3], id, 85, 0);
        _gate(payTo, id, Reason.NONE);
    }

    function test_fork_twoRatingsAreNotEnough() public {
        vm.skip(skip_);
        (uint256 id, address payTo) = _service("svc-two");
        _rate(trusted[0], id, 90, 0);
        _rate(trusted[1], id, 90, 0);
        _gate(payTo, id, Reason.NOT_ENOUGH_TRUSTED_REVIEWS);
    }

    function test_fork_lowScoresAreTooLow() public {
        vm.skip(skip_);
        (uint256 id, address payTo) = _service("svc-low");
        for (uint256 i; i < 3; i++) _rate(trusted[i], id, 40, 0);
        _gate(payTo, id, Reason.PAYEE_REPUTATION_TOO_LOW);
    }

    function test_fork_untrustedReviewsDontCount() public {
        vm.skip(skip_);
        (uint256 id, address payTo) = _service("svc-untrusted");
        for (uint256 i; i < 10; i++) _rate(makeAddr(string.concat("stranger-", vm.toString(i))), id, 100, 0);
        _gate(payTo, id, Reason.NOT_ENOUGH_TRUSTED_REVIEWS);
    }

    function test_fork_impostorIsRefused() public {
        vm.skip(skip_);
        (uint256 id,) = _service("svc-real");
        for (uint256 i; i < 5; i++) _rate(trusted[i % 3], id, 90, 0);
        _gate(makeAddr("impostor"), id, Reason.PAYEE_IDENTITY_MISMATCH);
    }

    // ── T029: settle and rate end to end ──────────────────────────────────────────────────

    function _paid(uint256 id, address payTo) internal returns (bytes32 nonce) {
        nonce = keccak256(abi.encode("fork-paid", id));
        uint256 validBefore = block.timestamp + 300;
        vm.prank(agent);
        assertTrue(wallet.authorizeWithIdentity(nonce, payTo, 10_000, 0, validBefore, bytes32(0), id));
        bytes32 structHash = keccak256(abi.encode(TWA_TYPEHASH, address(wallet), payTo, 10_000, 0, validBefore, nonce));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentKey, keccak256(abi.encodePacked("\x19\x01", USDC.DOMAIN_SEPARATOR(), structHash)));
        USDC.transferWithAuthorization(address(wallet), payTo, 10_000, 0, validBefore, nonce, abi.encodePacked(r, s, v));
        assertTrue(USDC.authorizationState(address(wallet), nonce));
    }

    function test_fork_settledPaymentIsRatedOnTheRealRegistry() public {
        vm.skip(skip_);
        (uint256 id, address payTo) = _service("svc-rated");
        for (uint256 i; i < 5; i++) _rate(trusted[i % 3], id, 85, 0);
        bytes32 nonce = _paid(id, payTo);

        vm.recordLogs();
        vm.prank(agent);
        wallet.rate(nonce, 90, "accurate", URL);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        Vm.Log memory fb = logs[0];
        assertEq(fb.emitter, address(reputation));
        assertEq(uint256(fb.topics[1]), id);
        assertEq(address(uint160(uint256(fb.topics[2]))), address(wallet)); // the wallet is the reviewer
        assertEq(fb.topics[3], keccak256("accurate"));
        (, int128 value, uint8 decimals, string memory tag1, string memory tag2,,, bytes32 hash) =
            abi.decode(fb.data, (uint64, int128, uint8, string, string, string, string, bytes32));
        assertEq(value, 90);
        assertEq(decimals, 0);
        assertEq(tag1, "accurate");
        assertEq(tag2, "agent-wallet/v1");
        assertEq(hash, nonce);

        address[] memory clients = new address[](1);
        clients[0] = address(wallet);
        (uint64 count, int128 avg,) = reputation.getSummary(id, clients, "", "");
        assertEq(count, 1);
        assertEq(avg, 90);
    }

    function test_fork_approvedWalletCantRate() public {
        vm.skip(skip_);
        (uint256 id, address payTo) = _service("svc-approved");
        for (uint256 i; i < 5; i++) _rate(trusted[i % 3], id, 85, 0);
        bytes32 nonce = _paid(id, payTo);
        vm.prank(svcOwner);
        identity.setApprovalForAll(address(wallet), true);
        vm.prank(agent);
        vm.expectRevert(bytes("Self-feedback not allowed"));
        wallet.rate(nonce, 90, "accurate", URL);
    }

    // ── T050 (US6): impersonation is refused ──────────────────────────────────────────────

    function _wellRated(string memory label) internal returns (uint256 id, address payTo) {
        (id, payTo) = _service(label);
        for (uint256 i; i < 5; i++) _rate(trusted[i % 3], id, 90, 0);
        _gate(payTo, id, Reason.NONE); // payable before the change under test
    }

    function test_fork_transferredIdentityIsRefused() public {
        vm.skip(skip_);
        (uint256 id, address payTo) = _wellRated("svc-transferred");
        vm.prank(svcOwner);
        identity.transferFrom(svcOwner, makeAddr("new-owner"), id); // clears agentWallet
        assertEq(identity.getAgentWallet(id), address(0));
        _gate(payTo, id, Reason.PAYEE_IDENTITY_MISMATCH);
    }

    function test_fork_oldAddressAfterWalletChangeIsRefused() public {
        vm.skip(skip_);
        (uint256 id, address oldPayTo) = _wellRated("svc-moved");
        address newPayTo = _pointWallet(id, "svc-moved-new"); // signed by the new payee, sent by the owner
        _gate(oldPayTo, id, Reason.PAYEE_IDENTITY_MISMATCH);
        _gate(newPayTo, id, Reason.NONE);
    }

    function test_fork_allowlistDoesNotSkipTheMismatchCheck() public {
        vm.skip(skip_);
        (uint256 id,) = _wellRated("svc-claimed");
        address allowlisted = makeAddr("allowlisted-payee");
        wallet.setPayee(allowlisted, true); // this contract is the operator
        _gate(allowlisted, id, Reason.PAYEE_IDENTITY_MISMATCH);
    }
}

