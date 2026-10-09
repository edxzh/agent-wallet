// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Why a payment attempt was refused. Values are part of the public record (PaymentRefused
/// events): append only, never reorder (data-model.md, "Refusal reasons").
enum Reason {
    NONE,
    PAUSED, //               1
    INVALID_AMOUNT, //       2  amount == 0, or validBefore <= now
    PAYEE_NOT_ALLOWED, //    3
    OVER_PER_PAYMENT_CAP, // 4
    OVER_TASK_BUDGET, //     5  unknown non-zero task has budget 0
    OVER_DAILY_BUDGET, //    6
    INSUFFICIENT_FUNDS, //   7
    // ── 002: trusted payees (ERC-8004) ──
    PAYEE_IDENTITY_UNVERIFIED, //  8  not allowlisted, rule on, no identity claimed
    PAYEE_IDENTITY_MISMATCH, //    9  claimed identity's wallet isn't the payee (even if allowlisted)
    REPUTATION_UNAVAILABLE, //     10 a registry read failed
    NOT_ENOUGH_TRUSTED_REVIEWS, // 11
    PAYEE_REPUTATION_TOO_LOW //    12
}
