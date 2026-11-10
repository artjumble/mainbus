> **Investigation #107:** Investigate: a memory system for Mainbus (context rotation plus a curated knowledge base), starting from existing solutions (firstmate, Claude Code's memory, MCP memory servers and others)
> **Date:** 2026-11-09 · **Status:** report, recommends but doesn't authorise changes
> **The question (the user's words):** How do you (the orchestrator) handle context? Will your context just fill and auto compact at some point, or is there a process in place that keeps context below a limit?
> 
> I want to think bigger. I feel there there are two potential knowlege sources and they should work together. First is the context, but second would be a knowlege base. A place where learnings could be kept, so a memory system. Does that seem like a good idea, or is that too much?
> 
> I agree with an investigation. It should start by looking for existing solutions that can be leveraged. firstmate may have something, or there are many memory solutions that exist already.

# A memory system for Mainbus: context rotation plus a curated knowledge base

**Ticket #107 (Investigate).** No code was changed. This report recommends and does not authorise.

## The question (the user's words)

1. "How do you (the orchestrator) handle context? Will your context just fill and auto compact at some point, or is there a process in place that keeps context below a limit?"
2. "I want to think bigger. I feel there are two potential knowledge sources and they should work together. First is the context, but second would be a knowledge base. A place where learnings could be kept, so a memory system. Does that seem like a good idea, or is that too much?"
3. "I agree with an investigation. It should start by looking for existing solutions that can be leveraged. firstmate may have something, or there are many memory solutions that exist already."

The spec asks for a survey, a recommendation, a design and a phased ticket plan.

## Short answer

1. **It is a good idea, and it is not too much, provided the knowledge base is small, plain files, and every entry is confirmed by the user.** The need is real on this board: the same facts were relearned repeatedly (see "Evidence from this board").
2. **Reuse the pattern, not a product.** firstmate's `/stow` is the closest fit: routing by destination, three decay tiers, archive rather than delete, "propose, the user approves". Claude Code's own CLAUDE.md and auto-memory give the loading mechanics for free. **No surveyed memory service passes Mainbus's constraints** (local, no API key, Windows, trust model). Most need an embeddings model or an LLM key, a graph database, or a separate agent runtime. The two that run locally without keys (the reference MCP knowledge-graph server and basic-memory) add a second store and a tool surface that agents could write to, and give nothing that a folder of markdown and a short index do not.
3. **Build a small thing on three layers:**
   - **Layer A, working memory:** *context rotation.* The engine measures the orchestrator's context, and at a threshold starts a new session seeded with an engine-built digest. Claude Code's auto-compaction stays as a fallback.
   - **Layer B, Mainbus-wide knowledge:** a `knowledge/` folder of markdown in Mainbus's data home (preferences, orchestrator notes). It has a short always-loaded index and topic files fetched on demand, and a UI to see and edit all of it.
   - **Layer C, workspace knowledge:** the repo's own `CLAUDE.md` and `docs/`, versioned and reviewed. Mainbus only *proposes* changes to them, as normal tickets or PRs.
4. **Nothing is written to memory without a user confirmation** in v1. Agents, the web and the orchestrator can only *suggest*. This answers the question the spec flags for the user (memory written without confirmation). I recommend "never", and I did not ask, because the user's own words already set the bar ("every memory confirmed", from the filing agent's phase 3; confirm in review if the user wants any auto-save).
5. **Today's answer to question 1:** the orchestrator is one long-lived Claude Code session resumed by id. Nothing keeps it below a limit. Claude Code's auto-compaction decides what survives. The only fresh start is after a failed resume, seeded with the last 20 messages (`src/engine/orchestrator/session.ts:393-400`, `src/engine/runner/digest.ts`). Design §11's "new orchestrator session seeded with a state digest" was never built.

## What I looked at

- **Mainbus code:**
  - `src/engine/orchestrator/session.ts`, `src/engine/runner/digest.ts`, `src/engine/store/orchestrator.ts`;
  - `src/engine/runtime/sdkRuntime.ts` (role options at ~485-535, orchestrator options at ~850-890);
  - `src/shared/events.ts` (the per-turn `usage` event);
  - the design document §11 and Appendices B and C.
