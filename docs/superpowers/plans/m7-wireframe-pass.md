# M7 wireframe pass

The M7 exit: every wireframe artboard is reproduced in the app. Each artboard export is in `docs/wireframes/`; for each one,
`e2e/artboards.spec.ts` builds the same situation with FakeRuntime in a temporary data home and saves a screenshot to
`test-results/artboards/<slug>.png` (ignored by git). The tests check that the key elements are present, not pixels. Visual
styling only has to stay inside the wireframes' palette and layout (spec §16), so colours, radii and exact spacing are not
differences below.

Columns: **#** · **Area** (layout / content / wording / state / missing) · **Wireframe** · **App before** · **Action**
(fixed, kept + reason, or asked → answer).

## Decisions

- **D1 (asked): lineup settings.** The artboard shows lineup settings as a full page; the app has a Workspace settings drawer.
  *Answer:* keep the drawer, make it wider and lay the lineup out as in the artboard (role list and form side by side, role
  descriptions, an "After the last role" note, a collapsed "Model and effort" section). See L1–L8.
- **D2 (asked): ticket dependencies.** The artboard's drafted ticket reads "4 acceptance criteria · depends on CSV export".
  Mainbus has no ticket dependencies in the spec or the data model. *Answer:* leave dependencies out and record it as not in
  v1. See N7.
- **Fleet line definition (O2).** The numbers count agents, across every workspace: *working* = agents working; *need you* =
  agents waiting on you; *idle* = open agents that are paused or queued. The engine adds `working`, `waiting` and `idle` to
  each workspace summary (`railCounts`).

## Board — `board.png` · `Board@1x.png`

| # | Area | Wireframe | App before | Action |
|---|------|-----------|------------|--------|
| B1 | layout | "Mainbus" at the top of the rail, with a WORKSPACES heading | A full-width header bar above everything | Kept: it is the page's one `h1`, and the layout around it is unchanged. Moving it is optional styling |
| B2 | content | Rail entry has a status line: "• 2 working", "○ Idle", "◆ Waiting on you" | Name, dot and needs-you count only | Fixed: status line under each name (`railStatus`); the summary gained `working`, `waiting`, `idle` |
| B3 | layout | "+ Add workspace" is a dashed, full-width button; hint "Pick a local repo folder to add it." | A plain small button | Fixed |
| B4 | content | Header: name, then the repo path in monospace and "· local tickets" | The path beside the name, in the body font | Fixed. Empty workspace says "· just added" |
| B5 | wording | A "Search" label beside the box | Box labelled for assistive technology only, placeholder "Search (Ctrl+K)" | Kept: the placeholder carries the shortcut (search ticket) |
| B6 | layout | Uppercase small column headings with a plain count; Needs you tinted | Title-case headings, circled count, no tint | Fixed. Grey-filled columns are styling: not done |
| B7 | layout | Six columns fit beside the rail and the panel at 1440 px | Columns scrolled sideways from 220 px | Fixed: the rail is 190 px and the panel 340 px (was 220 and 380), and the columns shrink to 120 px, so all six fit at 1440 (checked in the artboard e2e). Wide sentence-case chips wrap instead of being cut off |
| B8 | state | Chips lead with a symbol: ◆ filled orange, • light blue, – / ○ / ✓ outlined, ✕ dark; full text, wrapping to two lines | Colour-only, uppercase chips cut off in narrow columns | Fixed (`PhaseChip`, Held, Paused, Queued, Looks stuck chips, lineup strip), in sentence case that wraps. Failed reads "✕ Failed in <phase>" |
| B9 | state | Needs you card has an orange border; a failed card a dashed one | No border change | Fixed |
| B10 | content | Needs you card shows the question | Question's first line (clamped) | Kept as is |
| B11 | missing | No Answer button on the card (options in the panel) | Answer button on Needs you cards | Kept: decided in M4 |
| B12 | missing | — | Unattended switch and the settings gear in the header | Kept: later tickets |
| B13 | styling | Near-black primary buttons | Working-blue primary buttons | Kept: inside the §16 palette; changing it risks the contrast checks |

## Ticket detail — `ticket-detail.png` · `Ticket detail (split view)@1x.png`

