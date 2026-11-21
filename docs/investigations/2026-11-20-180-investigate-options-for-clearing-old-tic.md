> **Investigation #180:** Investigate: options for clearing old tickets out of the Done column without losing access to them
> **Date:** 2026-11-20 · **Status:** report, recommends but doesn't authorise changes
> **The question (the user's words):** create an investigation on how to handle old tickets. Currently the done column just keeps growing. I need some options on how to clear them out, but not entirely lose access to them.

# Investigation: clearing old tickets out of the Done column without losing access to them

Ticket #180. Date: 2026-11-20. No code was changed.

## The question

The Done column only grows (about 150 Done tickets in the mainbus workspace). What are the options for taking old tickets off the board while keeping access to them? Recommend one approach and give a phased plan of change tickets.

## What I looked at

- `src/engine/index.ts` (`boardTickets`, `boardView`, the wake digest's "recent Done" list), `src/engine/orchestrator/readTools.ts` (`list_tickets`, `get_ticket`, Time report), `doneReview.ts`, `wakeDigest.ts`.
- `src/engine/store/tickets.ts`, `dependencies.ts`, `runs.ts` (`reachedReview`), `src/engine/time/report.ts`, `src/engine/state/railCounts.ts`, `src/engine/state/currentState.ts`.
- `src/engine/db/schema.ts` (`tickets`, `agent_events`), `src/renderer/src/board/Board.tsx` (`DoneColumn`, search), `board/search.ts`, `src/cli/mcp.ts`.
- Not done: I did not measure the real database (the stable data home isn't readable from the ticket folder), so size and speed claims below are reasoned from the code, not measured. I did not re-read #48 (the accessibility bar), #61, #100 or the other referenced tickets; I rely on the spec's description of them. Other boards' behaviour is from my knowledge; the URLs were not re-fetched.

## Findings: who reads Done tickets today

| Reader | How it reads | Would hiding or moving old tickets change it? |
|---|---|---|
| Board and Done strip (#61) | `boardView` builds **every** ticket of the workspace on every board change: runner state, holds, stuck, freshness, attachments, edits, blockers, notes, lineup. Cost grows with total tickets, not open ones. | Yes, and this is the scale problem. Anything left out of `boardView` is off this hot path. |
| Board search (#46) | `matchesSearch` runs in the renderer over the tickets it already has | Yes: archived tickets wouldn't be found unless search asks for them |
| `list_tickets` (orchestrator) | Lists every ticket from `deps.board(ws)`, one line each (~200+ characters). About 175 lines now, roughly 40k characters per call (my estimate, not measured) | Yes: this is where leaving archived out saves context |
| `get_ticket`, `get_run_status`, `get_recent_events`, Time report for one ticket | `ticket(number)` **finds the ticket in `deps.board(ws)`** (`readTools.ts:326`) | **Yes, a trap.** If archived tickets are simply dropped from `board()`, `get_ticket #123` answers "No ticket #123". It needs an include-archived path |
| `get_ticket` "Promoted from/to" | Also scans `deps.board(ws)` (`readTools.ts:438`) | Same trap |
| Done-review (#117) | Reviews one ticket as it reaches Done (`doneReviewOf`, reads that ticket's runs, events, decisions, dependents). The duplicate-check list is the open tickets plus the newest 15 Done by number (`index.ts:1362`) | No for the review. The "use list_tickets" hint should mention archived tickets |
| Blocked-by (#79) | `dependencies.ts` joins `tickets` directly; `done` is `manualColumn === 'done'` | No, **if archiving does not change `manualColumn`**. If archived tickets were moved to a new column or deleted, every dependent would see a blocker that isn't Done or has vanished |
| Time report (#102) | `reachedReview` joins `ticket_runs` and `tickets` by workspace; `workspaceTimeFor` reads each ticket and its events | No, as long as the rows and their events stay. Deleting (export-and-prune) removes them from the report and the usage totals |
| Usage totals | Computed from each run's `usage` events | Same as the Time report |
| Promote (#43) | `repos.tickets` lookups (`promotedTo`, `byNumber`), not the board | No, except the `get_ticket` link line above |
| Rail counts, tray, badge | `railCounts` counts `needs_you` and agent states; Done tickets have `agentStatus: null` | No: Done never counts |
| Attachments, report, branch, PR | Rows and files keyed by ticket id; the ticket folder is already removed at Done | No (unless deleted) |
| MCP/CLI `list_tickets` for outside agents (`cli/mcp.ts`, `intake`) | All tickets, optional column filter | Yes, same context cost; also used to avoid duplicates |

Two more facts that shape the design:

- **There is no "reached Done" timestamp.** The column is `manual_column = 'done'` and `updated_at` is bumped by any later edit (blockers, report file, notes). "Done for more than N days" needs a new `done_at`. "The newest N" can use ticket number (as the wake digest does) but that isn't Done order.
- Ticket numbers are per workspace and never reused (unique index on workspace and number), so `#123` is a stable handle that survives archiving.

## Options

### 1. Archive state

A nullable `archived_at` on the ticket. `manual_column` stays `done`. Archived tickets are left out of the board, `boardView` and `list_tickets` by default, and reachable from an Archive view, from search, by number and by blocker links. Restore clears the flag.

- **Finding again:** Archive view (newest first, paged, searchable); board search with an "also in Archive (N)" link and `#123` that opens an archived ticket; blocker chips and "promoted from" links open archived tickets; orchestrator `get_ticket` by number keeps working, `list_tickets` gets an opt-in.
- **Blocked-by, done-review, Time report, usage, attachments, reports:** all unchanged (rows stay, `manual_column` stays `done`).
- **Scale:** the board's hot path covers only open and recently Done tickets, so the cost stays flat as history grows. Archive listing is a paged query; it needs an index on (workspace, archived_at).
- **Restore:** clear `archived_at`; the ticket reappears in Done. Cheap, per ticket or in bulk.
- **UI:** a button on the Done strip, an Archive view, an Archive action on a ticket and on Done cards, bulk select.
- **Settings:** per workspace.
- **Cost:** a migration, a new filter in `boardView`, the readTools `board()` include-archived path, a view.

### 2. Show only recent Done tickets

Done shows the last N or last N days; "Show older" pages in the rest. No state change.

- **Finding again:** the "Show older" paging and search. But the data layer doesn't change: `boardView` still builds every ticket, `list_tickets` still returns all 175, and search still needs to look at everything.
- **Blocked-by, done-review, Time report, usage:** unchanged.
- **Scale:** fixes the visual growth only, not the engine or orchestrator cost, unless it is also pushed into `boardView`, at which point it is option 1 without an explicit flag.
- **Restore:** nothing to restore.
- **UI:** simplest of all (a cut-off and a link).
- **Settings:** a number, per workspace or app-wide.

### 3. Export and prune

Write old tickets to markdown or JSON (possibly into the repo like these reports) and delete the rows.

- **Finding again:** by file only; not in the app, search, `#123` links, or `get_ticket`.
- **Blocked-by:** `ticket_dependencies` references `tickets`; deleting a blocker cascades or orphans, and dependents lose their history.
- **Time report and usage:** the deleted tickets' runs and events vanish from the totals unless they are re-ingested from the export.
- **Scale:** best (the database shrinks). But the events (`agent_events` JSON per event) are the bulk, and they can be shrunk without deleting tickets.
- **Restore:** needs an import feature; lossy unless the format is complete.
- **UI:** an Export action and a way to open files.
- **Verdict:** loses in-app access, which the ticket forbids ("not entirely lose access"). Worth keeping only as an optional extra: "Export archive to files" as a backup.

### 4. Group by period or milestone

Done becomes collapsible sections: this week, earlier, by label.

- **Finding again:** scroll and expand; the same search.
- **Engine, orchestrator, scale:** no change at all, so no benefit to `list_tickets`, `boardView` or the DB.
- **UI:** the grouping inside a strip that opens on hover is awkward (a long list of headers); needs keyboard handling and an accessible tree/disclosure pattern.
- **Verdict:** cosmetic. Useful as a presentation of the Archive view (group by month) but not a fix.

### 5. How other boards handle it (from knowledge; URLs not re-fetched)

- **Linear** auto-archives completed issues after a workspace-chosen period (months). Archived issues leave views but stay searchable and linkable, and can be unarchived. <https://linear.app/docs/archive>
- **Jira** boards show only recently resolved issues in the last column (a time window; older ones stay in the project and search, and are found by filter). Releasing a version clears the column. <https://support.atlassian.com/jira-software-cloud/docs/configure-the-columns-for-a-board/>
- **GitHub Projects** has an Archive for items (manual and bulk, plus an auto-archive workflow driven by a filter such as closed and not updated for N days); archived items are found with `is:archived` and restored from there. <https://docs.github.com/en/issues/planning-and-tracking-with-projects/managing-items-in-your-project/archiving-items-from-your-project>
- **Trello** archives cards and lists (manual, or by Butler automation); archived items are searchable (`is:archived`) and restorable from the board menu. <https://support.atlassian.com/trello/docs/archiving-and-deleting-cards/>

The pattern in all four is the same: a flag plus a window, never deletion, with search and an archive view as the way back. That is option 1 with option 2's recent window as its default view.

## Comparison

| | 1. Archive state | 2. Recent only | 3. Export and prune | 4. Group by period |
|---|---|---|---|---|
| Finds old tickets in the app | Yes: view, search, `#N`, links | Yes, by paging | No (files) | Yes, by expanding |
| `get_ticket` by number | Works (needs the include-archived fix) | Works | Fails | Works |
| `list_tickets` shrinks | Yes, default | No | Yes | No |
| Blocked-by | Unchanged | Unchanged | Breaks or orphans | Unchanged |
| Done-review | Unchanged | Unchanged | Unchanged | Unchanged |
| Time report, usage | Unchanged | Unchanged | Loses the tickets | Unchanged |
| Board speed with thousands | Flat | Not fixed | Best | Not fixed |
| Restore | One click, bulk | n/a | Import feature | n/a |
| Manual and automatic | Both | Automatic only | Either | n/a |
| Effort | Medium | Small | Large | Small |

## Recommendation: option 1, with a recent window, manual and automatic

Add `archived_at` and `done_at` to tickets. Archived tickets stay Done in every way that other features see (`manual_column`, rows, events, runs, files); they are only left out of the board and of the orchestrator's default list.

Reasons:

1. It is the only option that fixes all three costs at once: the cluttered board, the orchestrator's `list_tickets` size and the `boardView` work per refresh.
2. It leaves blocked-by, done-review, the Time report, usage, attachments, reports and promotion exactly as they are, because nothing is moved or deleted.
3. It is reversible and the way every comparable tool does it.

Decisions to make it concrete (all changeable by the user):

- **Manual and automatic.** Manual: Archive on a Done ticket, plus a bulk "Archive all Done older than…" on the Done strip. Automatic: a per-workspace setting "Archive Done tickets after N days" (suggest 14), swept at start-up and then daily. Only tickets in Done are ever archived, never ones in other columns.
- **Default.** Turning it on by default would archive about 140 tickets on first run. Suggest on at 14 days with a visible one-time notice and a "Restore all" undo, or the user can choose off by default. This is the one decision I'd ask them to make.
- **Per workspace**, like the Unattended setting (#178); the Archive view and `get_ticket` are workspace-scoped already.
- **`done_at`** is set when a ticket enters Done and cleared on leaving. The migration backfills from the ticket's `updated_at` (approximate for old tickets, since edits bump it); say so in the notes.
- **Orchestrator.** `list_tickets` leaves archived out by default and ends with a line such as "(+138 archived; ask with archived: true)"; it takes an optional `archived` argument. `get_ticket`, `get_run_status`, `get_recent_events` and the Time report by number still work on archived tickets. The workspace Time report by range is unchanged. The done-review duplicate hint says "or search the archive".
- **Events.** Don't compact thread events yet. The Time report and usage totals are computed from `tool_call`, `tool_result`, `turn_end` and `usage` events, so compaction would change reports unless it keeps those. First measure the database (`agent_events` size per archived ticket); compaction is a separate, later ticket.

## Phased plan (proposed change tickets)

**1. Archive state in the engine** (Change)
- Scope: migration adding `tickets.done_at` and `tickets.archived_at` (index on workspace and archived_at); backfill `done_at` for Done tickets; set and clear `done_at` in `setManualColumn`; repo methods `archive(ids)`, `unarchive(ids)`, `listArchived(workspace, {query, before, limit})`; `boardView` and `boardTickets` leave archived tickets out; readTools `ticket()` and the promoted-from lookup use an include-archived board so `get_ticket #N` still works; an engine command and event (`board.changed`) for archive and unarchive.
- Criteria: archiving a Done ticket removes it from `boardView` and `list_tickets`; `get_ticket`, `get_run_status`, `get_recent_events` still work for it; a ticket blocked by an archived ticket still shows the blocker as Done and is unblocked; the Time report and usage totals are identical before and after archiving; only Done tickets can be archived; unarchive restores it to Done; migration backfill tested; tests in `openTestDb`.

**2. Archive view, restore and search in the app** (Change; depends on 1)
- Scope: an "Archive (N)" button on the Done strip opening an Archive view (newest first, paged, with a search box and group-by-month headers); Archive and Restore actions on a Done ticket and in the view, with multi-select and bulk Restore; board search shows "N more in the Archive" and `#123` opens an archived ticket; blocker chips and "promoted from" open archived tickets; archived tickets are read-only, as Done is (#100).
- Criteria: everything is reachable by keyboard with visible focus, labelled controls and screen-reader announcements (the #48 bar); an archived ticket opens from a blocker chip, from `#N` search and from the Archive view; restore from the view puts it back in Done; unit tests for the view; an e2e spec for archive then find then restore (in `SERIAL_SPECS` if it relies on hover).

**3. Orchestrator and MCP awareness** (Change; depends on 1)
- Scope: `archived` argument on the orchestrator's `list_tickets` and on the MCP/CLI `list_tickets` (default off); the count line for archived tickets; prompt text and the done-review rubric and duplicate hint updated; the `list` intake method follows the same default.
- Criteria: default `list_tickets` excludes archived tickets and says how many are left out; `archived: true` lists them; `get_ticket` by number works; prompt tests updated; the output for a workspace with 150 archived tickets is no longer than for one without them plus the count line.

**4. Automatic archiving and bulk archive** (Change; depends on 1 and 2)
- Scope: per-workspace setting "Archive Done tickets after N days" (off, or 7/14/30/90 days) in workspace settings; a sweep at start-up and daily that archives Done tickets whose `done_at` is older than N days; a bulk "Archive all Done older than…" action; a one-time notice after the first sweep with "Restore all archived by this sweep".
- Criteria: the sweep archives only Done tickets past the age and never touches other columns; the setting is per workspace and persists; the notice and undo work; the sweep is idempotent and tested with a fake clock; the default is what the user chose.

**5. Measure, then export and compaction (optional)** (Investigate, then Change)
- Scope: measure the database size by table and by ticket (`agent_events` especially) and the board's refresh time at 150, 1,000 and 5,000 tickets; decide whether to compact the events of tickets archived for over N months (keeping handoffs, decisions, messages and the events the Time report and usage need) and whether to offer "Export archive to files" as a backup.
- Criteria: numbers recorded in a report; any compaction leaves the Time report and usage totals unchanged for the tickets it touches (tested); export is optional and never deletes.

Phase 1 must ship with the readTools fix, because as soon as one ticket is archived, an unaware `ticket()` lookup would stop finding it.

## Open questions for the user

- Should automatic archiving be on by default (14 days suggested), given it will archive about 140 tickets the first time?
- Is a per-workspace setting enough, or do you want an app-wide default too?
- Do you want the Archive view grouped by month, or a flat list with search?

## Limits of this report

No database measurements; no check of #48's exact criteria; other boards' behaviour is from memory. The renderer's way of opening a ticket by id (blocker chips, promoted-from) wasn't traced; phase 1 or 2 should confirm it can load an archived ticket.
