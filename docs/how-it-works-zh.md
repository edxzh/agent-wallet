# agent 钱包是怎么工作的

*[English](how-it-works.md)*

从想法到代码的一份导读。每一节用几段话讲清楚一个部分，并链接到完整的文档。从上往下读，读到够用为止。下面链接的规格、研究记录和代码说明都是英文的；两篇文章有中文版。

> **仅测试网络（Base Sepolia），不涉及真实资金。**

## 〇、先看看效果

- **实时面板：** <https://demo.yunshu.ai/zh/>。演示 agent 的每一笔付款、每一次拒绝和每一条评分，都直接从链上读取。
- **试着让它超支：** <https://demo.yunshu.ai/zh/try/>。你来当攻击者，真实的合约会通过试运行给出回答。
- **不看代码也能懂的故事：** [让 AI agent 自己付钱，又不让它乱花钱](articles/2026-10-agent-pays-safely-zh.md)，以及续篇[当一个 AI agent 雇用另一个 agent：先检查工作，再付钱](articles/2026-10-agent-hires-agent-zh.md)。

## 一、要解决的问题

能自己付钱的 AI agent（买 API 调用、买数据、雇别的 agent 干活）很有用，也很危险：一个 bug、一次提示词注入、一把被盗的私钥，都可能让它无限制地花钱，或者把钱付错人。在链下做检查帮助不大，因为被攻破的 agent 可以直接绕过。

这里的答案是：**agent 的钱放在一个自己执行规则的智能合约里**。agent 只能"请求"付款，由合约在钱动之前做决定，而且无论放行还是拒绝，都会留下公开记录。

## 二、由哪些部分组成

```text
 agent（TypeScript，packages/agent）── 只持有一把"agent 密钥"：能请求付款，改不了规则
   │
   ├─▶ 付费 API（Cloudflare Worker，packages/service）：返回 402 "请付 0.01 USDC"（x402）
   │
   └─▶ PolicyWallet（Solidity，contracts/src）：agent 在 Base Sepolia 上的钱包
          规则：单笔上限、每日预算、任务预算、收款白名单、暂停
          只有运营者（所有者的密钥，从不进入 CI）可以修改

 看板（Astro，apps/dashboard）：读取公开记录并展示出来
```

- [`README.md`](../README.md)：流程图、规则和所有拒绝原因，都在一页里。
- [`specs/001-agent-wallet-demo/spec.md`](../specs/001-agent-wallet-demo/spec.md)：演示必须做到什么，用用户故事的形式写成。

## 三、一笔付款是怎么完成的（功能 001）