| # | Area | Wireframe | App before | Action |
|---|------|-----------|------------|--------|
| T1 | layout | "← web-app board" inline before the number; "Source: Local" as a small badge | Back link on its own line; plain text source | Fixed. "is" kept before the chip, as the empty-states artboard has it |
| T2 | layout | Controls row: "Controls apply to the <role>" left, buttons right; order Pause, Stop, Skip to <role>, Replace… | Bold role name, then Stop, Pause, "Skip to next role" | Fixed. Skip names where it goes ("Skip to Reviewer"); its confirmation dialog keeps the title "Skip to next role" |
| T3 | missing | Live line under the thread: "Implementer is editing src/export.ts" (spec §13) | Not built | Fixed: `liveLine` from the latest tool call of the open run, in a polite status region |
| T4 | wording | Composer labelled "Message the Implementer", placeholder "Steer it, answer a question, add context" | Placeholder only, "Message the Implementer" | Fixed: visible label (also the accessible name) and the new placeholder |
| T5 | wording | "Acceptance criteria"; small uppercase section headings | "Criteria"; larger headings | Fixed |
| T6 | content | Read-only description | Editable Spec, and "Your words" | Kept: spec §13 |
| T7 | layout | Lineup pills on one line: "Planner ✓ Handed off" | Name above status, no symbol | Fixed; "replaced ×N" kept |
| T8 | content | Timeline times as HH:MM; "Created by you"; "Started with the web-app lineup"; "Planner handed off to the Implementer" | Locale date and time; "Run started"; "Handed off" | Fixed. Only the first run of a ticket run says it started the lineup. The phase after "·" is not shown: the strip does not know a role's phase |
| T10 | content | Tool rows name their target: "Read tests/fixtures/cart.ts" | The tool name and the result summary ("42 lines") | Fixed: the file, pattern or command from the tool's input is shown between the name and the summary |
| T9 | styling | The user's messages as dark bubbles on the right | Light bubble | Kept: styling only |

## Orchestrator panel (Board and Decision artboards)

| # | Area | Wireframe | App before | Action |
|---|------|-----------|------------|--------|
| O1 | content | Subtitle "All workspaces · focused on web-app"; › to collapse | No subtitle; » | Fixed |
| O2 | missing | "Fleet: 3 working · 2 need you · 0 idle" | Not built | Fixed (definition above) |
| O3 | wording | Visible label "Message the orchestrator"; placeholder "Ask for status, create tickets, start or stop agents" | Placeholder "Message the orchestrator" | Fixed: `Composer` takes a `label` and a `sendLabel` |
| O4 | wording | Small "PROPOSED ACTION" heading on a proposal | None | Fixed. Create-tickets reads "Proposed action · create 2 tickets in web-app → Backlog" |
| O5 | layout | Decision card: orange border, "◆ <ticket> · <workspace>", "Open ticket for full context" | Tinted card, a link "#3 title · Role" | Fixed. The asking role stays on a dimmed line under the header |
| O6 | missing | Panel says what happened after an answer | Card just disappeared | Fixed: "✓ Answered: <option>. <title> is back in <phase>." (last three, this session) |
| O7 | missing | — | Reject on every proposal; Later… on decisions | Kept: later tickets |

## Orchestrator starts an agent — `orchestrator-starts-*.png` · `Orchestrator starts an agent@1x.png`

| # | Area | Wireframe | App before | Action |
|---|------|-----------|------------|--------|
| S1 | content | "web-app lineup: Planner → Implementer → Reviewer" | List of roles with model and effort | Fixed. Model and effort moved into the Override form |
| S2 | layout | Override: "Lineup for this ticket (from web-app)", numbered ticks, "Untick a role to skip it for this ticket only.", collapsed "Models and effort per role", "Extra instructions for this agent" (placeholder "Optional"), Cancel and Start | Ticks without numbers, selects always open, "Confirm with changes" | Fixed. One shared form (`StartOverrideForm`) serves this and "Adjust before starting". The last ticked role cannot be unticked (so "Start disabled with no role ticked" no longer happens) |
| S3 | content | Receipt "✓ <title> is in <phase> · <Role> working" and "Open ticket" | "Started #1 with …" | Fixed, from the live board |
| S4 | state | The new card in In progress with the recently-changed outline | Outline only for changes the person did not make | Kept: confirming is the person's own change, by design |

## A decision shown in three places — `decision-*.png` · `A decision, shown in three places@1x.png`

| # | Area | Wireframe | App before | Action |
|---|------|-----------|------------|--------|
| D3 | layout | Thread card: orange border, "◆ Planner is waiting on you", full-width Answer | Tinted fill, no header | Fixed |
| D4 | wording | "Note to agent (optional)", placeholder "Anything it should know" | "Note (optional)" | Fixed (all three places share the form) |
| D5 | content | One-click option buttons | Radio options, a note, Answer, Later… | Kept: M4 |

## Replacing a stuck agent — `replace-*.png` · `Replacing a stuck agent@1x.png`

