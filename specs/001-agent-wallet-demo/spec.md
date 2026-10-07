# Feature Specification: Agent Wallet Demo

**Feature Branch**: `002-agent-wallet-demo` (spec directory; the product itself will live in a new
public repository, see Assumptions)

**Created**: 2026-10-07

**Status**: Draft

**Input**: User description: (agreed in conversation) "Build a real, zero-cost version of the
agent wallet shown in the website's Work section: an AI agent pays for services on its own, is
stopped before settlement when it goes over budget or out of scope, and every payment is
traceable. Testnet only, limits enforced on-chain, a public dashboard plus a scripted agent, in a
new public repository on its own subdomain."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The agent pays on its own, within its limits (Priority: P1)

The operator (Edward) gives an agent a wallet with spending rules: a cap per payment, a budget
per task, a budget per day, and a list of services it may pay. The agent then buys what it needs
from a paid service, such as a data or API call, without a human approving each payment. Each
payment settles and is recorded.

**Why this priority**: Autonomous payment is the core promise ("the agent pays on its own").
Without it there is nothing to control.

**Independent Test**: With a funded agent wallet and rules in place, run the agent against one
allowed paid service. The payment settles, the service delivers, and the payment appears in the
record with agent, task, payee, amount and time.

**Acceptance Scenarios**:

1. **Given** an agent with a 1.00 per-payment cap and a 5.00 daily budget, **When** it pays an
   allowed service 0.02, **Then** the payment settles and the service responds with the paid
   result.
2. **Given** the same agent, **When** it makes several small payments within all limits,
   **Then** each one settles and its remaining budgets go down by exactly the amounts paid.
3. **Given** any settled payment, **When** anyone looks it up, **Then** it shows the agent,
   task, payee, amount, time and a reference that can be checked independently of this product.

---

### User Story 2 - Over-budget or out-of-scope payments are stopped before they settle (Priority: P1)

When the agent tries to pay more than its per-payment cap, more than its remaining task or daily
budget, or a service that isn't on its allowed list, the payment is refused before any money
moves. The refusal is recorded with the reason.

