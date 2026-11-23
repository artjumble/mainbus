> **Investigation #212:** Investigate: human-owned tickets (no automatic agent work; optional on-request agent help) with a distinct look on the board
> **Date:** 2026-11-23 · **Status:** report, recommends but doesn't authorize changes
> **The question (the user's words):** investigate having a ticket be entirely owned by a human. No agent takes any action, or maybe the user can send an agent a message and it can react to that, but nothing automatic. I would also be nice if on the board this ticket had a styling difference that made it clear it was for the human.

# Investigation: human-owned tickets (#212)

## What was asked

Some tickets should be **owned by a human**. No agent acts on them on its own: no lineup run, no unattended start, no start proposal, no automatic follow-up. Optionally the user can message an agent about the ticket and it reacts to that one message. On the board these tickets should be clearly the human's, and the look must not rely on color alone (#48, #191). Typical uses: manual QA, hand checks on a Mac or Linux (#137, #210), and setup outside the code (the Apple Developer account, npm trusted publishing).

## Short answer

- **Model:** add a per-ticket **owner flag** (`owner: 'agent' | 'human'`, default `'agent'`) on any ticket (option b). It is the smallest change and keeps `kind` meaning "which lineup".
- **Guard:** one shared predicate, used in two layers: a hard refusal in the one place every start goes through, and a filter in each place that picks tickets to start.
- **Help on request:** don't build a per-ticket agent session yet. The orchestrator already reads any ticket by number and answers questions. Add a "Hand to agents" action for when the user wants real work done: it flips the owner and the ticket becomes ordinary.
- **Styling:** a "You" badge with a person icon, a thick left accent border on the card (a shape, not only a hue), and "yours" in the accessible name. A "Mine / Agents' / All" board filter comes later.
- **Plan:** four small tickets plus one optional (below). The first two deliver the guarantee and the look.

## What I looked at

`src/shared/domain.ts` (Ticket, TicketKind, Hold), `src/engine/holds/holds.ts`, `src/engine/runner/ticketRunner.ts` (start, updateFromMain, recovery, moveToColumn), `src/engine/runner/unattended.ts`, `src/engine/index.ts` (startChecked, proposals, wakes, done review, unblocking, `ticket.move`, `agent.start`), `src/engine/proposals/createTickets.ts`, `src/engine/orchestrator/prompt.ts` and `readTools.ts`, `src/renderer/src/board/TicketCard.tsx`, `src/renderer/src/ticket/TicketView.tsx` (`NobodyWorking`), and the tickets table in `src/engine/db/schema.ts`. Nothing was run; this reads the code on `main` at 3af7541. No code was changed.

## Facts that shape the design

- A ticket gets a branch and worktree only when first started (`worktreePath` and `branch` are null before). A human ticket that is never started has no folder and no branch, so it costs nothing on disk.
- A ticket's column is derived from its runs (`runner.stateOf`); `manualColumn` is only `backlog`, `ready` or `done`. With no runs, a human ticket can only sit in Backlog, Ready or Done. That fits: Needs you, In progress and Review describe agent work.
- Holds already keep unattended mode (`holds.heldIds()`) and start proposals (`whyNotStartable`) away. But a hold ends by its date, when the user starts the ticket (`agent.start` calls `holds.unhold`), and at Done. It does not stop the Start button or Update from main. It means "wait", not "mine".

## 1. Model options

| | (a) New kind "Human" | (b) `owner` flag | (c) Zero-role lineup / "Manual" preset | (d) Permanent hold |
|---|---|---|---|---|
| Meaning | Overloads `kind`, which picks a lineup | Separate axis: who does the work | "No roles" is an odd state; Start still shows | A hold with no date and a reason |
| Simplicity | Medium: `kind` is read in about a dozen non-test files (lineups, promote, PR code, cards, create flow); each needs a third case | Simple: one column, one predicate | Presets are Change-only (`createTickets.ts`); a start with zero roles breaks the runner's assumption of at least one role | Simplest to build |
| Automatic paths to guard | All, plus every `kind` switch | All, through one predicate | Most paths would still fire, then do nothing, with confusing notices | Only two paths honor holds today |
| Migration | New enum value; existing readers break on it | One column with a default; no data rewrite | A lineup or preset record per workspace | None, but hand-made holds look like deliberate ones |
| Verdict | No | **Recommended** | No | No |

Why not (d): a hold is cleared by `agent.start`, by Done, and a date can be set by mistake. It reads as "held by you" (a pause), not "this is yours", and clearing it would silently make the ticket agent-owned.

Why not (a): a human ticket would have to give up being a Change or Investigate ticket, but the user may later hand it to agents and want its lineup kept.

## 2. Guarantees: every automatic path

One pure function in `src/shared` (`agentsMayAct(ticket)`, true when `owner === 'agent'`) is the only definition, used by engine and renderer. Layer 1: the runner's `startNow` (and `startChecked`) refuse a human ticket, so no caller can start one. Layer 2: each chooser filters, so it never tries.

| Path | Where it acts today | How it skips a human ticket | Test |
|---|---|---|---|
| Unattended mode (#3, #178) | `unattended.ts` picks Ready tickets, skipping held and blocked (about line 284) | Add `owner` to that filter; it never counts toward N | `unattended.test.ts`: a human ticket at the top of Ready is passed over and the next agent ticket starts |
| Orchestrator start proposals | `whyNotStartable` in `index.ts` | Return "#N is yours; the user has to hand it to agents first"; `propose_start` refuses with that text | `startLineup.test.ts`: proposing a human ticket fails with the reason |
| Start-when-ready (`proposeStartIfAsked`) | Move or create into Ready with the request set | Clear the request and propose nothing when human | engine test: move a human ticket to Ready, no proposal made |
| Drag to In progress (#20) and the Start button (`agent.start` → `startChecked`) | `startChecked` | Refuse in `startChecked` and `startNow`. The card's drag to In progress is disabled; the ticket view shows no Start | engine: `agent.start` rejects; UI: no Start button, drop refused |
| Done review (#117) | `queueDoneReview` after Done | Skip when human. It already skips tickets that never ran; skip explicitly so a converted ticket with old runs is skipped too | `doneReview.engine.test.ts`: human ticket to Done adds no wake |
| Update from main (#80) | `updateFromMain` → `startNow` | Covered by the `startNow` refusal; also hide the action in the UI | engine: `updateFromMain` on a human ticket rejects |
| Unblocking (#79) | `noteUnblocked` only writes an Activity note and feeds the orchestrator's next turn; it starts nothing | Nothing to guard. Keep the note (useful to the human); the prompt keeps "never propose starting it" | existing unblocked test plus one for a human dependent |
| Restart recovery (#40) | `recoverRuns` resumes open runs | A human ticket has no open run: conversion to human is refused while a run is open. Add a belt-and-braces skip | `recovery.test.ts`: an open run on a human ticket is not resumed |
| Wakes (#38) | `failure`, `stuck`, `released_hold`, `resurfaced`, `done_review` | `failure`, `stuck`, `resurfaced` need a run, so none arise. Skip `released_hold` for human tickets; `done_review` as above | `wakes.engine.test.ts` per kind |
| Stuck detector, usage-limit resume | Act on open runs only | Same reasoning as recovery | one assertion each |
| Orchestrator tools | Read and edit tickets | May read, and edit text when the user asks (as for any ticket). Never `propose_start`. Prompt and `readTools` show the owner | `prompt.test.ts`, `readTools.test.ts` |

Two more rules. A ticket handed to agents is an ordinary ticket and everything above applies again. A regression test enumerates the engine commands and proposal kinds that start a role and fails when a new one has no human-owned test (insurance for future paths).

## 3. On-request agent help

**Recommendation: skip a per-ticket helper for now.** The orchestrator panel already answers questions and reads any ticket by number, so "what should I check on #137?" or "draft a checklist" needs no new session type. A per-ticket helper needs its own role, permission rules, a folder policy, and usage and Time report accounting, for little over the orchestrator.

Build instead, in order:

1. **"Ask the orchestrator about this ticket"** on the human ticket's view: opens the orchestrator panel with the ticket referenced. No new engine path.
2. **"Hand to agents"**: for when the user wants changes made. It flips `owner` to `agent`; the ticket becomes a normal Backlog/Ready ticket with Start. Only a deliberate click turns agents on. "Take back" reverses it when nothing is running.

If a true one-shot helper is wanted later: a message box on the ticket runs a single read-only turn in a scratch folder (no worktree, no branch), ends after one reply, never hands off or chains, uses the normal permission guard with writes denied, and is recorded in usage as its own call kind (like the promote summary call). That is a larger piece (role kind, accounting, UI) and not needed to meet the goal.

## 4. Board and ticket-view styling

Rules: not color alone (#48), meets the theme contrast bar (#191, enforced in `theme.test.ts`), one shared component.

- **Card:** a "You" badge with a person icon in the slot where the "Investigate" badge sits, plus a 4 px solid left accent border in a new themed token, so the difference is a shape as well as a hue. A tint is optional; the lane/card contrast tests are tight, so a tint needs new cases in `theme.test.ts`.
- **Accessible name:** "#212, yours: Title…", so a screen reader hears "yours" first.
- **Chips that don't apply are hidden:** phase, paused, queued, setting up, run settings, stuck. Hold and blocked chips stay.
- **Ticket view:** the header shows the same badge. The empty state "Nobody is working on this yet" becomes "This ticket is yours": a line saying no agent will start on it, the ticket's criteria as the checklist (they can already be ticked), and the buttons Mark done, Ask the orchestrator, Hand to agents. No Start, no Run settings.
- **Columns:** human tickets show in Backlog, Ready and Done only; never in Needs you, In progress or Review, so Needs you stays "agents need an answer". The rail badge (`railBadge.ts`) should not count them as agent work.
- **Filter (later):** a "Mine / Agents' / All" control in the board header, remembered per workspace and announced to screen readers.
- **Themes:** add the token to all four themes in `theme.ts` with contrast cases; rerun the artboards.

## 5. Creation and conversion

- **New ticket dialog:** an "Owner" choice, Agents (default) or Me. Me hides lineup and run settings (it keeps a kind, default Change, for a later hand-off).
- **Orchestrator create tools:** `propose_create_tickets` takes an optional `owner: 'human'` per draft; the prompt says to use it for hand checks and setup tasks. The proposal card shows the badge. Presets with `owner: 'human'` are a validation error (same pattern as the existing investigate-preset check).
- **Converting:** "Mine" and "Hand to agents" actions in the ticket menu, and a confirmed orchestrator proposal. Refused while a run is open or the ticket is Done. Saved run settings are kept (ignored while human-owned, not deleted), so converting back restores them. An existing worktree or branch from earlier runs stays. Activity records "Marked as yours" and "Handed to agents".
- **Migration:** one Drizzle migration adding `owner text not null default 'agent'`. Nothing existing becomes human.

## 6. Effort and order

| Phase | Ticket | Size | Risk |
|---|---|---|---|
| 1 | Engine: owner flag, guards, tests | M | Medium: easy to miss a path; mitigated by the `startNow` refusal and the path-enumerating test |
| 2 | Board card and ticket view | M | Low-medium: theme contrast, artboards, e2e |
| 3 | Create and convert | M | Low |
| 4 | Ask the orchestrator from the ticket, and the board filter | S | Low |
| 5 | (Optional) one-shot read-only helper | L | Medium: new role kind, accounting |

## Proposed change tickets

**1. Human-owned tickets: engine**
- Scope: `owner` column and migration; `Ticket.owner`; `agentsMayAct()` in `src/shared`; refusal in `startChecked` and `startNow`; filters in unattended mode, `whyNotStartable`, start-when-ready, done review, the `released_hold` wake and recovery; a set-owner engine command with Activity entries; orchestrator prompt and `readTools` show the owner and never propose a start; owner in the board payload.
- Criteria: every path in the table has a test showing a human ticket is skipped or refused; conversion is refused with an open run or in Done; saved run settings survive a round trip; agent tickets behave as before; typecheck and related tests pass.

**2. Human-owned tickets: board and ticket view**
- Scope: "You" badge with icon, left accent, token in all four themes, accessible name "#N, yours: …"; hide agent-only chips; disable drag to In progress; replace `NobodyWorking` with "This ticket is yours" (checklist, Mark done, Hand to agents); header badge; rail count.
- Criteria: the difference is visible with color removed (screenshot check per theme); contrast tests pass in all four themes; axe finds no violations on board and ticket view; no Start or Run settings on a human ticket; e2e covers a human ticket on the board and in the view.

**3. Human-owned tickets: create and convert**
- Scope: Owner choice in New ticket; `owner` on `propose_create_tickets` (with preset rejection); "Mine" and "Hand to agents" actions; orchestrator conversion proposal.
- Criteria: a hand-check ticket can be created from the dialog and by the orchestrator; converting both ways keeps title, spec, criteria, run settings and rank; refused cases show a clear message.

**4. Ask the orchestrator from a ticket, and a board filter**
- Scope: a button that opens the orchestrator with the ticket referenced; a Mine / Agents' / All filter per workspace.
- Criteria: the filter is keyboard-operable and announced; no new engine start path.

**5. (Optional) One-shot helper on a ticket**
- Scope and criteria as in section 3; only if the orchestrator route proves too heavy.

## Open questions for the user

- Should a human ticket ever show in the Needs you lane (for example with a due date)? Recommendation: no.
- Is a badge plus filter enough, or do you want a dedicated "Mine" column? A column is a bigger change; recommendation: badge plus filter.