1. agent 请求付费 API，收到带价格的 `402 Payment Required`（[x402](https://www.x402.org/)）。
2. agent 在链上调用 `wallet.authorize(nonce, payee, amount, …)`，合约逐条检查规则。只要有一条不满足，就发出带**唯一一个原因**的 `PaymentRefused` 事件并停下：不签名，也不动钱。全部满足时，合约预留预算，并记下它愿意付的那一笔具体付款。
3. agent 签一笔标准的 USDC 转账（EIP-3009），付款方填的是**钱包**。
4. USDC 会问钱包："这个签名有效吗？"（ERC-1271）。钱包只对第 2 步预留过的那一笔说"有效"。所以单凭 agent 的密钥动不了钱，必须合约先同意。

拒绝是事件而不是报错，所以被拦下的付款同样在公开记录里。看板上"被拒绝：超出今日预算"这样的记录就是这么来的。

延伸阅读：
- [`research.md` › R2](../specs/001-agent-wallet-demo/research.md)：为什么这个设计能配合 x402，以及动手之前先做的那次验证。
- [`data-model.md`](../specs/001-agent-wallet-demo/data-model.md)：规则、预算、预留，以及每一种拒绝原因。
- [`contracts/policy-wallet.md`](../specs/001-agent-wallet-demo/contracts/policy-wallet.md)：合约的函数和事件，也就是它的公开接口。
- [`contracts/src/PolicyWallet.sol`](../contracts/src/PolicyWallet.sol)：代码本身（`authorize`、`_check`、`isValidSignature`）。

## 四、可以付钱给谁（功能 002，ERC-8004）

固定的收款白名单很安全，但不灵活。功能 002 让钱包也能付钱给名单之外的服务，前提是它从**运营者信任的评价方**那里获得了足够好的**信誉**，而且这个检查是在 `authorize` 里、在链上完成的：

- 服务用 [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) 身份证明自己是谁，身份登记的钱包必须就是收款地址。这样冒充者就没法借用别人的身份。
- 演示钱包的规则是：至少 3 条可信评价，平均分不低于 70。
- 每次付费调用之后，agent 会在链上给服务打分。它只能给"真正结算到经过钱包核验的身份"的付款打分，所以评价没法凭空捏造。

延伸阅读：
- [`specs/002-trusted-payees-erc8004/spec.md`](../specs/002-trusted-payees-erc8004/spec.md)。
- [`research.md` › R4](../specs/002-trusted-payees-erc8004/research.md)：为什么评分无法伪造。
- [`contracts/policy-wallet-reputation.md`](../specs/002-trusted-payees-erc8004/contracts/policy-wallet-reputation.md)：`checkPayee`、`rate` 和新增的五种拒绝原因。
- [`quickstart-results.md`](../specs/002-trusted-payees-erc8004/quickstart-results.md)：真实运行时的记录。

## 五、零风险地亲手试试（功能 003）

试一试页面不发送任何交易。它请一个公共节点对钱包的 `authorize` 调用做**试运行**（`eth_simulateV1`），就像这笔调用是从 agent 的地址发出的一样，并基于当前的链上状态执行。节点运行的是已部署合约的真实代码，返回它"会"发出的事件，所以答案就是合约自己的答案，不花钱，也不需要任何密钥。

延伸阅读：[`specs/003-try-to-overspend/spec.md`](../specs/003-try-to-overspend/spec.md)。

## 六、agent 雇用 agent（功能 004）

为一个 API 答案付钱是即时的；雇用另一个 agent 不是：工作要过一段时间才交付，还可能做得不好。**JobEscrow** 托管合约会先把雇主的钱存着，等工作检查完再说：

1. 雇主的钱包把报酬付进托管合约。钱包的所有规则照样生效，托管合约还会问钱包能不能付钱给这个 **worker**（功能 002 的 `checkPayee`）。
2. worker 交付结果，并把结果的哈希写到链上。
3. 雇主检查结果：**接受**，worker 收到报酬；**拒绝**，进入争议，只有钱包的运营者能裁决。
4. 每一步都有截止时间，所以任务不会卡住：worker 迟交就退款，雇主不回应就付给 worker，裁决人不裁决就退款。

定时运行的演示大约每 6 小时雇用一次 `worker-bot-01`：一单认真的任务，再加一单争议（马虎的结果被雇主的检查发现）或者一单不交付。每一单的任务和结果都公开在 [`apps/dashboard/src/data/jobs.json`](../apps/dashboard/src/data/jobs.json) 里，任何人都可以拿来和链上的哈希比对。

延伸阅读：
- [`specs/004-agent-hires-agent/spec.md`](../specs/004-agent-hires-agent/spec.md) 和 [`plan.md`](../specs/004-agent-hires-agent/plan.md)（R1：为什么钱包的规则必须覆盖到 worker）。
- [`security-review.md`](../specs/004-agent-hires-agent/security-review.md)：可能出什么问题、怎么处理（自我审查，不是审计）。
- [`contracts/src/JobEscrow.sol`](../contracts/src/JobEscrow.sol)。

## 七、为什么这些说法可信

- **测试就是证据。** 每一种拒绝原因都有模糊测试，证明钱没有动；不变量测试会随机组合大量调用，检查支出从不超过任何上限、任何一单都不会付两次；分叉测试直接针对 Base Sepolia 上真实的 USDC 运行。见 [`contracts/test/`](../contracts/test/)。
- **记录是公开的。** 看板上的每一行都链接到 [BaseScan](https://sepolia.basescan.org) 上对应的交易。
- **基本原则写在纸面上。** [`.specify/memory/constitution.md`](../.specify/memory/constitution.md) 写明了：只用测试网络、规则在链上执行、运营者密钥从不进入 CI、零运行成本、优先采用标准而不是自创。

## 八、自己跑起来

- [`contracts/README.md`](../contracts/README.md)：编译和测试合约（Foundry）。
- [`specs/001-agent-wallet-demo/quickstart.md`](../specs/001-agent-wallet-demo/quickstart.md)：在 Base Sepolia 上把钱包、付费 API 和 agent 完整跑一遍。
- [`specs/002-trusted-payees-erc8004/quickstart.md`](../specs/002-trusted-payees-erc8004/quickstart.md)：设置身份和信誉。
- [`specs/004-agent-hires-agent/quickstart.md`](../specs/004-agent-hires-agent/quickstart.md)：部署托管合约和一个 worker。

## 可以跳过的

各功能目录里的 `tasks.md` 和 `plan.md` 是开发清单和设计记录，只有在修改那个功能时才用得上。[`apps/dashboard/DESIGN.md`](../apps/dashboard/DESIGN.md) 只说明看板共用的样式文件从哪里来。
