# Tasks: An Agent Hires an Agent

- [x] T001 Spec, plan, constitution check; design review (payee rules must reach the worker)
- [x] T002 `IJobEscrow.sol`, `JobEscrow.sol`
- [x] T003 Unit tests: every transition, permission (agent, strangers), timeout boundary, front-run, agent rotation, worker wallet
- [x] T004 Fuzz: every path pays the full price to one side; action xor timeout at every moment; unallowed workers never funded
- [x] T005 Invariants: held = unclosed prices ≤ balance; each job closes once for its price (hostile client, direct transfers, surplus recovery)
- [x] T006 Fork test against real Base Sepolia USDC (nothing broadcast)
- [x] T007 ABI export; `packages/agent/src/escrow.ts` + tests; shared job-id fixture
- [x] T007b Review fixes: arbiter must be the hiring wallet's operator; `hireAgent` checks the worker for free before signing
- [x] T008 Security review of `JobEscrow.sol` ([security-review.md](security-review.md)): F1
      (refused payout froze a job) and F2 (worker = arbiter / escrow) fixed and tested; F3–F6
      accepted and documented. Self-review by the author, not an independent audit
- [x] T008b `deploy-escrow` CLI command and owner runbook ([quickstart.md](quickstart.md)), rehearsed on a local fork
- [ ] T009 Owner: deploy the escrow on Base Sepolia; `setPayee(escrow, true)` and the worker on research-bot-01 (quickstart steps 1, 4)
- [ ] T010 Owner: worker key and wallet (`worker-bot-01`), GitHub secret (quickstart steps 2, 3, 6)
- [ ] T011 Scheduled scenario: hire, deliver, accept; one deliberate dispute; timeouts
- [ ] T012 Dashboard: jobs on the timeline, a "hired agents" card (en/zh)