| # | Area | Wireframe | App before | Action |
|---|------|-----------|------------|--------|
| R1 | wording | "Replace the Implementer on <title>"; evidence as bullets; "The new Implementer gets the plan, decisions so far, and a handoff of what was tried. The Planner's work is kept." | "…#3 title"; monospace lines; text about a "worktree" | Fixed (no jargon, §11) |
| R2 | layout | Keep current, Override, then a full-width dark "Replace Implementer" | Confirm first | Fixed |
| R3 | layout | "Implementer replaced · View previous run" in the divider line; handoff block open | Link under the divider; block collapsed | Fixed |
| R4 | content | Timeline: "Implementer replaced: <headline>", "Suggested by orchestrator, confirmed by you", "View previous run", "New Implementer started from the plan" | "Replaced Implementer (…)" plus a summary | Fixed. The summary is in the thread's handoff block, not repeated |

## Creating a ticket — `creating-a-ticket-*.png` · `Creating a ticket@1x.png`

| # | Area | Wireframe | App before | Action |
|---|------|-----------|------------|--------|
| N1 | layout | Title "New ticket" with a workspace badge | Title only | Fixed in part: the badge sits at the top of the form, so the dialog's name stays "New ticket" |
| N2 | missing | Labels field | Labels always empty | Fixed (comma separated) |
| N3 | layout | Column as a select | "Put it in Ready" checkbox | Fixed (Backlog / Ready) |
| N4 | wording | Placeholders "What needs doing", "Context the agent will need", "How you'll know it's done"; button "Create ticket" | Plain fields; "Create" | Fixed |
| N5 | missing | "Ask the orchestrator to start an agent once it's in Ready" (spec §13) | Not built | Fixed: created in Ready, the start is proposed at once; created in Backlog, a flag (migration 0023, with the usual pre-migration backup) makes the engine propose it when the ticket reaches Ready, once |
| N6 | layout | Drafted tickets: a tick, title and Edit per row, "N acceptance criteria · labels: …", "Create 2 tickets", "Put in Ready instead" | Drafts listed; Confirm, Override, Reject | Fixed: the card opens editable; Edit opens one draft's fields; Reject kept |
| N7 | content | "depends on CSV export" | — | Left out (D2): not in v1 |
| N8 | content | — | Kind and "In your words" | Kept: spec §13 |

## Empty states — `empty-workspace.png`, `empty-ticket.png` · `Empty states@1x.png`

| # | Area | Wireframe | App before | Action |
|---|------|-----------|------------|--------|
| E1 | layout | Six faint dashed columns, named, side by side above the message | Message only | Fixed: named columns share the width with no sideways scrolling, the message sits below them (checked in the artboard e2e) |
| E2 | wording | "No tickets in web-app yet"; "Write one yourself, or have the orchestrator read the repo and draft a starter set for you to review."; both buttons | "No tickets yet"; shorter text | Fixed |
| E3 | state | "Nobody is working on this yet", Start, Adjust before starting, note about past runs | Empty thread | Fixed. Start and Adjust sit in this panel instead of the controls row while it shows. The panel scrolls inside its own region, so the composer stays on screen (checked in the artboard e2e) |
| E4 | wording | Composer "First message (starts the lineup)", placeholder "Optional instructions for the lineup", button "Send and start" | Same label; button "Send" | Fixed |

## Workspace agent lineup — `workspace-lineup.png` · `Workspace agent lineup@1x.png`

| # | Area | Wireframe | App before | Action |
|---|------|-----------|------------|--------|
| L1 | layout | Roles left, open role's form right | Stacked in a narrow drawer | Fixed (D1): drawer widened (xl), two columns, form in a card titled with the role |
| L2 | content | Row: "N. Name", a description line, "Editing" on the open row | Name and phase | Fixed. There is no description field: the line is the first sentence of the instructions, plus "· ticket shows <Phase>" |
| L3 | layout | "+ Add role" dashed and full width | Small button | Fixed |
| L4 | missing | "AFTER THE LAST ROLE" card | Not shown | Fixed (Investigate says the report is saved) |
| L5 | wording | "Role name", "Ticket phase while this role works" | "Name", "Phase while active" | Fixed |
| L6 | layout | "If it finds problems" as one select ("Hand back to <role>" / "Ask me") | Radio plus a second select | Fixed; the previous role stays the default |
| L7 | layout | Collapsed "Model and effort (default: orchestrator decides)" | Always open | Fixed |
| L8 | missing | "Remove role" in the form | Only × on the row | Fixed; the row's × and the keyboard move buttons stay (#48) |
| L9 | layout | A full page with "web-app · Workspace settings" | Drawer with General, Pull requests, Always allowed, Connect agents | Kept (D1) |