- **Installed SDK:** `@anthropic-ai/claude-agent-sdk` **0.3.314**, `sdk.d.ts` (`settingSources`, `autoMemoryEnabled`, `autoMemoryDirectory`, `getContextUsage`, compaction hooks and messages, `SDKMemoryRecallMessage`, `SessionStore`, `forkSession`).
- **firstmate**, read from its repository (`skills/stow/SKILL.md`, `AGENTS.md`, `docs/architecture.md`, `docs/configuration.md`, `.agents/skills/bearings/SKILL.md`). Part of the 124 KB architecture page and of the 370 KB configuration page was truncated by the reader; I read the first 100,000 characters of each. I did not read the `/ahoy` skill file or the `startup-memory-budget` and `stow-guard` settings pages, so budgets below are from `SKILL.md` and `AGENTS.md` only.
- **Claude Code's memory page** (code.claude.com/docs/en/memory) and **the Anthropic API memory tool page**.
- **READMEs** of `@modelcontextprotocol/server-memory`, basic-memory, mem0, Graphiti, Cognee, and the Letta and LangMem docs. Letta's and LangMem's pages did not state their requirements, and I did not look further, so those rows say "not confirmed". Web search results, which I used only to find these, were vendor blogs and I did not rely on them for any fact in the table.

Caveats: I ran no live spike. Three items need a quick test before building (listed under "Open items").

## 1. The survey

### firstmate (the design's main reference)

- **What it keeps, and where:**
  - `data/captain.md`: the user's preferences for that home;
  - `data/captain-shared.md`: preferences shared across sub-homes;
  - `data/learnings.md`: "curated, home-local operational knowledge";
  - `data/<id>/report.md`: investigation findings;
  - the project's committed `AGENTS.md`: project-wide knowledge, which **only deliberate human edits extend**. firstmate never writes it; workers may fix wrong text in it but may not add knowledge.
  - `state/` is separate runtime state. A status line is "a wake event, not current state".
- **Restart and compaction survival:** all state is on disk, and a session-start script (`fm-session-start.sh`) prints one bounded digest which the model reads once. Durable records are authoritative over "conversation memory". There is no compaction logic; it simply does not depend on the conversation. Mainbus already has this (the database, `currentState`, wake digests), but not for the orchestrator's *own* learnings.
- **`/stow`** (the standalone skill, `skills/stow`):
  - sweeps a session for durable knowledge (preferences, project facts, gotchas, decisions, next steps);
  - routes: (1) an explicit instruction, (2) an existing local convention (`CLAUDE.md` or `AGENTS.md` for project facts, a `TODO` or `NOTES` file for next steps, a user-level memory file for preferences), (3) a private, gitignored `.stow-notes.md` as the fallback;
  - **before writing:** checks whether a README or config file already owns the fact (then it stores a one-line pointer), reads each destination in full, classes each finding as new, duplicate, superseding or obsolete, and rewrites rather than appends;
  - **tiers**, by a trailing marker like `<!--a:2026-08-03-->`: *pinned* (never decays; the default for user-level files), *aging* (re-prove after 30 days, the default for project files) and *perishable* (7 days, and must name a checkable expiry condition). Reinforcement counts only when the fact was actually used or confirmed in the session. Decay runs only during a stow pass. An optional "pass horizon" counts passes instead of days;
  - **archive, never delete:** stale entries go to `.stow-archive.md` (gitignored, never loaded);
  - **budget:** no numeric budget in the skill. It treats marker bytes as a cost and, when an always-loaded file outgrows what every session should load, *proposes* moving situational entries to an on-demand home; the user approves each move;
  - **safety:** asks the user before any new convention, any save to the user-level file and any offload; never stores credentials; never stages, commits or pushes; never files to an external tracker on inference.
