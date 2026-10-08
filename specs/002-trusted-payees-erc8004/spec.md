# Feature Specification: Trusted Payees (Reputation-Gated Spending)

**Feature Branch**: `002-trusted-payees-erc8004`

**Created**: 2026-10-08

**Status**: Draft

**Input**: User description: "Option A: trusted payees with ERC-8004. Agents and services get
on-chain identities and reputation. The wallet gains a rule 'only pay services with reputation ≥
X', and the agent leaves on-chain feedback after each paid call. Builds on the agent wallet demo."

## Context

Feature 001 makes sure an agent **can't overspend**: caps, budgets, an allowed list of payees,
and a public record. This feature adds **who it may pay**. Instead of the operator listing every
service by hand, the agent may also pay any service that has earned a good public reputation
from reviewers the operator trusts. After each paid call the agent publishes its own rating, so
trust is earned and lost in the open.

The demo story: "The agent can't overspend, and it only pays services it can trust."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Only pay services with a good reputation from trusted reviewers (Priority: P1)

The operator turns on a reputation rule for an agent's wallet. They choose which reviewers to
trust, a minimum average score, and a minimum number of reviews. From then on, the agent may pay
a service that isn't on its allowed list only if that service meets the rule. Otherwise the
payment is refused before any money moves, with a reason.

**Why this priority**: This is the feature. It turns a fixed allowlist into open-world spending
with a trust floor.

**Independent Test**: With the rule set to "score ≥ 70 from at least 3 trusted reviews", have the
agent pay one service that meets it and one that doesn't. The first settles. The second is
refused as "reputation too low" and the wallet balance is unchanged.

**Acceptance Scenarios**:

1. **Given** a service with an average of 85 from 5 trusted reviews and a rule of ≥ 70 from ≥ 3,
   **When** the agent pays it, **Then** the payment is allowed, subject to all feature 001 rules.
2. **Given** a service averaging 40 from trusted reviewers, **When** the agent tries to pay it,
   **Then** it is refused with reason "payee reputation too low" and no funds move.
3. **Given** a service with only 1 trusted review and a minimum of 3, **When** the agent tries to
   pay it, **Then** it is refused with reason "not enough trusted reviews".
4. **Given** a service with many high scores, all from reviewers the operator didn't choose,
   **When** the agent tries to pay it, **Then** those reviews are ignored and the payment is
   refused as "not enough trusted reviews".
5. **Given** a service on the operator's allowed list, **When** the agent pays it, **Then** it is
   allowed regardless of reputation (the allowed list still works as in feature 001).

---

### User Story 2 - The agent publicly rates every service it pays (Priority: P1)

After each settled paid call, the agent checks the response it got and publishes a score
(0–100) with a short reason (for example "accurate", "stale data", "wrong format"). The rating
goes to the same public reputation record anyone can read, and is linked to the payment it
rates.

**Why this priority**: Without ratings there's no reputation to gate on. Publishing them is also
how the demo shows trust being earned and lost.

**Independent Test**: Make one paid call to a reliable service and one to a service that returns
stale data. Within the same run, two ratings appear on the public record (high and low), each
with a reason and a link to its payment.

**Acceptance Scenarios**:

1. **Given** a settled payment and a correct response, **When** the run finishes, **Then** a
   rating of at least 80 with reason "accurate" is on the public record, referencing that payment.
2. **Given** a settled payment and a stale or malformed response, **When** the run finishes,
   **Then** a rating below 50 with the matching reason is published.
3. **Given** a refused payment, **When** the run finishes, **Then** no rating is published for it.
   The agent only rates services it actually paid.

---

### User Story 3 - Visitors see who the agent trusts and why (Priority: P1)

On the dashboard, each service the agent has met gets an identity card: name, description,
payment address, its reputation as seen by the trusted reviewers (average, number of reviews,
trend), and whether the agent may currently pay it. Refusals for reputation reasons appear in
the timeline in plain language. Each rating links to its public record.

**Why this priority**: The demo's audience can't see trust unless it's shown, and each claim
must be checkable on the public record.

**Independent Test**: Open the dashboard. Within a minute a tester can say which services the
agent pays, which it refuses and why, and can open the public record for one rating.

**Acceptance Scenarios**:

1. **Given** the reputation rule is on, **When** a visitor opens the dashboard, **Then** they see
   the rule in plain words (e.g. "Pays unknown services only with an average of 70+ from at least
   3 trusted reviewers") and the list of trusted reviewers.
2. **Given** several services, **When** the visitor views them, **Then** each shows its trusted
   average, review count, a payable / not-payable status and the reason.
3. **Given** any rating, **When** the visitor follows its link, **Then** the public record shows
   the same reviewer, score and reason.
4. **Given** the dashboard's numbers, **When** compared with the public reputation record,
   **Then** they match exactly.

---

### User Story 4 - Demo services with real public identities (Priority: P2)

The demo runs a small set of paid services, each registered with a public agent identity that
states its name, what it offers and the address it gets paid at:
- a **reliable** quote service;
- a **flaky** one that sometimes returns stale data;
- a **newcomer** with no reviews yet.

**Why this priority**: The demo needs services with different trust levels for the story to
show. They are scaffolding, not the product.

**Independent Test**: Look up each service's identity on the public record. It shows the
expected name, description and payment address, and the payment address matches the one the
service asks to be paid at.

**Acceptance Scenarios**:

1. **Given** each demo service, **When** its identity is looked up, **Then** its registered
   payment address equals the address it requests payment to.
2. **Given** the newcomer, **When** the agent tries to pay it with the rule on and it isn't
   allowlisted, **Then** it is refused as "not enough trusted reviews" until it earns them.

---

### User Story 5 - Trust is earned and lost over time (Priority: P2)

Scheduled runs keep paying and rating the services. Over a few days the flaky service's trusted
average falls below the threshold and the agent automatically stops paying it. The newcomer can
build enough good reviews to become payable. The dashboard shows each service's score over time
and the moment its status changed.

**Why this priority**: This is the story's payoff. It shows the rule works without anyone
editing a list.

**Independent Test**: Run the schedule for 3 days. The flaky service crosses below the threshold
and is refused from then on, and the dashboard's trend shows the crossing.

**Acceptance Scenarios**:

1. **Given** the flaky service's average drops below the threshold, **When** the agent next
   tries to pay it, **Then** the attempt is refused as "payee reputation too low".
2. **Given** a service's status changes, **When** a visitor views the dashboard, **Then** the
   time of the change is shown on its card and in the timeline.

---

### User Story 6 - Impersonation is refused (Priority: P3)

If a service claims a public identity whose registered payment address is different from the
address it asks to be paid at, the payment is refused. Borrowing a well-reviewed identity
doesn't work.

**Why this priority**: A real attack on reputation systems. It completes the safety story but
builds on the stories above.

**Independent Test**: Point the agent at a test service that claims the reliable service's
identity but asks to be paid at a different address. The payment is refused as "payee identity
mismatch".

**Acceptance Scenarios**:

1. **Given** a claimed identity whose registered payment address differs from the requested
   one, **When** the agent tries to pay, **Then** it is refused as "payee identity mismatch"
   and no funds move.
2. **Given** a service that claims no identity and isn't allowlisted, **When** the agent tries to
   pay with the rule on, **Then** it is refused as "payee identity unverified".

---

### Edge Cases

- **No trusted reviewers configured**: the reputation rule can't be turned on. Only the allowed
  list applies.
- **A reviewer is also the service's owner**: the public standard forbids owners rating their own
  service. The demo's reviewers and service owners MUST be different accounts.
- **Revoked ratings** are excluded from the average.
- **Reputation changes between checking and settling**: the check happens at authorization, as
  with every other rule, and a payment that passed is not undone.
- **A service changes its payment address**: from then on, payments to the old address are
  refused as "payee identity mismatch".
- **Flooding with fake reviews** from untrusted accounts has no effect, because only trusted
  reviewers count.
- **Scores outside 0–100** are never published by the agent and are ignored if found.
- **The public reputation record is unavailable** while authorizing: the payment is refused (fail
  closed), with reason "reputation unavailable", unless the service is allowlisted.
- **A trusted reviewer is removed**: their past ratings stop counting from the next check.

## Requirements *(mandatory)*

### Functional Requirements

**Reputation rule**

- **FR-001**: The operator MUST be able to turn a reputation rule on or off per agent wallet, and
  set: the list of trusted reviewers (at least 1), a minimum average score (0–100) and a minimum
  number of trusted reviews.
- **FR-002**: A payee MUST pass the scope check if it is on the allowed list, **or** the
  reputation rule is on and the payee meets it. Otherwise the payment is refused.
- **FR-003**: The reputation check MUST happen at the moment of authorization, inside the same
  system that enforces feature 001's rules, so the agent can't bypass it.
- **FR-004**: The average and count MUST use only ratings from the operator's trusted reviewers,
  excluding revoked ratings.
- **FR-005**: New refusal reasons, each recorded publicly like feature 001's: payee reputation
  too low, not enough trusted reviews, payee identity unverified, payee identity mismatch,
  reputation unavailable.
- **FR-006**: Only the operator MUST be able to change the reputation rule or the trusted
  reviewers. Each change MUST be recorded publicly.

**Identity**

- **FR-007**: For a payee that isn't allowlisted, the payment MUST name the payee's public agent
  identity. It MUST be refused unless that identity's registered payment address equals the
  address being paid.
- **FR-008**: The demo MUST register its services in the **existing public agent identity
  registry** on the test network (not a private copy), with name, description and payment
  address.

**Ratings**

- **FR-009**: After every settled paid call, the agent MUST publish one rating (0–100) with a
  reason tag to the public reputation registry, referencing the payment.
- **FR-010**: The agent MUST NOT rate a service it didn't pay in that call.
- **FR-011**: Scoring MUST be deterministic and documented: same response, same score. It is
  based on whether the response is correct, fresh and well-formed.
- **FR-012**: The reviewer identity for a rating MUST be the agent's wallet. Wallet and service
  owner MUST be different accounts.

**Dashboard**

- **FR-013**: The dashboard MUST show the reputation rule in plain words, the trusted reviewers,
  and per service: identity details, trusted average, review count, payable status with reason,
  and a score history.
- **FR-014**: Ratings and reputation-based refusals MUST appear in the timeline with links to
  their public records.
- **FR-015**: Reputation shown on the dashboard MUST equal what the public registry returns for
  the same reviewers.
- **FR-016**: All new text MUST be in English and Chinese, as in feature 001.

**Operation**

- **FR-017**: The scheduled runs MUST include paid calls to every demo service and publish their
  ratings, so the story evolves without manual steps.
- **FR-018**: The demo MUST stay on the test network and cost $0 a month, as in feature 001.

### Key Entities

- **Reputation rule** (per wallet): enabled flag, trusted reviewers, minimum average, minimum
  review count.
- **Trusted reviewer**: an account whose ratings count. In the demo, each demo agent wallet.
- **Service identity**: a public agent identity with name, description and registered payment
  address, owned by an account that is not a reviewer.
- **Rating**: reviewer, service identity, score 0–100, reason tag, link to the payment it rates,
  time. It can be revoked by its author.
- **Reputation snapshot**: trusted average and count for a service at a point in time, used for
  the score history.
- **Refusal (extended)**: feature 001's refusal plus the five new reasons.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of attempts to pay non-allowlisted services that don't meet the rule are
  refused with no funds moved, across at least 50 tests covering all five new reasons.
- **SC-002**: Fake reviews from untrusted accounts change the agent's payment decision in 0% of
  tests.
- **SC-003**: Every settled paid call has its rating on the public record within the same
  scheduled run (100% over one week).
- **SC-004**: Within 3 days of scheduled runs, the flaky service falls below the threshold and is
  refused on every later attempt. The dashboard shows when its status changed.
- **SC-005**: The dashboard's averages and counts match the public registry for the same
  reviewers in 100% of spot checks.
- **SC-006**: In a 60-second first-view test, at least 4 of 5 non-technical testers can say which
  services the agent pays and why one is refused.
- **SC-007**: Running cost stays $0 a month.

## Assumptions

- **Builds on feature 001**: needs the agent wallet, agent, paid service and dashboard from
  feature 001's MVP (user stories 1–3). This feature extends them.
- **Public registries**: the ERC-8004 Identity Registry (`0x8004A818BFB912233c491871b3d84c89A494BD9e`)
  and Reputation Registry (`0x8004B663056A597Dffe9eCcC1965A193B7388713`) are live on Base
  Sepolia. Checked on-chain on 2026-10-08: "AgentIdentity"/`AGENT` tokens; the reputation
  registry points to that identity registry; and they're in use (agent #1 has feedback from 12
  clients).
- **Standard's shape**: the ERC-8004 reputation summary requires an explicit, non-empty list of
  reviewer addresses, and owners can't rate their own agent. This is why the rule uses trusted
  reviewers and why owners and reviewers are separate. ERC-8004 is still a draft, so the plan
  must pin the deployed contracts' actual interface.
- **Demo services**: the reliable, flaky and newcomer services run in the same free Worker as
  feature 001's paid API, on different routes. Each is registered with its own identity, owned by
  a separate "services operator" account.
- **Reviewers**: up to three demo agent wallets act as reviewers, so a trusted average has more
  than one voice. Scoring is a fixed program, not an AI model.
- **Out of scope**: validation (third-party verification) from ERC-8004's validation registry,
  real AI judgement of response quality, mainnet, and paying agents outside the demo set (beyond
  the impersonation test).
