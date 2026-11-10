> **Investigation #106:** Investigate: how Mainbus could know the real values of shell variables (and the current folder) when a command needs approval, so cards show actual paths instead of variable names
> **Date:** 2026-11-09 · **Status:** report, recommends but doesn't authorise changes
> **The question (the user's words):** create an investigation ticket for how we could track script variables so approvals have the actual value instead of just a variable name.

# Knowing the real value of shell variables and the current folder when a command needs approval

**Ticket #106 (Investigate).** The question: when an agent's command uses variables (`> "$TEMP/unit.txt"`, `cd "$D"`, `"$PWD\node_modules"`), the guard can't tell where the command writes, so it raises a hard stop, and the card shows the variable's name instead of its value. How could Mainbus know the **actual value at approval time**, both to decide (allow it if the path is inside the ticket's folder or scratch folder) and to show it on the card? Ticket #104 (Backlog) already covers the *static* cases. This report covers what static parsing can't settle. No code was changed.

## Short answer

1. **Claude Code already tells the hook the shell's real current folder.** Every `PreToolUse` hook input has a `cwd`, and it follows the agent's `cd` and `Set-Location` across calls. Tested on the installed SDK 0.3.314 and `claude` 2.1.314. Mainbus's guard hook receives it and ignores it today.
2. **Variables do not survive between commands.** Each Bash or PowerShell call starts a fresh shell: only the folder carries over. Tested: `export X=…` in one call, then `echo "[$X]"` in the next, prints `[]`. The same holds for PowerShell `$x` and `$env:X`. So "variables exported by earlier commands" is not a case that occurs. A variable is either set in the same command line (#104's part), inherited from the environment that Mainbus itself builds (`childEnv`), or it is empty.
3. On this board's 333 permission cards that could be matched to a recorded command, today's guard gives **135 hard stops**:
   - **#104** as specified would remove about **49** of them;
   - **using the hook's `cwd`** would remove about **44 more**, and make #104's other 32 exact instead of best-guess;
   - everything else (inherited variables, command substitutions, rewriting commands, a separate shell) removes **0 hard stops**. Inherited values can only make a few true stops clearer.

**Recommendation:** fold the hook's `cwd` into #104, replacing its "replay earlier `cd` commands" item. Add a small follow-up that shows the current folder and resolved values on the card. Don't build shell evaluation, command rewriting or export tracking.

## What I looked at

- **Code:**
  - `src/engine/permissions/guard.ts`, `shell.ts`, `credentials.ts`, `policy.ts`;
  - `src/engine/runtime/sdkRuntime.ts` (the guard hook, `canUseTool` and `childEnv`);
  - `src/engine/runner/ticketRunner.ts` (`onPermission`, lines 2408-2474).
- **SDK types:** `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (0.3.314): `BaseHookInput`, `PreToolUseHookSpecificOutput`, `CanUseTool`, `PermissionResult` and `CwdChanged`.
- **Three throwaway SDK sessions:**
  - Haiku, in a folder in the ticket's scratch space, with a `canUseTool` that allowed only the listed `cd`, `pwd`, `echo`, `touch` and `New-Item` commands;
  - plus the same `export` and `$env:` checks in this session's own shells.
- **The board's data:** a read-only copy of the database, deleted afterwards. That's 335 permission cards on the mainbus workspace and 7,174 recorded Bash and PowerShell calls.
  - I re-ran **today's** `guardReason` over every recorded command, so old cards are judged by the current guard, not the one at the time.
  - I replayed each session's `cd` commands in order, as #104 proposes, to see where a replay knows the folder and where it loses track.
- **#104's spec**, read from the board.

## What the SDK and `claude` actually give (option 1)

| What | Result |
|---|---|
| `PreToolUse` hook input | `session_id, transcript_path, cwd, prompt_id, permission_mode, effort, hook_event_name, tool_name, tool_input, tool_use_id`. **No environment.** |
| `cwd` after `cd src/deep` in an earlier call | `…\work\src\deep`: it follows the shell. After `cd ../..` it was back to `…\work`. |
| PowerShell | Shares the same folder as Bash (`Set-Location ..` moved it, and the hook saw it). PowerShell's `$PWD` printed exactly the hook's `cwd`. |
| Two writing Bash calls in one message (`cd src/deep`, `touch a.txt`) | They ran one after the other. The second call's `PreToolUse` came after the first call's `PostToolUse` and saw the new `cwd`, and the file landed in `src\deep`. |
| A read-only call in parallel with a `cd` (`pwd`) | Both hooks fired first and `pwd` ran in the old folder, so its hook `cwd` matched where it ran. Only read-only commands run in parallel, and those give automatic reasons at most, never a hard stop. |
| `canUseTool` options | `toolUseID`, `decisionReason`, `blockedPath`, …: **no `cwd`.** |
| `CwdChanged` hook | Registered as an SDK callback, it **never fired** in these tests. |
| `export`, `$x`, `$env:X` across calls | **Not kept** (`[]`). This is also what Claude Code's own tool description says. |
| `updatedInput` from `PreToolUse` | Works: `pwd` rewritten to `pwd; echo REWRITTEN-BY-HOOK` ran, and the agent saw the extra output. |
| `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1` | Still supported. The `cd` was dropped silently: `touch a.txt` landed in the project root, and the agent wasn't told. |

Plumbing matters for the fix. The guard hook (`sdkRuntime.ts:462`) decides "ask", but `onPermission` re-runs `guardReason` from `canUseTool`, which has no `cwd` (`ticketRunner.ts:2418`). Both must use the same folder, otherwise they disagree. The hook should store `cwd` by `tool_use_id`, and `canUseTool` should pass it on as `req.cwd`. When it is missing, use today's behaviour (the worktree root, which errs towards asking). Allow rules (`policy.ts` `isCdInside`, `rulesFromRequest`) resolve `cd` targets with the same folders and need the same `cwd`. Roles can't start subagents (`Agent` and `Task` are disallowed in `roles/hardening.ts`), so the subagent case, where `cwd` was not tested, doesn't arise.

## The options compared

| # | Option | What it resolves | What it can't resolve | Effort | Risks | Fits the rules? |
|---|---|---|---|---|---|---|
| 1 | **Hook `cwd`** (Claude Code's own folder, at approval time) | The real current folder for relative paths, `cd ../..`, `$PWD` (Bash and PowerShell). It is exact, including after heredocs, `cd "$VAR"`, failed commands and Claude Code's own folder resets. | Variables; a `cd` *inside* the same command (still static, so #104 should track it); `$OLDPWD`. | **S**: pass `i.cwd` into `GuardContext`, map it by `tool_use_id` for `onPermission`, and resolve against `ctx.cwd ?? worktree`. | Tied to an SDK field (it is in the public `BaseHookInput` type). It must be read in the hook, not in `canUseTool`. | Yes: passive, nothing runs, and a folder path is not a secret. |
| 2 | **Tracking exports across commands** (replaying `export`/`set`) | Nothing: exports don't survive to the next call (tested). Replaying them would *invent* values the shell doesn't have. Replaying `cd` (#104 item 1) does work, but loses track in 1,600 of 7,174 calls, mostly after a `cd` inside a heredoc or parenthesised command. | Everything it would claim to resolve. | M | **Wrong values make wrong allows.** Don't build it. | Not needed. |
| 3 | **Asking a separate shell** (`bash -c 'printf …'` with the agent's environment) | Inherited values only (`$HOME`, `$LOCALAPPDATA`, `$MAINBUS_AGENT_HOME`). Mainbus *built* that environment itself (`childEnv`), so a plain lookup gives the same answer without starting a shell. | In-line values (#104), substitutions (must never run), the folder. | M | A shell is never side-effect free: `BASH_ENV` or `ENV` in the environment makes even `bash -c` source a file; Claude Code also applies a snapshot of the user's profile, and Git Bash startup differs. Every word would need to be proven free of `$(…)`, backticks, `<(…)` and `${x:=…}` first, and then the lookup is enough anyway. | Only as a **lookup in `childEnv`**, not a shell. Secrets: see below. |
| 4 | **Rewriting the command** (`updatedInput`, e.g. appending `pwd > …; env > …`) | It would record state *after* a command, which is too late for the card in front of the user. The folder is already given by option 1, and variables don't persist, so there is nothing else to learn. | Everything before the command runs. | M | Changes the agent's exit codes and output (the agent saw the injected text in the test), breaks `exit`, heredocs and PowerShell syntax, and would write every secret (`GH_TOKEN`) to disk if it dumped `env`. | **No**: it reads credentials and changes what runs. |
| 5 | **Steering agents** (prompt rules) | Fewer variable and `cd` patterns in the first place: "Write paths from the worktree root or as literals; use `$TEMP` for temporary files. Don't prefix commands with `cd "$PWD"`. Prefer `git -C`, `pnpm -C` or path arguments to `cd` into subfolders and back." | Nothing by itself. Agents follow such lines only partly: the scratch-folder instruction exists, yet #100 and #102 still used `/tmp`. | XS (`roles/prompt.ts`) | None. | Yes. |
| 6a | `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1` in `childEnv` | Makes the guard's "everything starts at the root" assumption true, so `$PWD` is always the root. | Same as option 1 for variables. | XS | **Silently** runs the next command in the root after a `cd` (tested: the file was written to the wrong folder, and the agent was not told). | Only a fallback if option 1 ever proves unreliable. |
| 6b | Claude Code's shell-snapshot file, `CLAUDE_ENV_FILE` | The snapshot is the user's profile functions and exports, which can contain tokens, under `~/.claude`. | – | – | Reads possible credentials outside the worktree. | **No.** |
| 6c | Known side-effect-free substitutions, computed by Mainbus without running them: `$(pwd)`, `$(pwd -W)` → the `cwd`; `$(git rev-parse --show-toplevel)` → the worktree root when the `cwd` is in it | A few automatic "command substitution" reasons (85 calls, 6 cards over the board's history). | Any other `$(…)` stays unknown. | S | The match must be exact, with no arguments beyond the listed forms. | Yes: nothing is executed. |

### Secrets and "nothing runs before approval", option by option

- **Hook `cwd`:** a folder path, so no secret. Nothing is executed; it's a value Claude Code already sends.
- **In-line values (#104):** the card only repeats a value that is already in the command text the card shows, so nothing new is revealed.
- **Inherited values (lookup in `childEnv`):**
  - resolve only an allowlist of path variables: `HOME`, `USERPROFILE`, `LOCALAPPDATA`, `APPDATA`, `TEMP`/`TMP`/`TMPDIR`, `MAINBUS_AGENT_HOME`, `ProgramFiles*`, `SystemRoot`;
  - also require the value to look like an absolute path;
  - never resolve a name matching `credentials.ts`'s `SECRET_KEY` (`auth|token|passw|secret|credential|extraheader`) or anything off the list. Those show as *hidden*;
  - nothing is executed.
- **Substitutions:** never executed. Only the exact side-effect-free forms in 6c are computed from what Mainbus already knows; everything else shows as *unknown*, and the guard keeps treating it as outside.
- **Separate shell or rewriting:** rejected, because they would run code (profile, `BASH_ENV`) or write the environment, secrets included, to disk.

## How a card would show it

- A new line, **Runs in:** `src\engine\proposals` (in the ticket's folder), taken from the hook's `cwd`.
- In the reason and next to the command, name → value:
  - `$D` → `C:\tmp\mainsrc2`
  - `~` → `C:\Users\steve`
  - `$PWD\node_modules` → `…\work\mainbus\100-…\node_modules`
- **Unknown** when it can't be resolved, with why:
  - `$R` → unknown: set by `$(…)`, which Mainbus doesn't run;
  - `$X` → unknown: not set in this command or in the agent's environment.
- **Hidden** for anything that may hold a credential: `$GH_TOKEN` → hidden.
- Data: add `cwd: string | null` and `values: { name, value | null, note }[]` to `PermissionRequestParts` (`src/shared/domain.ts:435`). It is stored as JSON in `decisions.request`, so no migration is needed.

## How much it would help: real cards from this board

Today's guard was run over the 333 permission cards that could be matched to their recorded command (mainbus workspace, #1 to #106). There are 135 hard stops.

| Group | Cards | Removed by |
|---|---:|---|
| A. True stops: `/tmp`, `T:\`, another ticket's worktree, `~`, `.npmrc`, `env`, `git worktree` | 37 | Nothing, correctly. Inherited-value lookup makes 1 clearer (#71 `cd ~` → `C:\Users\steve`). Literal paths are already clear. |
| B. Variable set in the same line, or `$TEMP` after an `export` (`$f`, `$D`, `$B`, `$R`, `$d`, `"$TEMP/unit.log"`) | 17 | **#104 item 2** |
| C. Relative path or `$PWD` from a subfolder, where a `cd` replay knows the folder | 32 | **#104 item 1**, and equally by the hook's `cwd` (exact rather than replayed) |
| D. Relative path or `$PWD`, where a `cd` replay **loses** the folder (after a `cd` inside a heredoc or parenthesised command, or `cd` to a variable) | **44** | **Only the hook's `cwd`** |
| E. A `cd` inside the same command (`cd src/x && … && cd ../../..`), or a real exit (#32) | 5 | Static tracking of `cd` within one command (add to #104); about 4 of the 5 |

Group D is concentrated: 34 of the 44 are #5's Implementer prefixing every command with `cd "$PWD";`. The others are #44 (2), #46 (2), #84 (1), #87 (3), #95 (1, PowerShell `$PWD`) and #100 (1, PowerShell `$PWD`). Without #5, the hook's `cwd` adds about 10 hard stops across 6 tickets. Its larger value is that #104's folder tracking becomes exact and much simpler: the replay also drifted, for example to `src\src` on #77 and a doubled `node_modules\…\node_modules\…` path on #61.

Per ticket named in the spec:
- **#1:** 9 hard stops, all true (`/tmp`), so no option changes them; 74 other cards are automatic.
- **#44:** 4 hard stops: 2 by #104's replay, 2 only by the hook's `cwd`.
- **#80:** 4 hard stops: 3 by #104's replay, 1 by #104 item 2 (`for f in …` after `cd src/engine/proposals`).
- **#100:** 7 hard stops:
  - 5 by #104 item 2 (`$TEMP/*.log` after `export MAINBUS_HOME=…`, `$D`);
  - 1 only by the hook's `cwd` (PowerShell `$PWD\node_modules`);
  - 1 true stop (`/tmp/mainsrc2`). Resolving `$D` there shows `→ C:\tmp\mainsrc2`, which is clearer.
- **#105:** 2 hard stops, both by #104 item 2 (`$TEMP/unit.txt`, `$TEMP/e2e.txt`).

The other options, beyond #104, over all 7,174 recorded calls:
- **Exports across commands:** 0. They can't occur.
- **Inherited values:**
  - 0 hard stops removed: every one found points outside anyway (`$LOCALAPPDATA/Mainbus/bin`, `$MAINBUS_AGENT_HOME` twice, `$OLDPWD`, `~`);
  - 1 hard-stop card (#71) and about 5 automatic reasons become clearer.
- **Command substitutions:** 0 hard stops. The guard treats them as "can't check", which is automatic, so unattended mode already allows them. That's 85 calls and 6 cards, which only matter when unattended mode is off.
- **PowerShell `$env:`:** none appear in reasons other than `$env:TEMP` (#104).
- **Rewriting or a separate shell:** 0 beyond the above, with the risks listed.

## Recommendation and ticket plan

**1. Add to #104 now. It is still in Backlog, so it hasn't started.**
- Replace item 1's "replay earlier `cd` commands" with **the `PreToolUse` hook's `cwd`**:
  - store it by `tool_use_id` in `sdkRuntime.ts` and pass it to `onPermission` (as `req.cwd`) so both guard calls agree;
  - resolve relative paths, `cd` targets and allow-rule `cd` checks against it;
  - if it is missing or not absolute, use the worktree root as today.
- Keep static tracking for a `cd` **inside the same command** (group E).
- `$PWD` and PowerShell's `$PWD` resolve to the hook's `cwd`.
- Add to #104's prompt line: don't prefix commands with `cd "$PWD"`; write paths from the worktree root.
- Tests:
  - the `cwd` from the hook is used;
  - a missing `cwd` still asks;
  - the hook and `onPermission` agree;
  - a live test (like `sdkRuntime.live.test.ts`) that a `cd` in one call changes the next call's hook `cwd`, so an SDK change is caught.
- Expected result: 49 (#104 as specified) + 44 (hook `cwd`) + about 4 (`cd` within a command) ≈ **97 of 135 hard stops (about 72%) gone**. The rest are true stops.

**2. Follow-up ticket, "Show the current folder and resolved values on permission cards" (M):**
- the **Runs in:** line;
- name → value for in-line, `$TEMP` and `$PWD` values;
- a lookup in `childEnv` for an **allowlist** of path variables, with secret-looking names *hidden* and the rest *unknown*;
- the new `PermissionRequestParts` fields and the card UI.

**3. Optional, low priority (S):** compute the exact side-effect-free substitutions `$(pwd)`, `$(pwd -W)` and `$(git rev-parse --show-toplevel)` without running them. It only matters when unattended mode is off.

**Don't build:**
- export tracking (it's not a real case);
- shell-based expansion (risks side effects, and a lookup gives the same answer);
- command rewriting (reads and writes secrets, and changes the agent's commands);
- reading Claude Code's shell snapshot.

Keep `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR` only as a documented fallback: it silently changes where commands run.

## Note found during the investigation

My own command `env | grep -i '^MAINBUS' | sed 's/=.*//'` raised "Prints credentials: env" on this ticket, although it prints only names. That is the guard erring towards asking, as designed; it's mentioned only as a possible later refinement.
