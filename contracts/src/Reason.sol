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
    INSUFFICIENT_FUNDS //    7
}
