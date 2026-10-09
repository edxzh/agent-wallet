// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC8004Identity, IERC8004Reputation} from "../../src/interfaces/IERC8004.sol";

/// Identity + Reputation registry mock with the same algorithm as the deployed ERC-8004 v2.0.0
/// source (research R1; verified source of 0x7274…9c02 and 0x16e0…dA34):
/// - ids start at 0; `agentWallet` defaults to the registrant; a transfer clears it;
/// - giveFeedback: reverts for the owner or an approved operator, and for a nonexistent agent;
///   indexes are 1-based per (agent, client);
/// - getSummary: reverts on an empty client list, skips revoked entries, normalises to 18
///   decimals, truncating average, returned at the most common decimals (ties: the lowest).
/// Test-only failure modes make reads revert, burn all gas, return garbage or return 1 MB.
contract MockErc8004 is IERC8004Identity, IERC8004Reputation {
    enum Mode {
        NONE,
        REVERT,
        BURN_GAS,
        GARBAGE,
        HUGE_RETURN,
        HEAVY // getSummary only: needs just under its 5 M budget in total (burn + summary), then answers normally (a registry near its gas budget)
    }

    struct Feedback {
        int128 value;
        uint8 valueDecimals;
        bool isRevoked;
        string tag1;
        string tag2;
    }

    event NewFeedback(
        uint256 indexed agentId,
        address indexed clientAddress,
        uint64 feedbackIndex,
        int128 value,
        uint8 valueDecimals,
        string indexed indexedTag1,
        string tag1,
        string tag2,
        string endpoint,
        string feedbackURI,
        bytes32 feedbackHash
    );

    Mode public identityFailure;
    Mode public summaryFailure;

    uint256 private _lastId;
    mapping(uint256 => address) public ownerOf_;
    mapping(uint256 => address) private _wallet;
    mapping(uint256 => address) private _approved;
    mapping(address => mapping(address => bool)) private _operators;
    mapping(uint256 => mapping(address => mapping(uint64 => Feedback))) private _feedback;
    mapping(uint256 => mapping(address => uint64)) private _lastIndex;

    // ── Test controls ─────────────────────────────────────────────────────────────────────
    function setIdentityFailure(Mode m) external {
        identityFailure = m;
    }

    function setSummaryFailure(Mode m) external {
        summaryFailure = m;
    }

    // ── Identity ──────────────────────────────────────────────────────────────────────────
    function register(string calldata) external returns (uint256 agentId) {
        agentId = _lastId++;
        ownerOf_[agentId] = msg.sender;
        _wallet[agentId] = msg.sender;
    }

    function ownerOf(uint256 agentId) public view returns (address o) {
        o = ownerOf_[agentId];
        require(o != address(0), "ERC721NonexistentToken");
    }

    /// The real registry needs an EIP-712 signature from `newWallet`; tests set it directly.
    function setAgentWallet(uint256 agentId, address newWallet) external {
        require(msg.sender == ownerOf(agentId), "Not authorized");
        require(newWallet != address(0), "bad wallet");
        _wallet[agentId] = newWallet;
    }

    /// Transfers clear the payment address, as in the real registry's _update override.
    function transferFrom(address from, address to, uint256 agentId) external {
        require(msg.sender == ownerOf(agentId) && from == msg.sender && to != address(0), "Not authorized");
        ownerOf_[agentId] = to;
        _wallet[agentId] = address(0);
        _approved[agentId] = address(0);
    }

    function approve(address to, uint256 agentId) external {
        require(msg.sender == ownerOf(agentId), "Not authorized");
        _approved[agentId] = to;
    }

    function setApprovalForAll(address op, bool ok) external {
        _operators[msg.sender][op] = ok;
    }

    function isAuthorizedOrOwner(address spender, uint256 agentId) public view returns (bool) {
        address o = ownerOf(agentId);
        return spender == o || _operators[o][spender] || _approved[agentId] == spender;
    }

    function getAgentWallet(uint256 agentId) external view returns (address) {
        _fail(identityFailure, uint256(uint160(_wallet[agentId])), 0, 0, 0x1000); // 4 KB fits in IDENTITY_GAS
        return _wallet[agentId];
    }

    // ── Reputation ────────────────────────────────────────────────────────────────────────
    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external {
        require(valueDecimals <= 18, "too many decimals");
        require(value >= -1e38 && value <= 1e38, "value too large");
        require(!isAuthorizedOrOwner(msg.sender, agentId), "Self-feedback not allowed");
        uint64 idx = ++_lastIndex[agentId][msg.sender];
        _feedback[agentId][msg.sender][idx] = Feedback(value, valueDecimals, false, tag1, tag2);
        _emitNewFeedback(Entry(agentId, idx, value, valueDecimals, feedbackHash), tag1, tag2, endpoint, feedbackURI);
    }

    struct Entry {
        uint256 agentId;
        uint64 index;
        int128 value;
        uint8 decimals;
        bytes32 hash;
    }

    function _emitNewFeedback(Entry memory e, string memory tag1, string memory tag2, string memory endpoint, string memory uri)
        private
    {
        emit NewFeedback(e.agentId, msg.sender, e.index, e.value, e.decimals, tag1, tag1, tag2, endpoint, uri, e.hash);
    }

    function revokeFeedback(uint256 agentId, uint64 feedbackIndex) external {
        require(feedbackIndex > 0 && feedbackIndex <= _lastIndex[agentId][msg.sender], "index out of bounds");
        Feedback storage f = _feedback[agentId][msg.sender][feedbackIndex];
        require(!f.isRevoked, "Already revoked");
        f.isRevoked = true;
    }

    function getLastIndex(uint256 agentId, address client) external view returns (uint64) {
        return _lastIndex[agentId][client];
    }

    function getSummary(uint256 agentId, address[] calldata clients, string calldata tag1, string calldata tag2)
        external
        view
        returns (uint64, int128, uint8)
    {
        if (summaryFailure == Mode.HEAVY) {
            uint256 start = gasleft();
            uint256 x;
            while (start - gasleft() < 4_945_000) x++;
        } else {
            _fail(summaryFailure, 5, 90, 0, 0x100000); // a hostile payload leads with a passing summary
        }
        require(clients.length > 0, "clientAddresses required");
        return _summary(agentId, clients, keccak256(bytes(tag1)), keccak256(bytes(tag2)));
    }

    /// The deployed getSummary's loop, verbatim in behaviour.
    function _summary(uint256 agentId, address[] memory clients, bytes32 tag1Hash, bytes32 tag2Hash)
        private
        view
        returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)
    {
        bytes32 emptyHash = keccak256(bytes(""));
        int256 sum;
        uint64[19] memory decimalCounts;
        for (uint256 i; i < clients.length; i++) {
            uint64 lastIdx = _lastIndex[agentId][clients[i]];
            for (uint64 j = 1; j <= lastIdx; j++) {
                Feedback storage fb = _feedback[agentId][clients[i]][j];
                if (fb.isRevoked) continue;
                if (emptyHash != tag1Hash && tag1Hash != keccak256(bytes(fb.tag1))) continue;
                if (emptyHash != tag2Hash && tag2Hash != keccak256(bytes(fb.tag2))) continue;
                decimalCounts[fb.valueDecimals]++;
                sum += fb.value * int256(10 ** uint256(18 - fb.valueDecimals));
                count++;
            }
        }
        if (count == 0) return (0, 0, 0);
        uint8 modeDecimals;
        uint64 maxCount;
        for (uint8 d; d <= 18; d++) {
            if (decimalCounts[d] > maxCount) {
                maxCount = decimalCounts[d];
                modeDecimals = d;
            }
        }
        int256 avgWad = sum / int256(uint256(count));
        summaryValue = int128(avgWad / int256(10 ** uint256(18 - modeDecimals)));
        summaryValueDecimals = modeDecimals;
    }

    /// Ends the call per the failure mode; returns normally for NONE. HUGE_RETURN leads with a
    /// plausible, passing answer (w0, w1, w2), so only an exact size check refuses it.
    function _fail(Mode m, uint256 w0, uint256 w1, uint256 w2, uint256 hugeSize) private view {
        if (m == Mode.NONE) return;
        if (m == Mode.REVERT) revert("registry down");
        if (m == Mode.BURN_GAS) {
            uint256 x;
            while (gasleft() > 0) x++;
        }
        assembly {
            if eq(m, 3) {
                // GARBAGE: 32 bytes of 0xff
                mstore(0, not(0))
                return(0, 0x20)
            }
            // HUGE_RETURN: 1 MB (4 KB for the identity read, whose gas budget can't build 1 MB)
            mstore(0, w0)
            mstore(0x20, w1)
            mstore(0x40, w2)
            return(0, hugeSize)
        }
    }
}