**Why this priority**: This is the safety guarantee clients care about ("gets stopped when it
goes over budget or out of scope") and the main thing the demo must prove.

**Independent Test**: Trigger each of the four kinds of violation. Each attempt is refused, the
wallet balance is unchanged, and the record shows the attempt with the matching reason.

**Acceptance Scenarios**:

1. **Given** a 1.00 per-payment cap, **When** the agent tries to pay 1.50, **Then** it is
   refused with reason "over per-payment cap" and no funds move.
2. **Given** 0.30 left in today's budget, **When** the agent tries to pay 0.50, **Then** it is
   refused with reason "over daily budget".
3. **Given** a task budget of 2.00 with 1.90 spent, **When** the agent tries to pay 0.20 for that
   task, **Then** it is refused with reason "over task budget".
4. **Given** a payee not on the allowed list, **When** the agent tries to pay it any amount,
   **Then** it is refused with reason "payee not allowed".
5. **Given** the agent's own credentials, **When** the agent tries to raise its own limits or add
   payees, **Then** the change is refused. Only the operator can change rules.

---

### User Story 3 - Anyone can watch and verify what the agent did (Priority: P1)

A visitor, such as a prospective client or investor arriving from the website's Work section,
opens the public dashboard. They see each agent's limits and how much is left, a live timeline
of settled payments and refused attempts with reasons, and a link from every entry to an
independent public record.

**Why this priority**: "Every payment is traceable" is the third promise. The dashboard is also
what the website will screenshot and link to.

**Independent Test**: Open the dashboard cold on a phone and on a desktop. Within a minute, a
tester can say what the agent spent, what was blocked and why, and can open the independent
record for one entry.

**Acceptance Scenarios**:

1. **Given** recent agent activity, **When** a visitor opens the dashboard, **Then** they see
   per agent: limits, amounts spent and remaining (per task and per day), and a newest-first
   timeline of payments and refusals.
2. **Given** a new payment or refusal, **When** the visitor keeps the dashboard open, **Then**
   it appears without a manual reload.
3. **Given** any timeline entry, **When** the visitor follows its reference, **Then** an
   independent public record shows the same agent, amount, payee and outcome.
4. **Given** the visitor has no account, wallet or crypto knowledge, **When** they read the
   dashboard, **Then** plain-language labels explain each limit and each refusal reason.

---

### User Story 4 - The operator changes limits or stops an agent instantly (Priority: P2)

The operator can raise or lower any limit, add or remove allowed services, and pause an agent
completely. Changes apply to the agent's very next payment attempt.

**Why this priority**: Real deployments need a kill switch and adjustable rules. It is also a
strong live-demo moment, but the demo still has value without it.

**Independent Test**: Pause an agent, then let it attempt a payment: it is refused with reason
"agent paused". Unpause it, lower its cap, and retry: the new cap applies.

**Acceptance Scenarios**:

1. **Given** a paused agent, **When** it attempts any payment, **Then** it is refused with
   reason "agent paused".
2. **Given** a lowered limit, **When** the agent's next payment exceeds the new limit, **Then**
   it is refused, even if it would have passed the old one.
3. **Given** a rule change, **When** a visitor views the dashboard, **Then** the new rules and
   the time of the change are shown in the record.

---

### User Story 5 - The demo always has fresh activity (Priority: P2)

A scripted agent runs on a schedule. Each run makes a realistic mix of allowed payments and
attempts that should be blocked, so the dashboard is never empty or stale when someone visits.

**Why this priority**: An empty dashboard proves nothing to a visitor. A schedule removes the
need for anyone to run the demo by hand.

**Independent Test**: Leave the demo running for two days without manual action. The dashboard
shows activity from both days, including at least one settled payment and at least one refusal
per run.

**Acceptance Scenarios**:

1. **Given** the schedule, **When** a run completes, **Then** at least one payment settles and at
   least one attempt is refused with a stated reason.
2. **Given** the agent's test funds run low, **When** a run starts, **Then** it stops cleanly and
   reports "insufficient funds" instead of failing silently.

---

### User Story 6 - Developers can run it themselves (Priority: P3)

A developer reading the public repository can follow its instructions to run their own agent
wallet with their own limits on the test network and see the same results.

**Why this priority**: This makes the demo credible to technical evaluators and gives the Work
section a real "View on GitHub" link. It builds on everything above.

**Independent Test**: A developer who hasn't seen the project follows the README from a clean
machine and completes one settled payment and one refused payment.

**Acceptance Scenarios**:

1. **Given** the README, **When** a developer follows it, **Then** they can deploy their own
   wallet, set limits and run the scripted agent without contacting the author.

---

### Edge Cases

- **Two payments at the same moment** that together exceed a budget: at most one settles. The
  combined spend never exceeds any limit.
- **Daily budget rollover**: the daily budget resets at a fixed, documented time (UTC midnight),
  and the dashboard shows when it next resets.
- **A limit lowered below what's already been spent**: no refunds or errors. All further
  payments are refused until the period resets or the limit is raised.
- **Wallet balance lower than the remaining budget**: the payment fails as "insufficient funds",
  which is a different reason from a policy refusal.
- **Zero, negative or malformed amounts**: refused without moving funds.
- **The same payment request submitted twice** (replay): settles at most once.
- **Agent credentials leaked**: the most anyone can lose is what the current limits allow. The
  operator can pause the agent immediately.
- **Test network or public data provider down**: the dashboard shows the last known state and a
  clear "network unavailable" notice instead of an empty page.
- **The paid service fails after payment**: the payment record still shows it settled. Delivery
  failure is shown separately.

## Requirements *(mandatory)*

### Functional Requirements

**Spending rules**

- **FR-001**: Each agent MUST have its own wallet and its own rules: a per-payment cap, a daily
  budget, per-task budgets, and an allowed list of payees.
- **FR-002**: The rules MUST be checked and enforced at the moment of payment by the same
  system that moves the funds. A payment that breaks any rule MUST NOT move any funds.
- **FR-003**: Only the operator MUST be able to create agents, change rules, add or remove
  payees, and pause or unpause agents. The agent MUST NOT be able to change its own rules.
- **FR-004**: Rule changes MUST apply to the next payment attempt after the change is confirmed.
- **FR-005**: Concurrent attempts MUST NOT be able to exceed any limit in total.
- **FR-006**: The daily budget MUST reset at 00:00 UTC.
- **FR-007**: Each refusal MUST carry exactly one reason from a fixed list: over per-payment cap,
  over task budget, over daily budget, payee not allowed, agent paused, insufficient funds,
  invalid amount.

**Paying for services**

- **FR-008**: The agent MUST be able to pay a service that asks for payment per request, using
  the open x402 "payment required" convention, without a human approving each payment.
- **FR-009**: The demo MUST include at least one paid service of its own (e.g. a small data
  endpoint) so payments always have a reliable, allowed payee.
- **FR-010**: Each payment request MUST settle at most once, even if submitted more than once.

**Record and verification**

- **FR-011**: Every settled payment, every refused attempt and every rule change MUST be
  recorded with agent, task (if any), payee, amount, outcome, reason (if refused) and time.
- **FR-012**: The record MUST be stored on a public network so anyone can verify it without
  trusting this product. Each dashboard entry MUST link to its public record.
- **FR-013**: Records MUST NOT be editable or deletable after they're written.

**Dashboard**

- **FR-014**: A public dashboard MUST show, per agent: current rules, spent and remaining
  amounts (per task and per day), pause status, and a newest-first timeline of payments,
  refusals and rule changes.
- **FR-015**: New activity MUST appear on an open dashboard without a manual reload.
- **FR-016**: Every limit and refusal reason MUST have a plain-language label that a
  non-technical visitor can understand.
- **FR-017**: The dashboard MUST NOT require visitors to sign in, connect a wallet or install
  anything, and MUST work on phone and desktop widths.
- **FR-018**: The dashboard MUST be available in English and Chinese, matching the main site.

**Operation**

- **FR-019**: A scripted agent MUST run on a schedule (at least daily) and produce both settled
  payments and refused attempts on each run.
- **FR-020**: The demo MUST use only test-network funds with no real-world value, and MUST say
  so clearly on the dashboard.
- **FR-021**: Running the demo MUST cost $0 per month at demo traffic, using free tiers only.
- **FR-022**: The public repository MUST include instructions for a developer to reproduce the
  demo with their own wallet and limits.

### Key Entities

- **Operator**: the person who owns the agent wallets and is the only one allowed to set rules.
  There is one operator for the demo (Edward).
- **Agent**: an automated program with its own wallet and credentials. It can attempt payments
  but can't change its rules. Has a name, a pause status and a balance.
- **Spending policy**: the rules for one agent: per-payment cap, daily budget with its reset
  time, allowed payees, and its task budgets.
- **Task**: a named unit of work for an agent, with its own budget and running spend.
- **Payee / paid service**: a service that asks for payment per request. Identified by a public
  address and a human-readable name.
- **Payment attempt**: one request by an agent to pay a payee. Its outcome is settled or refused
  (with one reason), plus amount, task and time.
- **Record entry**: the permanent public trace of a payment attempt or rule change, with a
  reference anyone can look up.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of attempts that break a rule are refused with no funds moved, across at
  least 50 deliberate violation tests covering all seven refusal reasons.
- **SC-002**: Across at least 200 concurrent and repeated attempts, total spend never exceeds
  any limit and no payment settles twice.
- **SC-003**: A new payment or refusal appears on an open dashboard within 30 seconds of
  happening.
- **SC-004**: In a 60-second first-view test, at least 4 of 5 non-technical testers can say how
  much the agent spent, what was blocked and why.
- **SC-005**: A rule change or pause applies to the very next payment attempt in 100% of tests.
- **SC-006**: Running cost is $0 per month for at least 3 consecutive months at demo traffic.
- **SC-007**: The dashboard shows activity from the last 24 hours on at least 95% of days.
- **SC-008**: A developer new to the project reproduces one settled and one refused payment from
  the README in 15 minutes or less.
- **SC-009**: The website's Work section can switch from "In progress" to "shipped", with a real
  screenshot and repository link.

## Assumptions

- **Network and money**: the demo runs only on a public **test network** where the x402
  payment convention already works with a test dollar stablecoin. The working choice, from the
  cost discussion, is **Base Sepolia** with test USDC. Mainnet and real funds are out of scope.
- **Where rules are enforced**: in the wallet's own on-chain logic, not in a separate server,
  so the agent can't bypass them and the public record comes for free. The exact mechanism is a
  planning decision.
- **Agent**: a **scripted** agent (fixed program), not an AI model, so there is no AI usage
  cost. A real AI agent can be added later, run only by the operator, with a spending cap.
- **Hosting**: the dashboard is a static site on a subdomain of yunshu.ai (working name
  `demo.yunshu.ai`) on Cloudflare Pages, reading public network data through free endpoints.
  The scheduled run uses free CI minutes (public repository).
- **Repository**: a **new public repository** (working name `edxzh/agent-wallet`), separate from
  the website, as the website constitution requires for products. This spec lives here for now
  and moves to the new repository when it's created.
- **Users**: one operator. Visitors are anonymous and read-only. No accounts, sign-in or
  personal data.
- **Out of scope for this version**: mainnet, real funds, multiple operators, an AI agent, a
  mobile app, fiat on/off ramps, and agents paying other agents.
- **Website follow-up**: updating the website's Work section (screenshot, status, repo link) is a
  separate small change to feature 001 once this demo ships.