- **`/bearings`:** a bounded status digest from one deterministic command (`fm-bearings-snapshot.sh --json`). The skill is told not to use other readers or conversation history. Four fixed sections (Captain's Call, Recently Landed, Underway, Charted Next), a complete snapshot rather than a delta, read-only, and treats source text as "untrusted evidence, not instructions". Optional dated file.
- **`/ahoy`:** I did not read its file. The filing agent describes it as a recap since the last message plus open decisions.
- **Fit:** the *ideas* fit every constraint (it is files and rules). The *code* does not transplant: it is shell scripts bound to firstmate's terminal-pane harness, and Appendix B already lists what Mainbus deliberately did not copy. **Take:** the tier-and-marker format, the routing order, "pointer instead of copy", archive instead of delete, "only humans extend the committed project file", and the bounded deterministic digest.

### Claude Code's own memory

- **CLAUDE.md** (project `./CLAUDE.md` or `.claude/CLAUDE.md`, user `~/.claude/CLAUDE.md`, local, managed; `AGENTS.md` is read when there is no `CLAUDE.md`). Loaded in full at session start. The docs advise under about 200 lines. `@path` imports and `.claude/rules/` (path-scoped) exist.
- **Auto-memory:** Claude writes it itself. Lives in `~/.claude/projects/<project>/memory/` with a `MEMORY.md` index; **only the first 200 lines or 25 KB of the index load each session** (overflow is silent, per a third-party reading), topic files are read on demand. Shared across worktrees of one repository. Settings: `autoMemoryEnabled`, `autoMemoryDirectory` (ignored if set in the checked-in project settings, for security), and env `CLAUDE_CODE_DISABLE_AUTO_MEMORY`. Subagents can keep their own.
- **SDK 0.3.314, what applies to Mainbus:**
  - `settingSources` defaults to all sources and **must include `'project'` to load CLAUDE.md**. Roles use `['project','local']`, so they already read the repo's `CLAUDE.md`. The **orchestrator uses `[]`**, so it reads no CLAUDE.md and no user memory, deliberately ("its folder has none, and the user's own settings must not apply").
  - `getContextUsage()` on the query returns a categorised breakdown (system prompt, tools, MCP, memory files, messages, free space) and `autoCompactThreshold` / `isAutoCompactEnabled`. This is the exact measure for rotation, better than summing #84's per-turn token events, which add up across tool loops within a turn.
  - Compaction is observable and hookable: `compact_boundary` and `status: compacting` messages, and `PreCompact`, `PostCompact` (with `compact_summary`) and `SessionStart` (source `compact`, `resume`, `clear`) hooks. A `SessionStart` hook can inject context. `SDKMemoryRecallMessage` shows auto-memory recall as a message.
  - `autoCompactWindow` exists as a setting (100,000 to 1,000,000 tokens), so the window can be *lowered* to rotate earlier.
  - `forkSession`, `resume` and a pluggable `SessionStore` exist; not needed here.
  - The `memory` option (`'user' | 'project' | 'local'`) on custom agent definitions loads an agent-memory folder; Mainbus does not define subagents, and the orchestrator disallows them.
- **The API memory tool** (`memory_20250818`, client-side `/memories` directory, view/create/str_replace/insert/delete/rename). It is a Messages API tool: the application sends the request with an API key and runs the file handler. **It does not apply here**: Mainbus must never call the API directly (anti-goal). Its guidance is still useful: validate every path against traversal, cap file sizes, expire old files, and pair memory with compaction.
- **Fit:** CLAUDE.md fits fully and is already used for roles. Auto-memory fits only partly: it is written by the model without confirmation, which breaks "confirmed by the user", and it is per-checkout, not per-board. The orchestrator's harness expects the auto-memory folder, but Mainbus's read-only rules block writes to it. That is the right outcome for now; see Open items for whether it is even loaded.

### MCP memory servers (local)

| Server | Stores | Retrieval | Writes | Needs |
|---|---|---|---|---|
| `@modelcontextprotocol/server-memory` (reference, MIT) | One JSONL file: entities with observations, directed relations | `search_nodes` substring over names, types and observations; `read_graph`; `open_nodes` | The model, through create/add/delete tools; no review step | Node 24+; set `MEMORY_FILE_PATH` (the default sits inside the package folder and can be wiped on update); lock file |
| basic-memory (AGPL-3.0) | Markdown notes (entities, `- [category] fact` observations, `[[wikilinks]]`) plus a local SQLite index (the files are the source of truth) | Hybrid full-text and vector search, FastEmbed embeddings (local model download) | The model through `bm_write` and `bm_edit`; humans can edit the files | Python 3.12+ and `uv`; install needs `--prerelease=allow`; the README does not mention Windows; AGPL |

Both run locally with no key. Both add a second store, an MCP tool surface agents could write to, and a runtime (Node 24+ or Python 3.12 plus `uv`) that Mainbus would have to ship or require. Retrieval is only worth that once the notes number in the thousands. Mainbus would have tens to low hundreds. Both could be **added later** as an optional retrieval layer over the same markdown folder (basic-memory's file format is plain markdown, which is compatible), but they are not needed now.

### Memory libraries and services

| Project | Stores / retrieves | Writes | Needs | Verdict for Mainbus |
|---|---|---|---|---|
| mem0 (OSS, Apache-2.0) | Extracted memories with vector search; optional BM25 and entity extraction | Automatic LLM extraction on `add()`; the April 2026 algorithm is add-only (no documented update or delete in the OSS README) | Defaults to OpenAI `gpt-5-mini` and `text-embedding-3-small`, so a key and an embedding service; the README lists advanced features as platform-only | No: needs keys and its own LLM calls, auto-writes unreviewed, no retire |
| Graphiti (Zep's engine) | Temporal knowledge graph | Episodes added through its API | Neo4j or FalkorDB (Kuzu deprecated) plus an LLM; defaults to OpenAI; the reference MCP and REST servers have no authentication; telemetry on by default (opt out) | No: heavy, graph database, LLM calls |
| Letta (MemGPT) | In-context memory blocks plus archival memory | The agent edits its own memory | An agent server with its own database and model keys; it provides its own harness ("letta-code") | No: replaces the runtime instead of plugging into it. Requirements not confirmed from its pages |
| Cognee (Apache-2.0 badge; licence text not shown on the page) | Graph plus vector pipeline (`remember`, `recall`, `improve`, `forget`) | Pipeline-driven | Runs locally without a key using a local entity model and a downloaded embedding model; Python 3.10-3.14; Docker for its MCP UI | Possible locally, but a Python pipeline for a few hundred notes |
| LangMem (MIT per the filing; not on the page I read) | LangGraph store; background memory manager | Automatic extraction by an LLM | An LLM key (example uses Anthropic with a key) and an embedding model (example uses OpenAI); built around LangGraph's store | No: needs the API directly and LangGraph |

None of these has a user-confirmation step, and every one that extracts automatically feeds model-written text into memory, which is the back door the trust model forbids.

### Comparison with Mainbus's constraints

| Option | Local only | Subscription only, no API key | Windows | Trust model (agent text is data) | Effort | Fit |
|---|---|---|---|---|---|---|
| firstmate's pattern (files, tiers, stow rules) | Yes | Yes (rules only) | Yes (markdown) | Yes: asks the user before saving | Low-medium (own it) | **Adopt the pattern** |
| CLAUDE.md in repos | Yes | Yes | Yes | Yes if only humans or reviewed PRs edit | Very low (exists, #70) | **Use** for workspace knowledge |
| Claude Code auto-memory | Yes | Yes | Yes | No: the model writes unreviewed | Low | Do not enable for roles; revisit for the orchestrator |
| API memory tool | Handler local | **No** (API call) | Yes | n/a | n/a | Reject |
| `server-memory` (MCP) | Yes | Yes | Yes (Node) | Weak: the model writes with no review | Low | Not now |
| basic-memory | Yes | Yes | Not stated | Weak: same | Medium (Python runtime, AGPL) | Optional later retrieval |
| mem0 / Graphiti / LangMem | Mostly | **No** by default | Varies | No: automatic extraction | High | Reject |
| Letta | Self-hostable | Needs model keys; own harness | Unconfirmed | No | Very high | Reject |
| Cognee | Yes (local models) | Possible | Unconfirmed | No | High | Reject |
| **New small build** (markdown files, index, UI, proposals) | Yes | Yes | Yes | **Yes: by design** | Medium, phased | **Recommended** |

## 2. Recommendation

**Adapt firstmate's design and build it small on Mainbus's own pieces (files + the existing proposal-card flow). Do not adopt a memory library or server.** Reasons:

- Everything the user wants kept is *short, human-readable, human-confirmed prose* (preferences, repo facts, decisions). That is what the three-tier file approach handles and retrieval services are for much larger, machine-extracted stores.
- The constraints exclude most of the field outright (keys, hosted parts, graph databases, a second agent runtime).
- The confirmation requirement is the opposite of what these tools do (automatic extraction).
- Mainbus already has the confirm machinery: propose tools, Confirm/Override cards, receipts, and a wake queue.
- Plain files are readable by the user, by every agent, and by the user's own Claude Code, and they are rebuildable and diffable.

**Keep the door open:** if the knowledge ever outgrows an index plus topic files, point basic-memory (or similar) at the same folder as a search layer. Nothing in the design below prevents that.

## 3. Design

### 3.1 What lives where

| Layer | Where | Holds | Written by | Read by |
|---|---|---|---|---|
| A. Working memory | The orchestrator's session (and each role's) | The conversation | Everyone | The same session |
| B. Mainbus knowledge | `<MAINBUS_HOME>\knowledge\` (markdown, outside any repo, never public) | `user.md` (standing preferences), `orchestrator.md` (how to work on this board), `workspaces/<slug>.md` (cross-ticket notes that should not be in the repo), an `index.md` | The user (UI), or a confirmed proposal | The orchestrator (index always, topics on demand); roles get only what is relevant, as data |
| C. Workspace knowledge | The repo: `CLAUDE.md`, `docs/` (#70 added the first `CLAUDE.md`) | Commands, package manager, test rules, toolchain quirks, known flaky tests | A normal ticket and PR, reviewed | Roles (they already load `CLAUDE.md` via `settingSources: ['project','local']`), the user's own Claude Code |
| D. Database | `memory_proposal` rows, an audit table of knowledge changes, the rotation digest per run | Proposals, their status, source and date, receipts | The engine | The UI |

- **Public repos:** anything proposed for layer C is written into a PR and is public if the repo is. The proposal card must say so, and the engine must refuse to propose content that matches a secret or credential pattern (reuse the existing `credentials.ts` checks). Preferences and anything private go to layer B only. A workspace flag "repo is public" (or a check of `gh repo view --json visibility` at proposal time) selects the warning.
- **Not in the database:** the knowledge itself. A file is the source of truth, so the user and any tool can read and edit it, and a bad database state cannot lose it. The database holds only the audit trail and pending proposals.

### 3.2 Entry format (adapted from `/stow`)

One bullet per fact, one line, with a trailing HTML comment:

```
- Use ticket numbers when referring to tickets. <!--m: tier=pinned scope=user src=user:2026-11-08 used=2026-11-09-->
- This repo uses pnpm; never npm or npx. <!--m: tier=aging scope=ws:mainbus src=run:#62:2026-11-02 used=2026-11-09-->
```

- `tier`: **pinned** (user preferences; never decays), **aging** (facts to re-prove; 30 days unused → review), **perishable** (must carry an expiry condition; 7 days).
- `src`: who proposed it and where it came from (`user`, `orchestrator`, `run:#N`, `problem:#N`), plus the confirmation date. `used` is bumped only when a role or the orchestrator reports it actually applied the entry, not when it was merely loaded (firstmate's reinforcement rule).
- `scope`: `user`, `mainbus`, or `ws:<slug>`.
- A fact already owned elsewhere (README, config) is stored as a one-line pointer, not a copy.

### 3.3 Proposing, confirming, correcting, retiring

- **Who may propose:**
  - The user: types "remember that …" in the orchestrator panel, or edits the Knowledge screen directly (a direct edit is its own confirmation).
  - The orchestrator: a new `propose_remember` tool (same family as the existing propose tools).
  - Agents: a "worth knowing" field on the handoff, which the engine turns into a *suggestion* (not a proposal) shown on the ticket's Review card with **Save to…** / **Dismiss**.
  - Recurrence: when the same stuck-detector or failure cause appears on two or more tickets in a workspace, the engine raises a suggestion, with the evidence, to add it to the repo's `CLAUDE.md`.
- **Confirming:** every proposal is a card with the exact text, the scope, the destination and a plain public/private warning. Confirm writes it and collapses the card to a receipt with **Undo** (undo restores the previous file text from the audit table). Override edits the wording, tier and destination first.
- **Routing (from `/stow`):** user preference → layer B `user.md`; how-to-work-on-this-board → `orchestrator.md`; a repo fact → layer C (a ticket whose spec is the exact edit; the repo's own review flow applies); a private workspace note → `workspaces/<slug>.md`. A fact with an authoritative owner becomes a pointer.
- **Correcting:** a proposal that supersedes an entry shows the old line next to the new one (stow's new / duplicate / superseding / obsolete classification, done by the engine's string and scope match, with a model-written suggestion only to *propose* the merge).
- **Aging and retiring:** a weekly engine job lists entries past their tier's age and posts one **Knowledge review** card (keep, edit, retire). Retiring moves the line to `knowledge/archive.md` (not loaded, searchable, restorable) rather than deleting. Layer C retirements are tickets like any other edit. Nothing decays silently.
- **UI:** a **Knowledge** screen shows all layer B files with their entries, tier, source, last-used and scope, with edit and retire; it also lists pending proposals and links to each workspace's `CLAUDE.md`.

### 3.4 Reading

- **Always loaded (budgeted):** `index.md` plus all *pinned* entries, hard-capped (suggest 4 KB, about 40 lines). The engine builds the orchestrator's system-prompt block from them, framed as the user's confirmed standing instructions. Over the cap, the engine refuses to add and posts a review card to move something to a topic file (stow's "offload", with approval).
- **On demand:** the orchestrator can read topic files with its existing Read tool (the knowledge folder becomes one more read-only directory, like the workspaces' repos in §11), and gets one new read tool, `recall(query, scope)`, a plain keyword scan over the markdown, no embeddings.
- **Roles:** a role gets (a) the repo's `CLAUDE.md` as today; (b) a short "Workspace notes" block built by the engine from `workspaces/<slug>.md` aging entries and pinned `user` entries marked `applies=roles`, appended to the role prompt in the existing "data" framing (`roles/prompt.ts`). The user's confirmed words are labelled as the user's; text from a run is labelled as data.
- **Across workspaces:** the orchestrator sees the `index.md` of every workspace file, so it can find the right topic and read it.
- **Auto-memory:** keep it off for roles. For the orchestrator, do not rely on it; the `knowledge/` folder replaces it with a confirmed equivalent. Disable it explicitly (`autoMemoryEnabled: false`) so it cannot fill unreviewed.

### 3.5 Context rotation (design §11's unbuilt feature)

- **Measure:** call `getContextUsage()` on the orchestrator's query at the end of each turn and store the total (and `autoCompactThreshold`). Do not sum the per-turn `usage` events: they total across the tool loops within a turn and over-count. #84's usage events stay for cost display.
- **When to rotate:** at a quiet point only (the turn has ended, no tool call open, no pending wake mid-batch) and when context passes about **60% of the auto-compact threshold** or a fixed ceiling, whichever is first. Rotating earlier than compaction means the engine, not Claude's summariser, chooses what survives.
- **The digest (engine-built, deterministic, bounded to a size cap):**
  1. the always-loaded knowledge block (same as a fresh session gets anyway);
  2. board state per workspace from `currentState`: tickets by column, who is working, what is in Needs you;
  3. open and deferred decisions and pending proposals, with their ids (bearings' "always re-show open decisions");
  4. unacknowledged wakes (they are re-sent anyway);
  5. the last N user messages and the orchestrator's replies verbatim (N about 10; images by name and path, as the existing digest does);
  6. a short "recently decided" list from `memory_proposal` receipts and answered decisions in the last few days.
  Model-written summarising is optional; the first version should need none.
- **After rotation:** a new `orchestrator_run` row (the existing table) with `end(runId, 'rotated')`, the digest as the first user turn, and a small note in the panel ("Started a fresh conversation to keep things quick"). The old thread stays viewable. Add the reason `'rotated'` next to `'resume_failed'`.
- **Auto-compaction:** keep it on as a safety net but expect it to fire rarely. Log `compact_boundary` events so any firing shows up as a defect to tune the threshold. Turning it off is not recommended: a single huge turn could hit the hard limit.
- **Roles:** leave alone. Their sessions are bounded by one ticket's phase and already start from a handoff. Their own long runs rely on auto-compaction, with the stuck detector and "Same obstacle twice" rule as is. Revisit only if a role's run shows `compact_boundary` often.

### 3.6 Safety: memory must not become a back door

- **Only confirmed text enters memory.** Agent, web and orchestrator text can only create a *suggestion* or *proposal*. The engine writes the file after the user confirms, with the exact text the card showed.
- **Provenance travels with the entry** (`src`). Entries the user wrote or edited are the user's words; entries from runs stay labelled as data even after confirmation unless the user edits them (editing re-labels them as the user's). Role prompts frame the two differently.
- **No instruction smuggling:** an entry cannot grant permissions or change a rule. Memory text never feeds the permission guard, the allow lists or the `always_allow` store. The guard stays code, not text.
- **No secrets:** run proposals through the existing credential checks, reject high-entropy strings and token patterns, and show a warning; never store file contents from `.env`-like paths.
- **Paths:** the knowledge folder is written only by the engine, never by agents' tools (roles cannot write to it; the orchestrator has no write tool). Validate every path as the API memory tool page advises (canonical path inside the folder).
- **Size and rate caps:** per-file and total byte caps, and a cap on pending suggestions per run, so a looping agent cannot flood the user with cards.
- **Public repos:** see 3.1.
- **Workspace `CLAUDE.md` from an untrusted repo:** already true today for roles; unchanged.

### 3.7 Evidence from this board

I could not read the orchestrator thread from this worktree (my view of the data home is sandboxed), so the preferences and rediscoveries below come from the ticket's own text (the filing agent's list) and from repo history; the rest I checked. I did not mine the database.

| Case | What happened | Where it would live | How it would be used |
|---|---|---|---|
| "Use ticket numbers" (user preference) | Given in the orchestrator thread; lost on resume or compaction | Layer B `user.md`, pinned, `scope=user` | In the always-loaded block, so every fresh session has it |
| "Unattended mode is always on" (user preference) | Same | Layer B `user.md`, pinned | Same. (The mode itself is also a stored setting; the note tells the orchestrator not to ask) |
| pnpm only, never npm/npx | Rediscovered by agents; now in the repo | **Layer C** `CLAUDE.md` (already there from #70) | Roles load it automatically. Value of the system: the *proposal* path would have raised it after the second rediscovery |
| Known-flaky tests | Was a "known-flaky" note in `CLAUDE.md`, removed when #103 fixed them (commit `707e97a`) | Layer C, **perishable** with expiry "until #103 lands" | Shows how a perishable tier removes the line when its condition is met, instead of by hand |
| LineupSettings test failure, include-path quirks, long Windows paths, `upload_speed` | Repeated rediscoveries | Layer C if repo-wide (toolchain quirks); layer B `workspaces/<slug>.md` if about the user's machine (long paths) | A recurrence suggestion after two tickets hit the same cause; roles read the repo notes; machine-specific notes arrive in the "Workspace notes" block |
| Handoff "worth its own ticket" notes | Lost between runs | A suggestion on the Review card: **Create ticket** (existing flow) or **Dismiss**; not memory at all | These are work, not knowledge; the engine should route them to tickets, which is a quick win |
| Agents' "worth knowing" notes | Survive only inside one run's log | Suggestion to Layer C or layer B, by routing | Confirmed by the user, then loaded for the next run |

## 4. Phased ticket plan

**Phase 1: rotation and orchestrator notes** (value: the user's direct question)
1. *Spike:* does `getContextUsage()` work on a streaming-input query with a subscription login; does the orchestrator (`settingSources: []`) load the auto-memory folder, and does `autoMemoryEnabled: false` stop that; does `SessionStart` with `source: 'compact'` fire. (small)
2. *Measure and show:* store context size per orchestrator turn; show it in the panel (a small meter, hidden by default). (small)
3. *Rotation:* the engine-built digest, the `rotated` end reason, a quiet-point trigger, tests with the fake runtime. (medium)
4. *Orchestrator knowledge folder:* `knowledge/` with `user.md`, `orchestrator.md` and `index.md`; the always-loaded block with its cap; `propose_remember`; the card, receipt and Undo; the audit table. (medium)
5. *Knowledge screen:* view, edit, retire, pending proposals. (medium)

**Phase 2: workspace knowledge**
6. *Roles read workspace notes:* the "Workspace notes" block; `workspaces/<slug>.md`. (small-medium)
7. *Handoff suggestions:* a "worth knowing" field on the handoff; Review-card **Save to…**, **Create ticket**, **Dismiss**. Includes making "worth its own ticket" a real action. (medium)
8. *Repo proposals:* a confirmed repo-fact suggestion becomes a ticket whose spec is the exact `CLAUDE.md` edit; public-repo warning and credential check. (medium)

**Phase 3: learning from runs**
9. *Recurrence suggestions* from stuck-detector hits and failures across tickets. (medium)
10. *Aging:* the tier markers, the weekly **Knowledge review** card, `archive.md`. (medium)
11. *Optional retrieval layer* only if the folder outgrows scanning: evaluate basic-memory over the same folder. (decide later)

## 5. Design document changes

- **§11 Orchestrator:** replace the sentence "When its context gets large, the engine starts a new orchestrator session seeded with a state digest" with the measured-trigger rotation above, and add a "Knowledge" bullet (the always-loaded block, `propose_remember`, `recall`).
- **§6 Data model:** add `memory_proposal` and the knowledge audit table; mention the rotation reason on `orchestrator_run`.
- **§9 / §10:** handoff "worth knowing" suggestions and the Review-card actions; knowledge proposals as one more decision type in the "three places" rule.
- **§13 Screens:** a Knowledge screen.
- **Appendix B:** add `/stow` tiering, routing and archive, "only humans extend the committed project file" and `/bearings`' bounded deterministic digest to "Borrowed"; add "firstmate's `.stow-notes.md` private fallback" and "model-written memory" to "Not copied".
- **Appendix C:** one row per shipped ticket, as usual; the spec stays as written.

## 6. Open items

- **Spikes** in ticket 1 above settle three things I did not run: whether `getContextUsage()` is available on the orchestrator's query, whether the orchestrator loads auto-memory despite `settingSources: []`, and whether `SessionStart` can seed context after a compaction.
- **For the user to decide at review:** (a) confirm "never written without confirmation" as the v1 rule; (b) whether a pure *direct edit* in the Knowledge screen should count as confirmation (I assumed yes); (c) the 4 KB cap on the always-loaded block is a guess to tune.
- **Unread:** the end of firstmate's two big docs and its `/ahoy` skill; Letta's and LangMem's requirements. None of them changes the recommendation, since both are excluded for needing a key, their own runtime, or both.

## Sources

- firstmate: https://github.com/kunchenguid/firstmate (`skills/stow/SKILL.md`, `AGENTS.md`, `docs/architecture.md`, `docs/configuration.md`, `.agents/skills/bearings/SKILL.md`)
- Claude Code memory: https://code.claude.com/docs/en/memory
- Anthropic memory tool: https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool
- MCP memory server: https://github.com/modelcontextprotocol/servers/tree/main/src/memory
- basic-memory: https://github.com/basicmachines-co/basic-memory
- mem0: https://github.com/mem0ai/mem0 · Graphiti: https://github.com/getzep/graphiti · Letta: https://github.com/letta-ai/letta · Cognee: https://github.com/topoteretes/cognee · LangMem: https://langchain-ai.github.io/langmem/
