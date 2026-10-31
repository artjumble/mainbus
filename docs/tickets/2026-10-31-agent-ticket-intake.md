# Ticket: let local agents create tickets (MCP server + CLI)

Paste each section below into the matching field of the New Ticket form. Leave "Put it in Ready" unticked.

---

## Title

Let local agents create tickets through an MCP server and a CLI

---

## In your words

I want agents running on this machine (Claude Code, Codex, Copilot and the like) to be able to create tickets on my Mainbus board, so that when one of them spots work that belongs here it can file it instead of telling me to.

They should do it through an MCP server they can add once, and through a `mainbus` CLI that anything with a shell can call. Tickets they create must land in Backlog and clearly say which agent wrote them, so I decide what gets worked on and nobody mistakes an agent's words for mine. Agents can create, list and read tickets, but not edit, move, start or delete them.

---

## Spec

### Shape

One new piece in the engine: an intake endpoint on a Windows named pipe. On top of it, one small program with two modes:

- `mainbus ticket create | list | show`: the CLI.
- `mainbus mcp`: a stdio MCP server with the tools `create_ticket`, `list_tickets` and `get_ticket`.

The CLI and the MCP server never touch the database. Every request goes through the pipe to the running app, which creates the ticket through the same code as the existing `ticket.create` handler (`src/engine/index.ts`) and emits `board.changed`.

### The pipe endpoint (engine, started from `src/main/index.ts` once the engine is up)

- **Name:** `\\.\pipe\mainbus-<first 16 hex chars of sha256 of the data home root>`, from `resolveHome` in `src/engine/home.ts`, lower-cased and `path.resolve`d before hashing. Stable, dev and test homes therefore get different pipes, and an agent can never reach the real board through a dev build. Off Windows, use a unix socket in the data home with the same role (tests may run there).
- **Access:** only the current user may send requests. Windows' default pipe security gives full control to the creator, admins and SYSTEM, but read access to Everyone. Check what Node actually sets. Make sure another account can't open the pipe for writing, or tighten it if it can, and record the finding in a comment.
- **Protocol:** newline-delimited JSON. Each request is `{ "v": 1, "id", "method", "params" }` and each reply is `{ "id", "result" }` or `{ "id", "error": { "code", "message", "field"? } }`. The methods are `create`, `list` and `get`. Malformed JSON, an unknown method or an oversized line (over 1 MB) gets an error reply and the connection is closed. It must never crash or block the app.
- **Validation:** with zod (already a dependency), in the engine, not in the clients.
  - `title`: required, 1–200 chars, single line.
  - `intent`: required, 1–20,000 chars.
  - `spec`: up to 100,000 chars.
  - `criteria`: up to 50 items of 1–1,000 chars each.
  - `labels`: up to 20 items of 1–50 chars each.
  - `source.agent`: 1–100 chars.
  - `source.cwd`: up to 1,000 chars.
  - `repo`: optional.
  - Unknown fields are rejected, and errors name the field.
- **Column:** always Backlog. There is no column parameter.
- **Workspace:** with the single MVP workspace, the optional `repo` must resolve to the open workspace's path, compared case-insensitively on Windows. Otherwise the error is `workspace_mismatch`. Omitting `repo` means the open workspace. No open workspace gives `no_workspace`.
- **`list`:** for the open workspace, return number, title, column, phase/status summary, labels, source, createdAt and updatedAt. It takes an optional `column` filter.
- **`get`:** look up a ticket by number. Return title, every intent entry with its source, spec, criteria with checked state, labels, column and status summary. Never return thread events, decisions or allow rules.

### Provenance

- Add an optional `source?: { kind: 'agent'; agent: string; cwd: string }` to `IntentEntry` in `src/shared/domain.ts`. Intent is stored as JSON, so no schema migration is needed. Entries the user writes (the New Ticket form, "Add to your words") have no `source`.
- A ticket created through intake gets `source` on its first intent entry. The agent name is self-reported:
  - **MCP:** the `clientInfo.name` from the MCP initialize handshake, unless the tool call passes `agent`.
  - **CLI:** `--agent <name>`, defaulting to `cli`.
- `cwd` is the CLI or MCP process's working directory.
- **Role prompt** (`buildRolePrompt` in `src/engine/roles/prompt.ts`): the heading "The user's own words (acceptance bar; do not widen)" must only cover entries without `source`. Agent-written entries go under a separate heading that says an agent wrote them and that the name is as reported, not verified. Keep the existing `<ticket-data>` wrapping for every entry. A ticket with no user entries still gets the agent section, plus a line saying the user has not added their own words yet.
- **UI:** a badge on the ticket card (`TicketCard.tsx`) and in the ticket view's context pane, e.g. "from codex (reported)", with the folder in a tooltip. Use Mantine components only. No Tailwind, and a CSS module only if Mantine can't do it.

### The program (CLI + MCP server)

