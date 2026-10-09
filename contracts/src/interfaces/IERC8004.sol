// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Vendored subset of the deployed ERC-8004 v2.0.0 registries on Base Sepolia (research R1),
/// verified 2026-10-08. Nothing else is called. Proxies (pinned in config/erc8004.json):
///   Identity   0x8004A818BFB912233c491871b3d84c89A494BD9e
///   Reputation 0x8004B663056A597Dffe9eCcC1965A193B7388713
interface IERC8004Identity {
    /// The agent's payment address; address(0) for an unknown id or a cleared wallet. Never reverts.
    function getAgentWallet(uint256 agentId) external view returns (address);
}

interface IERC8004Reputation {
    /// All-time, non-revoked feedback from `clients` (must be non-empty). Empty tags match all.
    function getSummary(uint256 agentId, address[] calldata clients, string calldata tag1, string calldata tag2)
        external
        view
        returns (uint64 count, int128 value, uint8 decimals);
    /// The reviewer is msg.sender. Reverts for the agent's owner or an approved operator.
    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external;
    function getLastIndex(uint256 agentId, address client) external view returns (uint64);
}
