# Mainbus v1 roadmap

**Spec:** `docs/superpowers/specs/2026-10-30-mainbus-design.md` (approved 2026-10-30)

**Status (2026-11-03):** M0–M7 are done, so v1 is complete. Each milestone below ends with a **Done** line saying when it finished and how its exit was shown. The README describes the app as built, and Appendix C of the design document lists where it differs from the spec.

The spec's self-hosting MVP (§15a) splits v1 into two halves:
- **M0–M1** are built directly, outside Mainbus. M0 is a throwaway spike and M1 is the MVP.
- **M2–M7** are built through Mainbus itself, as tickets on its own board. Each one gets its own detailed plan when it starts, written against the code that exists by then. In the end that detail lived in each ticket's spec on Mainbus's own board rather than in plan files.

| # | Milestone | Built how | Where the work lives |
|---|---|---|---|
| M0 | Agent SDK spike | Directly; throwaway code | `2026-10-30-m0-sdk-spike.md` |
| M1 | Self-hosting MVP | Directly | `2026-10-30-m1-mvp.md` |
| M2 | Lineups and handoffs | Through Mainbus | Tickets #7, #8, #9, #10, #11. Follow-ups: #12, #13, #14, #15 |
| M3 | Orchestrator | Through Mainbus | Tickets #16, #17, #18, #19, #20. Fix: #21 |
| M4 | Decisions in three places, holds and "Later" | Through Mainbus | Tickets #22, #23, #24, #25, #26. Follow-ups: #27, #28, #29, #30, #31 |
| M5 | Stuck detection, Redirect, Replace | Through Mainbus | Tickets #32, #33, #34, #35. Follow-ups: #36, #37 |
| M6 | Durability: automatic restart recovery, wake queue, usage limits, concurrency cap | Through Mainbus | Tickets #38, #39, #40, #41 |
| M7 | Investigate tickets, multiple workspaces, empty states, tray, polish | Through Mainbus | Tickets #42, #43, #44, #45, #46, #47, #48, #49 |

## M0. Agent SDK spike (throwaway)
- **Proves:** every §15 assumption the MVP rests on, on this Windows machine with the user's subscription.
- **Keeps:** the recorded SDK message fixtures (used by M1's normalizer tests) and a results doc.
- **Exit:**
  - `docs/spikes/2026-10-30-m0-results.md` answers every experiment.
  - The M1 plan is amended wherever a finding contradicts it.
- **Done:** 2026-10-30. Every experiment is answered in `docs/spikes/2026-10-30-m0-results.md`.

## M1. Self-hosting MVP
- **Scope:** spec §15a "In the MVP".
- **Exit:** spec §15a "Done when", run by the user on the stable build.
- **Done:** 2026-10-31. The user ran spec §15a "Done when" on the stable build, and `e2e/mvp.spec.ts` covers the same flow. Follow-up tickets #4, #5 and #6 were merged straight to main, without a pull request.

## M2. Lineups and handoffs (first milestone built through Mainbus)
- **Scope:**
  - Lineup settings with a reorderable role list and per-role fields (§6, §13).
  - Ticket runs with a role snapshot and the untick-roles-at-start option.
  - Sequential handoff and the lineup strip.
  - Handoff and replacement dividers.
  - Hand-back loops with the 3-round-trip cap (§9).
  - `report_problem` and `check_criterion`.
  - Skip to next role, Pause and resume.
  - A default Planner → Implementer → Reviewer lineup.
- **Exit:** a Mainbus ticket runs through all three roles, with one Reviewer hand-back, and reaches Review.
- **Done:** 2026-11-01. `e2e/lineup.spec.ts` runs a ticket through Planner, Implementer and Reviewer to Review, and hands a problem back once.

## M3. Orchestrator
- **Scope:**
  - The docked panel and the collapsed strip.
  - The orchestrator session: its working directory, read-only tools and voice rules (§11).
  - Read and propose tools; proposals rendered as Confirm/Override cards; deterministic execution of confirmed proposals.
  - Drafting tickets from a request, with verbatim intent.
  - Picking model and effort per role.
  - Drag into In progress creates a proposal.
- **Exit:** the user asks for the M4 tickets in plain words, confirms the drafts, and starts one, all from the panel.
- **Done:** 2026-11-01. `e2e/m3Exit.spec.ts` drafts tickets from a plain-words request, confirms them and starts one, all from the panel.

## M4. Decisions in three places, holds and "Later"
- **Scope:**
  - One decision record rendered on the board card, in the orchestrator card and inline.
  - `answered_via`.
  - The `hold` table, ticket Hold/Unhold, "Later…" on decisions, and automatic release on the hold's date (§6, §10).
  - The deferred group in the orchestrator panel.
  - The `propose_answer` rubric.
- **Exit:** a decision answered from any of the three places resolves all three. A deferred decision reappears on its date.
- **Done:** 2026-11-02. `e2e/threePlaces.spec.ts` answers a decision from each of the three places, and `e2e/deferred.spec.ts` brings a deferred decision back on its date.

## M5. Stuck detection, Redirect, Replace
- **Scope:**
  - The stuck detector with its thresholds and "not stuck" rules.
  - `report_waiting`.
  - No alert storms.
  - The recovery ladder: `propose_redirect`, then `propose_replace`, then Failed (§12).
  - The generated handoff summary.
  - View previous run.
  - Timeline entries.
- **Exit:** a deliberately stuck test agent (a role prompt that loops on a failing command) is detected, redirected, then replaced. The replacement finishes the ticket.
- **Done:** 2026-11-02. `e2e/m5Exit.spec.ts` detects, redirects and replaces a stuck agent, and the replacement finishes. `docs/manual/m5-stuck-recovery-by-hand.md` runs it against a real agent.

## M6. Durability
- **Scope:**
  - Automatic restart recovery (§10).
  - The `orchestrator_wake` queue with acknowledgement after the turn.
  - Usage-limited pause and resume, and the early warning (§12a).
  - The concurrency cap and Queued.
- **Exit:**
  - Killing Mainbus mid-run and relaunching resumes every agent with nothing lost.
  - A simulated usage-limit event pauses and resumes the fleet.
- **Done:** 2026-11-02. `e2e/restartRecovery.spec.ts` kills and relaunches Mainbus mid-run, and `e2e/usageLimit.spec.ts` pauses and resumes the fleet. `e2e/wake.spec.ts` and `e2e/concurrencyCap.spec.ts` cover the wake queue and the cap.

## M7. Breadth and polish
- **Scope:**
  - Investigate tickets and the Investigate lineup, `submit_report` and Promote (§9).
  - Multiple workspaces with the rail and counts.
  - Empty states.
  - Tray behavior.
  - Search.
  - The fading "recently changed" outline.
  - Accessibility pass.
- **Exit:** every wireframe artboard is reproduced in the app.
- **Done:** 2026-11-03. `e2e/artboards.spec.ts` reproduces every wireframe artboard, and `docs/superpowers/plans/m7-wireframe-pass.md` records each difference and what was done about it.

## Out of v1
- BackgroundRuntime: not planned (M0 E10).
- ApiKeyRuntime.
- Cheap triage for stuck-detector hits (§11 post-v1 idea).
- GitHub/GitLab adapters.