- One TypeScript entry, bundled to a single CommonJS file. It may reuse `resolveHome` but must not import anything that pulls in `node:sqlite`, Electron or React.
- **MCP:** add `@modelcontextprotocol/sdk` as a direct dependency, pinned to 1.32.2 (the version already in the tree via the agent SDK).
- **Connecting:** if the pipe isn't there, fail fast. The CLI exits with code 3 and the message "Mainbus isn't running (data home: <path>). Start it and try again." The MCP tools return the same message as a tool error. Never launch the app.
- **Mainbus's own agents:** when `MAINBUS_AGENT` is set (Mainbus sets it for its own agents) and `MAINBUS_HOME` is not, refuse with exit code 4 and a message saying so. This stops a Mainbus agent filing tickets on the board that is running it, while still letting it test against a temporary `MAINBUS_HOME`.
- **CLI commands:**
  - `mainbus ticket create --title <t> --intent <text>|--intent-file <path> [--spec-file <path>] [--criterion <text>]... [--label <l>]... [--repo <path>] [--agent <name>]`, or `mainbus ticket create --json <path>|-` taking an object with the same fields. Prefer `--json`/`--*-file` for long text. Print `#<number> <title>` on success.
  - `mainbus ticket list [--column backlog|ready|...]` and `mainbus ticket show <number>`.
  - `--json` on list and show prints machine-readable output.
- **Exit codes:**
  - 0: OK
  - 1: usage
  - 2: validation or engine error, with the message and the field
  - 3: not running
  - 4: refused under `MAINBUS_AGENT`
- **MCP tools:**
  - `create_ticket`: title, intent, spec?, criteria?, labels?, repo?, agent?
  - `list_tickets`: column?
  - `get_ticket`: number
  - Tool descriptions tell the agent that tickets land in Backlog for the user to review, and that it should call `list_tickets` first to avoid duplicates.

### Running it

- **Dev:** `npm run mainbus -- <args>` runs the bundled file with Node against the dev home (or `MAINBUS_HOME`).
- **Stable build:**
  - Ship the bundle outside the asar via `extraResources` in `electron-builder.yml`, the way `migrations` is shipped.
  - `scripts/build-stable.ps1` writes `%LOCALAPPDATA%\Mainbus\bin\mainbus.cmd`. The launcher reads `app\current.txt` and runs `app\<build>\Mainbus.exe` with `ELECTRON_RUN_AS_NODE=1` on `resources\cli\<bundle>`, so no separate Node install is needed. It stays valid across rebuilds and rollbacks.
  - **Verify first, before building the rest:**
    - interactive stdout and stderr appear in PowerShell and cmd;
    - stdio pipes work for MCP;
    - exit codes pass through.
  - If `Mainbus.exe` in Node mode can't do one of those, ask the user before falling back to requiring Node on PATH.
  - Also check that `cmd` argument quoting can't mangle arguments; this is why `--json -` exists.

### Setup help in the app

Add a "Connect agents" section to the workspace settings drawer (`RoleSettings`, opened from the board's settings icon). It shows the exact lines to copy for Claude Code, Codex and GitHub Copilot in VS Code, each with a Mantine `CopyButton`, built from the real launcher path. For example:

- Claude Code: `claude mcp add --scope user mainbus -- <launcher> mcp`
- Codex: an `[mcp_servers.mainbus]` entry in `~/.codex/config.toml`
- Copilot: a `servers.mainbus` stdio entry in VS Code's `mcp.json`

Look up each client's current syntax in its docs before writing it; don't trust these examples. In dev, show the dev command instead.

### Out of scope

- Editing, moving, starting, stopping or deleting tickets from outside.
- Answering decisions from outside.
- An HTTP transport.
- Launching the app on demand.
- Multiple workspaces beyond the `repo` check.
- Verifying who an agent really is.

### Safety while building this

Run every test and manual check against a temporary `MAINBUS_HOME`. Never connect to or write to the stable data home, and don't run `build-stable.ps1` (it refuses inside an agent anyway).

---

## Acceptance criteria

(One per line, as the form expects.)

```
Intake creates a ticket in Backlog through the same path as ticket.create, emits board.changed, and the board shows it without a reload
A request that names a column, an unknown field, an oversized field or a bad repo is rejected with an error naming the field, and nothing is created
The pipe name is derived from the data home, and a test with two homes shows a client for one cannot reach the other
Malformed JSON, an unknown method or a 1 MB+ line on the pipe gets an error reply and the app keeps working
mainbus ticket create/list/show work end to end against a test home, with --json input and output, and exit codes 0/1/2/3/4 as specified
With the app not running, the CLI exits 3 and the MCP tools return "Mainbus isn't running" with the data home path
With MAINBUS_AGENT set and MAINBUS_HOME unset, the CLI and MCP server refuse with exit code 4
An MCP client test lists create_ticket, list_tickets and get_ticket, creates a ticket, and the ticket's source agent is the client's clientInfo.name
An agent-created ticket shows a "from <agent> (reported)" badge with the folder on the card and in the ticket view; user-created tickets show none
The role prompt puts agent-written intent under its own heading, never under "The user's own words"; user tickets' prompts are unchanged; a user entry added later goes under the user's heading
get_ticket and list_tickets never return thread events, decisions or allow rules
The stable build ships the CLI outside the asar and build-stable.ps1 writes %LOCALAPPDATA%\Mainbus\bin\mainbus.cmd, which runs it on Mainbus.exe without Node installed
The workspace settings drawer has a Connect agents section with copyable setup lines for Claude Code, Codex and Copilot, built from the real launcher path
Typecheck, unit tests and e2e pass
```
