# Mainbus v1 roadmap

**Spec:** `docs/superpowers/specs/2026-10-30-mainbus-design.md` (approved 2026-10-30)

**Status (2026-11-02):** M0–M5 are done, and M6 is next. M5's exit scenario is automated in `e2e/m5Exit.spec.ts`, and `docs/manual/m5-stuck-recovery-by-hand.md` runs it by hand against a real agent.

The spec's self-hosting MVP (§15a) splits v1 into two halves:
- **M0–M1** are built directly, outside Mainbus. M0 is a throwaway spike and M1 is the MVP.
- **M2–M7** are built through Mainbus itself, as tickets on its own board. Each one gets its own detailed plan when it starts, written against the code that exists by then.

| # | Milestone | Built how | Detailed plan |
|---|---|---|---|
| M0 | Agent SDK spike | Directly; throwaway code | `2026-10-30-m0-sdk-spike.md` |
| M1 | Self-hosting MVP | Directly | `2026-10-30-m1-mvp.md` |
| M2 | Lineups and handoffs | Through Mainbus | Written at M2 start |
| M3 | Orchestrator | Through Mainbus | Written at M3 start |
| M4 | Decisions in three places, holds and "Later" | Through Mainbus | Written at M4 start |
| M5 | Stuck detection, Redirect, Replace | Through Mainbus | Written at M5 start |
| M6 | Durability: automatic restart recovery, wake queue, usage limits, concurrency cap | Through Mainbus | Written at M6 start |
| M7 | Investigate tickets, multiple workspaces, empty states, tray, polish | Through Mainbus | Written at M7 start |

## M0. Agent SDK spike (throwaway)
- **Proves:** every §15 assumption the MVP rests on, on this Windows machine with the user's subscription.
- **Keeps:** the recorded SDK message fixtures (used by M1's normalizer tests) and a results doc.
- **Exit:**
  - `docs/spikes/2026-10-30-m0-results.md` answers every experiment.
  - The M1 plan is amended wherever a finding contradicts it.

## M1. Self-hosting MVP
- **Scope:** spec §15a "In the MVP".
- **Exit:** spec §15a "Done when", run by the user on the stable build.

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

## M3. Orchestrator
- **Scope:**
  - The docked panel and the collapsed strip.
  - The orchestrator session: its working directory, read-only tools and voice rules (§11).
  - Read and propose tools; proposals rendered as Confirm/Override cards; deterministic execution of confirmed proposals.
  - Drafting tickets from a request, with verbatim intent.
  - Picking model and effort per role.
  - Drag into In progress creates a proposal.
- **Exit:** the user asks for the M4 tickets in plain words, confirms the drafts, and starts one, all from the panel.

## M4. Decisions in three places, holds and "Later"
- **Scope:**
  - One decision record rendered on the board card, in the orchestrator card and inline.
  - `answered_via`.
  - The `hold` table, ticket Hold/Unhold, "Later…" on decisions, and automatic release on the hold's date (§6, §10).
  - The deferred group in the orchestrator panel.
  - The `propose_answer` rubric.
- **Exit:** a decision answered from any of the three places resolves all three. A deferred decision reappears on its date.

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

## M6. Durability
- **Scope:**
  - Automatic restart recovery (§10).
  - The `orchestrator_wake` queue with acknowledgement after the turn.
  - Usage-limited pause and resume, and the early warning (§12a).
  - The concurrency cap and Queued.
- **Exit:**
  - Killing Mainbus mid-run and relaunching resumes every agent with nothing lost.
  - A simulated usage-limit event pauses and resumes the fleet.

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

## Out of v1
- BackgroundRuntime: not planned (M0 E10).
- ApiKeyRuntime.
- Cheap triage for stuck-detector hits (§11 post-v1 idea).
- GitHub/GitLab adapters.
