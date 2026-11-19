> **Investigation #126:** Investigate: what it would take to run Mainbus on macOS, and secondarily Linux
> **Date:** 2026-11-19 · **Status:** report, recommends but doesn't authorise changes
> **The question (the user's words):** @mainbus I would like an investigation into what it would take to make mainbus cross platform. Specifically Mac, and secondarily linux.

# Investigation: what it would take to run Mainbus on macOS, and then Linux

**Ticket:** #126 · **Date:** 2026-11-19 · **Base:** `origin/main` at `b34cb23`

## The question

Mainbus has only been built and used on Windows. What would it take to ship it on **macOS** (the priority) and then **Linux**? This report covers:
- an inventory of each Windows-specific behaviour;
- findings for each area: the data home, the Claude binary and PATH, processes, the permission guard, Electron UX, native dependencies, packaging and signing, and tests and CI;
- a phased plan as proposed change tickets.

## What I looked at, and how

- **Searches.** I searched the whole repo for `win32`, `process.platform`, `taskkill`, PowerShell, `LOCALAPPDATA`, `longpaths`, `.cmd`, `.exe`, `darwin` and `linux`. Ignoring `pnpm-lock.yaml` and docs, about 60 source and test files match.
- **Code read.** I read every non-test hit in full, and the e2e specs that branch by platform:
  - `home.ts`, `resolveClaude.ts`, `sdkRuntime.ts`, `processes/sweep.ts`, `ticketRunner.ts` (where sweeps are triggered);
  - `permissions/*`, `intake/*`, `git/*`, `baseline/folder.ts`, `setup/setupCommand.ts`;
  - `src/main/*` (lifecycle, tray, context menu, permissions, launcher);
  - the voice worker, `connectLines.ts`, the renderer's keyboard handling, `electron-builder.yml`, `electron.vite.config.ts`, `scripts/*` and `.github/workflows`.
- **Guard probe.** I fed macOS-style paths to the real `guardReason` and `isCredentialPath`, loaded through Vite's SSR loader with nothing written to the repo. The results are below.
- **Shipped dependencies.** I checked the installed packages and the lockfile for native or per-platform binaries.
- **Docs.** I read the docs for electron-builder 26.18, Electron and Claude Code, through Context7.
- **What I could not verify.** No Mac was available. The WSL Ubuntu on this machine has no Node, and I didn't install one, so **nothing here has been run on macOS or Linux**. Statements about behaviour there come from reading the code and the docs. Each one is a hypothesis until Phase 0's CI job or Phase 1's Mac run confirms it.

## Summary

Mainbus is closer to portable than the raw number of hits suggests:
- There is no native Node module to ship. SQLite is the built-in `node:sqlite`, and dictation runs on `onnxruntime-web` (WASM or WebGPU) in the renderer.
- The intake endpoint already uses a unix socket with mode 0600 off Windows.
- `resolveClaude` already uses `which`.
- The process table already has a `ps` path.
- `build/icon.icns` already exists, despite what the ticket assumed.

The real work is in five places:

1. **PATH for a GUI-launched app (design decision, blocking).** An app started from Finder, the Dock or a `.desktop` file gets a minimal PATH. `claude`, `gh`, `pnpm`, `node` and Homebrew `git` won't be found, either by Mainbus or by the agents and setup commands it starts.
2. **The process sweep doesn't work on POSIX (design decision, blocking).** Sweeps run when `claude` exits. On macOS and Linux its orphaned children are immediately re-parented to launchd or init, so walking parent process ids finds nothing. Leftover dev servers and watchers would never be ended.
3. **The permission guard is hard-wired to `path.win32` (design decision).** Its allow and deny decisions on macOS paths are mostly right, but:
   - its messages show POSIX paths as Windows paths (`C:\etc\hosts`, or `\etc\hosts` on a real Mac);
   - it folds case, which is wrong on Linux;
   - it treats `/c/…` as drive `C:`;
   - it has no rules for the macOS Keychain or Linux keyrings.
4. **The install model and the `mainbus` CLI launcher are Windows-only (design decision).** That covers `build-stable.ps1`, `run-stable.ps1`, `mainbus.cmd`, `launcher.ts`, and the `cmd /c` / PowerShell lines in "Connect agents".
5. **Electron UX on macOS (small changes).**
   - The taskbar overlay badge (`setOverlayIcon`) is Windows-only.
   - The tray glyph follows the Windows taskbar shade.
   - There is no `activate` handler to reopen the window from the Dock, and closing the last window quits the app.
   - The settings shortcut rejects Cmd.
   - The microphone needs an `Info.plist` string and, once signed, an entitlement.

## 1. Inventory

**Classes:**
- **Portable:** works as it is, or already branches correctly.
- **Small change:** contained, one area, low risk.
- **Design decision:** needs a choice before code.

| # | Windows behaviour (where) | What it does | macOS equivalent | Linux equivalent | Class |
|---|---|---|---|---|---|
| 1 | Data home `%LOCALAPPDATA%\Mainbus[-dev]`, falling back to `~/.mainbus[-dev]` (`src/engine/home.ts`) | Root for the DB, worktrees, scratch, baselines, models, backups | Works today as `~/.mainbus`. Conventional: `~/Library/Application Support/Mainbus` | `$XDG_DATA_HOME/mainbus` (`~/.local/share/mainbus`) | Design decision (§2) |
| 2 | Stable install: `scripts/build-stable.ps1`, `run-stable.ps1`, `package.json` `build:stable`/`run:stable` | Builds into `%LOCALAPPDATA%\Mainbus\app\<build>`, keeps 3, with `current.txt` and `previous.txt` | A `.sh` equivalent producing `app/<build>/Mainbus.app`, or a dmg install to `/Applications` | Same as macOS, or a deb/AppImage | Design decision (§8) |
| 3 | `mainbus.cmd` launcher and `agentLauncher` (`src/main/launcher.ts`) | Agents run `mainbus` through `%LOCALAPPDATA%\Mainbus\bin\mainbus.cmd`, worked out as `execPath/../../bin` | A POSIX `bin/mainbus` script running `Mainbus.app/Contents/MacOS/Mainbus` with `ELECTRON_RUN_AS_NODE=1`. `execPath/../..` lands inside the bundle, so it needs its own branch | Same script against the unpacked binary | Small change (after #2) |
| 4 | "Connect agents" lines: `cmd /c …`, PowerShell quoting, "in PowerShell" (`src/renderer/src/workspace/connectLines.ts`) | Shows how to connect Claude Code and other clients | POSIX `sh` quoting, no `cmd /c` | Same | Small change |
| 5 | `where.exe claude`, `.exe` filter, `%USERPROFILE%\.local\bin\claude.exe` fallback (`src/engine/runtime/resolveClaude.ts`) | Finds the user's `claude` | Already uses `which`. Needs fallbacks: `~/.local/bin/claude`, `/opt/homebrew/bin/claude`, `/usr/local/bin/claude`, npm global prefix | `~/.local/bin/claude`, npm global prefix | Small change, plus #6 |
| 6 | *(absent)* GUI PATH | — | A Finder or Dock launch gets launchd's `/usr/bin:/bin:/usr/sbin:/sbin` | A `.desktop` launch gets the session PATH, often without `~/.local/bin`, nvm and so on | Design decision (§3) |
| 7 | SDK spawn with `windowsHide`; `childEnv` sets TEMP, TMP and TMPDIR (`sdkRuntime.ts`) | Starts `claude`, points temp at scratch | `windowsHide` is ignored; TMPDIR is the one that matters, and it's already set | Same | Portable |
| 8 | Hook `cwd` accepted when `win32.isAbsolute` (`sdkRuntime.ts:525`) | Tracks the shell's folder | `win32.isAbsolute('/Users/…')` is true, so it works by accident | Same | Portable (tidy-up with #15) |
| 9 | Process table via PowerShell `Get-CimInstance` (`processes/sweep.ts`) | pid, ppid, name, start time | Already has `ps -eo pid=,ppid=,lstart=,comm=`. `lstart` is locale-dependent (set `LC_ALL=C`). `comm` is a full path on macOS (cosmetic) | Same | Small change |
| 10 | Kill trees with `taskkill /T /F`; descendants by ppid, which works for orphans on Windows (`sweep.ts`, `ticketRunner.sweepRun`) | Ends what an agent left running, after `claude` exits and at restart recovery | Orphans re-parent to launchd (pid 1), so the ppid walk misses them. Needs process groups (§4) | Orphans re-parent to init or a subreaper; same fix | Design decision |
| 11 | Setup and base-test commands with `spawn(cmd, {shell:true})` (`setup/setupCommand.ts`) | Runs `pnpm install` and similar | `/bin/sh -c` instead of `cmd.exe` works, provided PATH is fixed (#6) | Same | Portable (needs #6) |
| 12 | Intake on a named pipe `\\.\pipe\mainbus-<hash>` (`intake/endpoint.ts`, `server.ts`) | Local endpoint for `mainbus` and MCP | Already a unix socket `<home>/intake.sock` with umask 0177, and a stale socket is unlinked. `sun_path` is limited to 104 bytes on macOS, which matters for deep test homes under `/var/folders/…` | 108-byte limit | Portable (watch path length) |
| 13 | `core.longpaths=true` on every git call (`git.ts`, `worktrees.ts`, `baseline/folder.ts`) | Allows paths over 260 characters | Has no effect off Windows | Same | Portable |
| 14 | Worktree removal retries on EBUSY, EPERM or "used by another process" (`worktrees.ts`) | Windows file locks | POSIX has no mandatory locks; the retries are harmless | Same | Portable |
| 15 | Path equality folds case only on `win32` (`worktrees.ts`, `baseline/folder.ts`, `merge.ts`, `index.ts samePath`, `intake/methods.ts`, `fakeRuntime.ts`) | Compares repo and worktree paths | APFS is case-insensitive by default, so comparing exactly is slightly too strict. Fine in practice because Mainbus writes these paths itself | Exact comparison is correct | Portable |
| 16 | Guard resolves every path with `path.win32`, `fromGitBash` (`/c/…` → `C:\`), case-insensitive `isInside`, backslash-only regexes `TOOL_RESULTS` and `CLAUDE_SEGMENT` (`permissions/paths.ts`, `guard.ts`, `credentials.ts`) | Inside/outside-worktree decisions and messages | Decisions are mostly right; messages show backslashed paths; `/c/…` is misread | Case folding is **wrong**: `/home/u/Mainbus` and `/home/u/MAINBUS` are different folders | Design decision (§5) |
| 17 | Shell parser with `bash` and `powershell` dialects, cmd.exe switch handling, PowerShell aliases (`permissions/shell.ts`, `guard.ts`, `policy.ts`) | Parses the Bash and PowerShell tools' commands | Claude Code offers only the Bash tool (zsh or bash underneath), and the bash dialect exists. The Windows command sets are dead weight but harmless | Same | Portable |
| 18 | Credential names: `.ssh`, `.aws`, `.npmrc`, `.config/gh`, `.claude/.credentials.json` and others; NTFS name folding (`credentials.ts`) | Hard-stops reads of secrets | Names already match on POSIX. Missing: the Keychain (`security find-*-password -w`, `~/Library/Keychains`) | Missing: `secret-tool lookup`, `~/.local/share/keyrings`, `~/.gnupg` (already covered) | Small change |
| 19 | Tray glyph black or white from `shouldUseDarkColorsForSystemIntegratedUI` (`src/main/tray/electron.ts`) | Matches the taskbar | Should be a **template image** that macOS tints. A coloured needs-you dot doesn't survive templating | SNI or GtkStatusIcon; some desktop environments have no tray (§6) | Small change, plus a design choice for the dot |
| 20 | Taskbar overlay badge `win.setOverlayIcon` (`tray/electron.ts`) | Shows the needs-you count | Windows-only API; use `app.dock.setBadge` or `app.setBadgeCount` | `app.setBadgeCount` (LauncherEntry; needs `desktopName`) | Small change |
| 21 | Start Menu shortcut and AppUserModelID (`ensureStartMenuShortcut`) | Needed for Windows toasts | Already returns early off `win32` | Same | Portable |
| 22 | Toasts via `Notification` | Needs-you notifications | Works; macOS asks the user for permission on first use, and the permission is tied to the bundle's signature | libnotify over D-Bus; click actions vary by server | Portable (UX caveats §6) |
| 23 | Close behaviour: hide to tray when agents are open, else quit; `window-all-closed` quits; no `activate` (`src/main/index.ts`, `tray/closePolicy.ts`) | Window lifecycle | Convention is that closing hides and the app stays in the Dock; a Dock click must reopen (`activate`); Cmd+Q quits | When no tray is visible, hiding loses the window | Design decision |
| 24 | No application menu set; `autoHideMenuBar` (`windowOptions.ts`) | Windows hides the menu bar | macOS always shows Electron's default menu bar (with View → Reload and DevTools). Needs a real app menu: About, Settings… ⌘,, Hide, Quit ⌘Q, Edit and Window roles | Same as Windows | Small change |
| 25 | Shortcuts: `Ctrl+,` explicitly rejects `metaKey` (`App.tsx:63`); hint texts "Ctrl+K" and "Ctrl+V"; dictation `Ctrl+Shift+Space` | Keyboard UX | Settings should be ⌘, (from the app menu); hints should read ⌘. `mod+K` (Mantine) and the composer already accept Cmd | Ctrl is fine | Small change |
| 26 | `ensureSpellCheckLanguages` (`contextMenu.ts`) | Picks the Hunspell language | macOS uses the native spellchecker, and `setSpellCheckerLanguages` has no effect there; skip the call. Suggestions and "Add to dictionary" work | Hunspell, as on Windows | Small change |
| 27 | Microphone: Chromium permission handler only (`src/main/permissions.ts`) | Voice dictation | Needs `NSMicrophoneUsageDescription` in `Info.plist`, and with the hardened runtime the `com.apple.security.device.audio-input` entitlement | No OS prompt (PulseAudio or PipeWire) | Small change (packaging) |
| 28 | Window icon PNG, `build/icon.ico`, `build/icon.icns` | App icons | `.icns` exists; the Dock icon comes from the bundle (or `app.dock.setIcon` in dev) | PNG via `linux.icon` | Portable |
| 29 | `electron-builder.yml` has only `win: target: dir` | Packaging | Add a `mac` section (§8) | Add a `linux` section | Design decision |
| 30 | Shipped `node_modules` include the SDK's per-platform optional package with a bundled `claude` binary (**about 288 MB** for win32-x64) that Mainbus never uses, since it passes `pathToClaudeCodeExecutable` | Package size | Same, and it complicates universal builds (per-arch file) | Same | Small change (exclude it) |
| 31 | SQLite through `node:sqlite` (`src/engine/db/open.ts`) | Store | Built into Electron's Node; no rebuild | Same | Portable |
| 32 | Dictation: `@huggingface/transformers` and `onnxruntime-web` (WASM, WebGPU when available) in a renderer worker | Speech to text | WebGPU on Metal, WASM fallback; no native code | WebGPU is often unavailable; falls back to WASM | Portable |
| 33 | e2e `kill()` uses `taskkill` (`e2e/multiWorkspace.spec.ts`, `restartRecovery.spec.ts`) | Simulates a crash | Already has a `process.kill(pid,'SIGKILL')` branch | Same | Portable |
| 34 | Windows-only tests: `sweep.test.ts` real processes, the `server.test.ts` pipe DACL, `worktrees.test.ts` long paths and locked folder, `mainbusCmd.test.ts` | Platform checks | Need POSIX counterparts: the process-group sweep, socket mode 0600, the `bin/mainbus` script | Same | Small change |
| 35 | About 40 unit test files contain `C:\` or `C:/` literals | Fixtures | Tests that feed them through platform `path` functions will fail; tests of the guard (always `win32`) won't. Only a run on POSIX gives the real list | Same | Small change (sized after the CI run) |
| 36 | `powerSaveBlocker('prevent-app-suspension')`, single-instance lock, `.gitattributes *.cmd eol=crlf`, role prompt `$TEMP` | Misc | Works (it also prevents App Nap) | Works | Portable |

## 2. Data and config home

- **Today.** `resolveHome` uses `%LOCALAPPDATA%\Mainbus` and, without `LOCALAPPDATA`, falls back to `~/.mainbus` (and `-dev`). So a Mac run from source already has a working home today. `MAINBUS_HOME` overrides it, as before.
- **Recommendation.**
  - **macOS:** `~/Library/Application Support/Mainbus` (and `Mainbus-dev`). This is the same folder Electron's `app.getPath('appData')` returns.
  - **Linux:** `${XDG_DATA_HOME:-~/.local/share}/mainbus`. Everything Mainbus stores (DB, worktrees, models) is data, not config, so XDG_CONFIG_HOME is the wrong place.
- **Risk to weigh:** the space in `Application Support`. Ticket worktrees live under the home, so every agent shell command, setup command and user build tool runs in a path with a space. Most tools cope, as VS Code, Cursor and others show, but unquoted shell scripts and old Makefiles don't.
  - If that is unacceptable, keep `~/.mainbus` on macOS too: it is simple and has no space.
  - Splitting the home (state in Application Support, worktrees elsewhere) is a bigger change, because `HomePaths` assumes one root.
- **Paths stored in the DB.** Absolute paths are stored in `workspaces.repo_path`, `runs.worktree_path` and pending-cleanup `repo_path`/`worktree_path` (`src/engine/db/schema.ts`). This only matters if a home is moved. Nobody runs Mainbus on a Mac today, so **no migration is needed** as long as the default is chosen before first release. If a `~/.mainbus` → Application Support move is ever wanted later, it needs a path-rewriting migration plus moving the git worktrees (`git worktree repair`).
- **Electron's own data.** `userData` is already set to `<home>/electron`, so it follows the home.

## 3. The Claude Code binary and PATH

**How it works today.** `resolveClaude` runs `which claude` off Windows. It then runs `claude --version` and `claude auth status`. `SdkRuntime` passes that path as `pathToClaudeCodeExecutable` and spawns it itself (`spawnClaudeCodeProcess`). The SDK's bundled binary is never used.

**Where `claude` lives** (https://code.claude.com/docs/en/setup):

| Install | macOS | Linux |
|---|---|---|
| Native installer (`curl -fsSL https://claude.ai/install.sh \| bash`) | `~/.local/bin/claude` | `~/.local/bin/claude` |
| Homebrew cask (`brew install --cask claude-code`) | `/opt/homebrew/bin/claude` (Apple Silicon), `/usr/local/bin/claude` (Intel) | — (Linuxbrew: `/home/linuxbrew/.linuxbrew/bin`) |
| npm global | `$(npm prefix -g)/bin`, often under nvm, fnm or volta (`~/.nvm/versions/node/*/bin`) | Same |

**The GUI PATH problem.** An app launched from Finder, the Dock or Spotlight inherits launchd's PATH (`/usr/bin:/bin:/usr/sbin:/sbin`). None of the locations above are on it. On Linux, a `.desktop` launch gets the session PATH, which usually lacks `~/.local/bin` (depending on the distribution's `.profile`) and always lacks nvm. This affects more than `resolveClaude`:
- **Agents.** They inherit Mainbus's environment (`childEnv` copies `process.env`). Their Bash tool, `gh`, `pnpm` and `node` would all fail.
- **Setup and base-test commands.** They run through `/bin/sh` with the same PATH.
- **git and gh.** `git` would resolve to Apple's `/usr/bin/git` shim, which works only if the Xcode Command Line Tools are installed. `gh` (pull requests) would not be found.

**Recommendation (design decision).**
- At startup on macOS and Linux, before `chooseRuntime`, read the login shell's environment the way VS Code does: run `$SHELL -ilc 'env -0'` (or print only PATH between markers), with a timeout of about 10 s and no TTY.
- Merge PATH, and optionally the other variables, into `process.env`.
- If it fails or times out, fall back to prepending well-known folders:
  - `~/.local/bin`
  - `/opt/homebrew/bin`
  - `/usr/local/bin`
  - `~/.npm-global/bin`
  - the newest `~/.nvm/versions/node/*/bin`
- Skip all of this when launched from a terminal (`process.env.TERM` set), as in dev.
- Then extend `resolveClaude`'s fallback list (it already has one for Windows) with the paths in the table above, injected through the existing `FallbackFs`.
- **Risks.**
  - An interactive shell can print banners or hang on a prompt such as oh-my-zsh updates. Use markers and a timeout.
  - `-i` is needed for zsh users whose PATH is set in `.zshrc`.

**Keychain.** On macOS, Claude Code keeps its login in the Keychain. `claude auth status` run by Mainbus as the user works without any entitlement, because it is `claude` reading its own item. (When the Keychain rejects the write, Claude Code falls back to `~/.claude/.credentials.json`; see https://code.claude.com/docs/en/authentication.)

## 4. Processes

**Current design** (`src/engine/processes/sweep.ts`, `ticketRunner.sweepRun`):
- When an agent's `claude` process exits (`onProcessExit`), and at restart recovery, Mainbus reads the process table.
- It walks descendants of the stored root `{pid, startedAt}` by parent pid, rejecting reused pids by start time.
- It ends them with `taskkill /T /F`; off Windows, with `SIGKILL` for each pid.

**Why that fails on POSIX.** When a parent exits, its children are re-parented immediately: to launchd (pid 1) on macOS, or on Linux to init or the nearest subreaper (often `systemd --user`). The sweep runs *after* `claude` has exited, so the dev servers, watchers and test runners an agent left behind no longer have `claude`'s pid as their ppid. The walk finds nothing. The same happens after a Mainbus crash. (Windows keeps the dead parent's id in `ParentProcessId`, which is why the design works there.)

**Recommended design: process groups.**
- **Spawn.** Spawn `claude` with `detached: true` in `spawnClaude`. Node then calls `setsid()`, so `claude` becomes a session and process-group leader with `pgid == pid`. Everything it starts inherits that pgid unless it calls `setsid`/`setpgid` itself; daemons and some tools do.
- **Process table.** Read `pid,ppid,pgid,lstart,comm` with `LC_ALL=C` (`lstart` is locale-formatted).
- **Sweep.** Take the union of:
  - processes whose **pgid** equals the stored root pid;
  - their ppid descendants, to catch children that made their own group while the parent was alive.
- **Kill.** Use `process.kill(-pgid, 'SIGTERM')`, then `SIGKILL` after a short grace period. Fall back to pids one by one for stragglers outside the group.
- **Reused pids.** POSIX does not reuse a pid while a process group with that id still exists, so matching on pgid is safe. Keep the start-time check for the root.
- **Setup commands** (`shell: true`) should also be spawned `detached` so the same sweep applies.
- **Side effects.**
  - With `detached`, Ctrl+C in a `pnpm dev` terminal no longer reaches agents directly. Mainbus's own `before-quit` dispose already stops them.
  - A detached child doesn't die with Mainbus on a hard crash. That is exactly what restart recovery's sweep is for, and it works with pgid.

**Linux-only option:** run each agent in its own transient systemd scope (`systemd-run --user --scope`) and kill the cgroup. It is more thorough, but not portable to macOS or to non-systemd distributions. Not recommended as the first step.

**Size:** M. **Tests:** a POSIX twin of the Windows real-process test in `sweep.test.ts`: spawn a shell that backgrounds `sleep`, let the shell exit, sweep, and assert the `sleep` is gone.

## 5. The permission guard

**Probe results.** The real `guardReason` was run with a worktree of `/Users/sam/Library/Application Support/Mainbus/work/repo/12-fix`:

| Input | Result |
|---|---|
| Write `<wt>/src/a.ts` | allowed ✔ |
| Write `/etc/hosts` | hard stop, "Writes outside the ticket's folder: **C:\etc\hosts**" (decision ✔, message ✘) |
| Bash `rm -rf /tmp/x` | hard stop, "…**C:\tmp\x**" (decision ✔, message ✘) |
| Bash `cd "<wt>/src" && touch c.txt` | allowed ✔ |
| Read `~/.ssh/id_ed25519` | hard stop, credentials ✔ |
| Bash `cp ~/.config/gh/hosts.yml .` | hard stop, credentials ✔ |
| Write `/Users/sam/Library/Application Support/MAINBUS/work/…` (case changed) | **allowed**: correct on case-insensitive APFS, **wrong on Linux** |
| Write `/c/Users/x/evil.txt` | treated as `C:\Users\x\evil.txt` (still outside, so blocked, but wrong reasoning) |
| Bash `cat ~/Library/Keychains/login.keychain-db` | only an *automatic* stop (allowed when unattended); not seen as a credential |
| Bash `security find-generic-password -s foo -w` | **allowed**, though it prints a secret |
| `isCredentialPath('~/.local/share/keyrings/login.keyring')` | false |

(The probe ran on Windows. On a real Mac, `path.win32.resolve` takes no drive from a POSIX cwd, so messages would read `\etc\hosts`. The decisions are the same.)

**Recommendation (design decision; size L).**
- **Choose the path flavour per platform.** Pass the flavour into the guard as part of `GuardContext`, not as a global, so the existing Windows fixture tests (`fixtures/cards.json`, `guard.test.ts`) keep running on every OS:
  - Windows: `win32` with case folding and `fromGitBash`;
  - macOS: `posix` with case folding (APFS default);
  - Linux: `posix` exact.
- **Make the backslash-only regexes (`TOOL_RESULTS`, `CLAUDE_SEGMENT`) separator-agnostic.** Split segments on `/` as well.
- **Apply `fromGitBash` only on Windows.**
- **Add credential rules:**
  - macOS: `security` with `find-generic-password`/`find-internet-password` and `-w`/`-g`, or `dump-keychain`; paths under `~/Library/Keychains`; `~/Library/Application Support/gh`-style config if any.
  - Linux: `secret-tool lookup`/`search`; `~/.local/share/keyrings`; `~/.password-store`.
  - Both: `~/.config/op`, `~/.config/hub`. Review the list with the user.
- **Shells.** Claude Code's Bash tool runs commands in the user's shell, usually zsh on macOS. The parser's `bash` dialect covers zsh for everything the guard cares about (words, redirects, `cd`, variables). zsh-only syntax such as `=(…)` and glob qualifiers would be parsed loosely, which errs toward asking. The PowerShell tool doesn't exist off Windows, so that dialect is simply never used.

## 6. Electron UX

### macOS

- **App menu.** No menu is set today, so macOS shows Electron's default one, which includes Reload and Toggle DevTools. Build a menu with:
  - About Mainbus;
  - Settings… (⌘,), which opens the settings route (replacing the renderer's Ctrl-only handler on macOS);
  - Hide, Hide Others, Quit (⌘Q);
  - an `editMenu` role (so ⌘C, ⌘V and ⌘Z work in text fields);
  - a `windowMenu` role.
  
  Docs: https://www.electronjs.org/docs/latest/api/menu#main-menus-name
- **Tray (menu bar extra).**
  - Use template images (`…Template.png` / `@2x`; black plus alpha), which macOS tints for light and dark menu bars and for highlight. Drop the `shouldUseDarkColorsForSystemIntegratedUI` shade logic there.
  - Template images are monochrome, so the coloured **needs-you dot** can't be shown that way. Options:
    1. a template glyph with a cut-out or filled dot drawn in black (simplest, and monochrome);
    2. switch to a non-template coloured image only while something needs the user;
    3. `tray.setTitle('2')`, which shows a count next to the icon.
  
  Recommend (1) or (3). Clicking a tray with a context menu opens the menu on macOS. Docs: https://www.electronjs.org/docs/latest/api/tray, https://www.electronjs.org/docs/latest/api/native-image#template-image-macos
- **Dock badge and bounce.**
  - Replace `setOverlayIcon` (Windows-only) with `app.dock.setBadge(String(n))` or `app.setBadgeCount(n)`.
  - Optionally use `app.dock.bounce('informational')` when something new needs the user and the app isn't focused.
  - `setBadgeCount` needs notification permission on macOS.
  
  Docs: https://www.electronjs.org/docs/latest/api/app#appsetbadgecountcount-linux-macos, https://www.electronjs.org/docs/latest/api/dock
- **Notifications.**
  - `Notification` works. macOS shows its own permission prompt on first use, and grants are tied to the app's bundle id and code signature.
  - In dev the notifications appear as "Electron".
  - An ad-hoc-signed build gets a new signature on every rebuild, so permissions may be asked again; this is one of the practical reasons to sign (§8).
  - The Windows-only Start Menu shortcut code is already skipped.
- **Closing versus quitting.** Currently, closing the window with agents open hides it to the tray; with none open it quits, and `window-all-closed` also quits. On macOS:
  - closing the window should hide or close it, and the app should keep running in the Dock;
  - `app.on('activate')` must reopen or show the window when the Dock icon is clicked (it is missing today);
  - ⌘Q goes through `before-quit`, which already disposes cleanly.
  
  The "When the window is closed" setting can keep its meaning, with a macOS default of "keep running".
- **Shortcuts.**
  - `App.tsx:63` rejects `metaKey` for the settings shortcut; on macOS it should accept ⌘ (or leave it to the menu accelerator).
  - The placeholder "Search (Ctrl+K)" and "paste with Ctrl+V" should show ⌘ on macOS.
  - `Ctrl+Shift+Space` for dictation doesn't clash with macOS defaults (Ctrl+Space switches input source; ⌘Space is Spotlight), so it can stay, though ⌘⇧Space is not taken either.
- **Spellcheck (#113).** macOS uses the native `NSSpellChecker`; `setSpellCheckerLanguages` has no effect there, so skip `ensureSpellCheckLanguages` on darwin. Suggestions, "Add to dictionary" and the edit roles work. Docs: https://www.electronjs.org/docs/latest/tutorial/spellchecker
- **Voice dictation (#116).**
  - `getUserMedia` triggers the OS microphone prompt, which uses `NSMicrophoneUsageDescription` from `Info.plist`. Electron's default dev bundle has a generic string. The packaged app needs `mac.extendInfo.NSMicrophoneUsageDescription`.
  - With the hardened runtime (needed for notarisation), the app also needs the `com.apple.security.device.audio-input` entitlement, or the microphone is silently denied.
  - `systemPreferences.askForMediaAccess('microphone')` can pre-ask, and `getMediaAccessStatus` can explain a denial ("enable in System Settings → Privacy & Security → Microphone").
  - The existing `denied` VoiceError message should point there on macOS.
  
  Docs: https://www.electronjs.org/docs/latest/api/system-preferences#systempreferencesaskformediaaccessmediatype-macos, https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.device.audio-input
- **Folder privacy prompts (TCC).** If a workspace repo lives in `~/Documents`, `~/Desktop` or `~/Downloads`, macOS asks "Mainbus would like to access files in your Documents folder" the first time Mainbus, or `git` or `claude` started by it, touches the repo. Grants are keyed to the code signature, so **unsigned or ad-hoc builds may re-prompt after every rebuild**. Worktrees in the data home are not affected.
- **Window icon.** `BrowserWindow.icon` is ignored on macOS; the Dock uses the bundle's `.icns` (it exists). In dev, `app.dock.setIcon(windowIcon)` gives the right Dock icon.

### Linux

- **Tray.**
  - Electron uses StatusNotifierItem, falling back to GtkStatusIcon. KDE, Cinnamon, XFCE and Ubuntu's GNOME (with its bundled AppIndicator extension) show it.
  - **Stock GNOME (Fedora, Debian) has no tray at all.**
  - `click` fires on "activation", which may be a double click.
  - Menu item changes need `setContextMenu` again (already the pattern here).
  - Design consequence: hiding the window to an invisible tray would strand the user. On Linux, default "When the window is closed" to *quit* or *minimise*, not *hide to tray*, or make sure re-launching the app shows the window. The `second-instance` handler already does that, so this is mostly fine.
  
  Docs: https://www.electronjs.org/docs/latest/api/tray
- **Notifications.** libnotify over D-Bus works on all major desktops. Click actions depend on the notification server; keep notifications informative without relying on the click.
- **Badge.** `app.setBadgeCount` works on docks that support LauncherEntry (Ubuntu Dock, KDE). It requires `desktopName` to match the `.desktop` file.

## 7. Native dependencies

| Dependency | Shipped? | macOS arm64 / x64 | Linux x64 / arm64 | Rebuild? |
|---|---|---|---|---|
| SQLite: `node:sqlite` (built into Electron's Node) | yes (inside Electron) | ✔ | ✔ | No |
| Electron 45.2.0 | yes | ✔ both | ✔ both | No; pnpm downloads the host's build |
| Dictation: `@huggingface/transformers` + `onnxruntime-web` (WASM files bundled by Vite into the renderer) | yes (as WASM) | ✔ (WebGPU on Metal, WASM fallback) | ✔ (usually WASM) | No |
| `@anthropic-ai/claude-agent-sdk-<platform>` (optional dependency with a bundled `claude`, ~288 MB) | **yes today, unused** | darwin-arm64 and darwin-x64 packages exist | linux-x64/arm64 (+musl) exist | Exclude from packaging |
| `onnxruntime-node`, `sharp` (pulled in by transformers) | no (devDependencies; not in the renderer bundle) | prebuilt darwin-arm64/x64 | prebuilt linux-x64/arm64 | No. They are dev-install weight only; check that `pnpm install` is clean on a Mac |

- **Shipped code.** electron-vite externalises dependencies by default (`externalizeDeps ?? true`), so electron-builder copies production `node_modules` into the package. That is how the SDK's platform binary ends up shipped.
- **Recommendation.** Add `!**/node_modules/@anthropic-ai/claude-agent-sdk-*/**` to `files`, or `optional=false` handling, and confirm that the SDK never touches it when `pathToClaudeCodeExecutable` is set. That leaves no native code beyond Electron, which makes a universal macOS build straightforward.
- **The lockfile.** It already records every platform's optional packages, so `pnpm install --frozen-lockfile` works on macOS and Linux unchanged.

## 8. Packaging and distribution

**What "stable" means today.** It is not a downloadable installer. `build-stable.ps1` builds `--win dir` from the user's checkout and installs it under the data home. Two models for macOS:

- **(A) Local build, as today (cheapest).** A `scripts/build-stable.sh` runs `electron-builder --mac dir`. That produces `Mainbus.app`, which goes to `<home>/app/<build>/Mainbus.app`, plus `current.txt` and `bin/mainbus`. An app built on the machine is **not quarantined**, so Gatekeeper doesn't block it. Apple Silicon requires at least an ad-hoc signature on arm64 code; use `mac.identity: "-"` (electron-builder: "ad-hoc… will only run on the machine that built it"). No Apple account is needed. The downside is the TCC, notification and microphone re-prompts after rebuilds (§6).
- **(B) Distributed dmg (for other users).** Needs Developer ID signing and notarisation, or users see the "cannot be opened / damaged" dialog.
  - Since macOS 15 Sequoia, the old Control-click → Open bypass is gone. Users must go to System Settings → Privacy & Security → "Open Anyway", or run `xattr -dr com.apple.quarantine`.
  - Docs: https://support.apple.com/en-us/102445, https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution

**electron-builder config sketch (macOS)**:
```yaml
mac:
  target: [dmg, zip]          # dir for model (A)
  icon: build/icon.icns
  category: public.app-category.developer-tools
  hardenedRuntime: true
  entitlements: build/entitlements.mac.plist          # allow-jit, device.audio-input
  entitlementsInherit: build/entitlements.mac.plist
  notarize: true                                      # Phase 3 only
  extendInfo:
    NSMicrophoneUsageDescription: Mainbus uses the microphone for voice dictation, transcribed on this Mac.
```
Docs:
- https://github.com/electron-userland/electron-builder/blob/electron-builder@26.18.0/website/docs/mac.md
- https://github.com/electron-userland/electron-builder/blob/electron-builder@26.18.0/website/docs/features/code-signing/code-signing-mac.md
- https://github.com/electron-userland/electron-builder/blob/electron-builder@26.18.0/website/docs/features/code-signing/notarization.md
- https://www.electronjs.org/docs/latest/tutorial/code-signing

**Points to settle for macOS:**
- **Architecture.** Ship **arm64 first** (Apple Silicon). Add x64 or `universal` once the SDK binaries are excluded. A universal build merges two per-architecture builds and roughly doubles Electron's size (§7).
- **The `mainbus` CLI.** It runs the app binary with `ELECTRON_RUN_AS_NODE=1`. That relies on the `RunAsNode` fuse staying on; it does today, since no fuses are configured. Don't flip it without replacing the CLI launcher (https://www.electronjs.org/docs/latest/tutorial/fuses). Under the hardened runtime, run-as-node needs the `allow-jit` entitlement Electron already recommends. Test it after signing.
- **Signing and notarisation need:**
  - Apple Developer Program membership, **US$99 per year** (https://developer.apple.com/programs/);
  - a *Developer ID Application* certificate;
  - for CI: an App Store Connect API key (`APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`) or Apple ID plus an app-specific password and `APPLE_TEAM_ID`;
  - the certificate as `CSC_LINK`/`CSC_KEY_PASSWORD`;
  - a `macos-latest` GitHub runner (free for public repos; for private repos macOS minutes cost 10× Linux minutes: https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-actions/about-billing-for-github-actions).
  
  dmg creation and signing must run on macOS.

**Linux:**
- **Targets.** Use `deb` as the primary target. electron-builder sets the SUID `chrome-sandbox` there, which works on Ubuntu 24.04. Add `AppImage` as a secondary target.
- **AppImage caveats.**
  - It needs `libfuse2`, which is not installed by default on Ubuntu 22.04+.
  - On Ubuntu 24.04, AppArmor's restriction on unprivileged user namespaces breaks Electron's sandbox inside AppImages unless an AppArmor profile is installed or the app runs with `--no-sandbox`. Avoid `--no-sandbox`.
- **`rpm`** only if Fedora users ask.
- **Config.** Set `linux.category: Development`, `desktopName` (for the badge), and an icon PNG.
- Docs: https://github.com/electron-userland/electron-builder/blob/electron-builder@26.18.0/website/docs/linux.md

**Auto-update.** Not used: there is no `electron-updater` and no publish config. If it is wanted later, it is a separate decision. On macOS, Squirrel.Mac requires a signed app and the `zip` target.

## 9. Tests and CI

- **CI today:** only `.github/workflows/site.yml` (manual site publish). **No unit or e2e CI exists on any OS.**
- **Unit tests that assume Windows:**
  - `runIf(win32)` tests: `sweep.test.ts` (real processes), `server.test.ts` (pipe DACL), `worktrees.test.ts` (locked folder, paths over 260 characters), `mainbusCmd.test.ts`. They are skipped elsewhere and each needs a POSIX twin: process-group sweep, socket mode 0600, the `bin/mainbus` script.
  - About 40 test files contain `C:\` or `C:/` literals. Those exercising the guard are deterministic (always `win32`) and should pass anywhere. Those that pass such literals through platform `path.join`/`resolve` (for example `home.test.ts`, `launcher.test.ts`, `appIcon.test.ts`, `resolveClaude.test.ts`) may fail. The cheapest way to get the exact list is the CI job in ticket P0-1.
  - The engine tests run real `git`, which is portable.
- **e2e (Playwright for Electron)** runs on macOS and Linux. Linux CI needs a display: `xvfb-run -a pnpm exec playwright test`. The specs' `kill()` already has a POSIX branch. Two things to watch:
  - SIGKILL to Electron's main process: Chromium helpers notice the parent's death and exit, but verify that no stray processes block temp-dir cleanup;
  - deep `mkdtemp` homes under macOS `/var/folders/…/T/` against the 104-byte socket path limit (`intake.spec.ts`).
  
  Note that the base branch already has intermittent e2e and unit failures (recorded by Mainbus), so start the new OS jobs as non-blocking.
- **Suggested GitHub Actions matrix:**
```yaml
strategy:
  fail-fast: false
  matrix:
    os: [windows-latest, macos-latest, ubuntu-latest]   # macos-latest is arm64
runs-on: ${{ matrix.os }}
steps:
  - uses: actions/checkout@v4
  - uses: pnpm/action-setup@v4
  - uses: actions/setup-node@v4
    with: { node-version: 24, cache: pnpm }
  - run: pnpm install --frozen-lockfile
  - run: pnpm typecheck
  - run: pnpm test
  - run: pnpm build
  - run: xvfb-run -a pnpm exec playwright test
    if: runner.os == 'Linux'
  - run: pnpm exec playwright test
    if: runner.os != 'Linux'
```
  Unit and e2e on macOS and Linux would start as `continue-on-error: true` until Phase 1 lands.

## 10. Phased plan: proposed change tickets

Sizes: **S** is about a day, **M** 2 to 4 days, **L** 1 to 2 weeks, all of agent-plus-review time. Tickets inside a phase can mostly run in parallel.

### Phase 0: groundwork that needs no Mac

**P0-1 · CI: run typecheck and unit tests on Windows, macOS and Linux (S)**
- **Scope:** add `.github/workflows/ci.yml` with the matrix above, unit tests only. macOS and Linux are non-blocking.
- **Acceptance:**
  - The workflow runs on pull requests.
  - The Windows job is green apart from known flaky tests.
  - The macOS and Linux results are listed in the PR, as the input for P0-5.

**P0-2 · Process-group sweep on macOS and Linux (M)**
- **Scope:** `spawnClaude` and the setup runner spawn `detached` off Windows. The `ps` table adds `pgid` with `LC_ALL=C`. `descendantsOf` also matches on pgid. POSIX kill uses `kill(-pgid)`, TERM then KILL.
- **Acceptance:**
  - A unit test on POSIX: a backgrounded `sleep` survives its parent's exit and is ended by the sweep.
  - Windows behaviour and tests are unchanged.
  - No process outside the group or tree is ever matched.

**P0-3 · Login-shell environment and Claude fallbacks for GUI launches (M)**
- **Scope:**
  - On darwin and linux, when not started from a terminal, read PATH from `$SHELL -ilc` with markers and a timeout before the runtime is chosen, falling back to well-known folders.
  - Extend `resolveClaude` fallbacks to `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin` and the npm prefix.
- **Acceptance:**
  - Unit tests with an injected shell runner cover success, timeout and noisy output.
  - `resolveClaude` tests cover each install location.
  - Agents and setup commands inherit the fixed PATH.

**P0-4 · Per-OS data home (S, decision first)**
- **Scope:** `resolveHome` picks `~/Library/Application Support/Mainbus[-dev]` on darwin and `$XDG_DATA_HOME/mainbus[-dev]` on linux, unless the user prefers `~/.mainbus` (see §2 on the space in the path).
- **Acceptance:** `home.test.ts` covers each platform through an injected platform; `MAINBUS_HOME` still wins; Windows is unchanged.

**P0-5 · Make the unit suite platform-correct (M; sized from P0-1's output)**
- **Scope:** fix or parametrise tests that rely on Windows `path` semantics, and add POSIX twins of the `runIf(win32)` tests (socket mode 0600 in place of the DACL test).
- **Acceptance:** `pnpm test` is green on `ubuntu-latest` and `macos-latest`, and P0-1's macOS and Linux jobs become blocking.

**P0-6 · Guard path handling per platform (L)**
- **Scope:**
  - Pass a path flavour through `GuardContext`: win32 with case folding, darwin posix with case folding, linux posix exact.
  - Make `TOOL_RESULTS`, `CLAUDE_SEGMENT` and the segment splitting separator-agnostic.
  - Apply `fromGitBash` only on Windows.
  - Messages show native paths.
- **Acceptance:**
  - The existing fixture and guard tests pass unchanged for win32.
  - New table tests for darwin and linux paths cover inside/outside, case variants, `..` climbing, `~`, and `/c/…` not treated as a drive.

**P0-7 · Credential rules for macOS and Linux (S)**
- **Scope:** hard-stop `security find-*-password` (`-w`/`-g`) and `dump-keychain`, `~/Library/Keychains/**`, `secret-tool lookup|search`, `~/.local/share/keyrings/**` and `~/.password-store/**`.
- **Acceptance:** guard tests show each case as a credential hard stop with no "Always allow".

### Phase 1: runs from source on a Mac (`pnpm dev`)
*Needs from the user: a Mac, ideally Apple Silicon on macOS 14 or later, with Claude Code, git and pnpm installed.*

**P1-1 · First run on macOS: fix what breaks (M)**
- **Scope:** run `pnpm install`, `pnpm dev`, a ticket end to end, and an agent leaving a background process. Fix whatever surfaces.
- **Acceptance:** the user confirms a ticket runs Planner → Implementer → Review on a Mac from source, and a leftover process is ended.

**P1-2 · macOS app lifecycle and menu (M)**
- **Scope:**
  - The application menu (About, Settings… ⌘,, Hide, Quit ⌘Q, Edit, Window).
  - An `activate` handler.
  - Closing the window keeps the app running on darwin.
  - `window-all-closed` doesn't quit on darwin.
  - `app.dock.setIcon` in dev.
- **Acceptance:** ⌘, opens settings; ⌘Q quits cleanly (agents stopped, DB closed); a Dock click reopens a closed window; there are unit tests for the menu template and close policy.

**P1-3 · Menu bar icon, Dock badge and notifications on macOS (M)**
- **Scope:**
  - Template tray icons (new `…Template.png` / `@2x` renders from `design/icons`) and a monochrome needs-you indicator (design choice from §6).
  - `setBadge` uses `app.dock.setBadge` or `setBadgeCount` off Windows and `setOverlayIcon` only on win32.
  - An optional informational Dock bounce.
- **Acceptance:** the icon is legible in light and dark menu bars; the badge count matches needs-you; no Windows-only API is called on darwin; the tray e2e hook still records state.

**P1-4 · Shortcuts and hint text use ⌘ on macOS (S)**
- **Scope:** the settings shortcut accepts ⌘ on darwin; the search placeholder and attachment hint show ⌘; dictation keeps or adds ⌘⇧Space.
- **Acceptance:** component tests per platform.

**P1-5 · Spellcheck and microphone on macOS (S)**
- **Scope:** skip `setSpellCheckerLanguages` on darwin; on a dictation denial, point the user to System Settings → Privacy & Security → Microphone; optionally call `askForMediaAccess`.
- **Acceptance:** the context menu works on a Mac; the denied-microphone message is macOS-specific; there is a unit test for the skip.

**P1-6 · e2e on macOS (M)**
- **Scope:** run the Playwright suite on `macos-latest`; fix socket path length and teardown issues.
- **Acceptance:** an e2e job on macOS, non-blocking at first, with the same pass rate as Windows.

### Phase 2: packaged, unsigned (ad-hoc) macOS build

**P2-1 · electron-builder macOS target and smaller package (M)**
- **Scope:**
  - A `mac` section: `dir`, `icns`, category, `identity: "-"`, `extendInfo.NSMicrophoneUsageDescription`, arm64.
  - Exclude the `claude-agent-sdk-*` platform packages on every OS.
- **Acceptance:**
  - `electron-builder --mac dir` produces a running `Mainbus.app`.
  - The Windows package is about 288 MB smaller and still runs agents.

**P2-2 · Stable install and `mainbus` CLI on macOS (M; decision: local-build model (A) or dmg)**
- **Scope:**
  - `scripts/build-stable.sh` and `run-stable.sh` (keeping 3 builds, `current.txt`/`previous.txt`, refusing to run under `MAINBUS_AGENT`).
  - A POSIX `scripts/mainbus` launcher using `ELECTRON_RUN_AS_NODE`.
  - `agentLauncher` resolves it from the bundle path.
  - The `package.json` scripts pick the right script per OS.
  - The "Connect agents" lines use POSIX quoting and no `cmd /c`.
- **Acceptance:**
  - From a Finder launch, agents can run `mainbus ticket …` and `mainbus mcp`.
  - A script test like `mainbusCmd.test.ts` covers paths with spaces and quotes.
  - `connectLines` tests per platform pass.

### Phase 3: signed and notarised macOS
*Needs from the user: Apple Developer Program enrolment (US$99 per year), a Developer ID Application certificate, an App Store Connect API key, and permission to add them as GitHub secrets.*

**P3-1 · Hardened runtime, entitlements and notarisation (M)**
- **Scope:**
  - `build/entitlements.mac.plist` with `cs.allow-jit` and `device.audio-input`.
  - `hardenedRuntime: true`, `notarize: true`, `dmg` and `zip` targets.
- **Acceptance:**
  - `spctl -a -vv Mainbus.app` reports "Notarized Developer ID".
  - A downloaded dmg opens without Gatekeeper warnings.
  - The microphone, notifications and `mainbus` (run-as-node) all work in the signed build.

**P3-2 · macOS release workflow (S)**
- **Scope:** a `workflow_dispatch` job on `macos-latest` that builds, signs, notarises and uploads the artefact; optionally x64 or universal.
- **Acceptance:** a manual run produces a notarised dmg; no secrets in logs.

**(Optional) P3-3 · Auto-update.** Only if wanted: `electron-updater`, a publish target, and the zip target. Out of scope unless the user asks.

### Phase 4: Linux
*Needs from the user: a Linux desktop or VM to try the tray and notifications, ideally Ubuntu 24.04 (GNOME with AppIndicator) and one KDE or stock-GNOME desktop.*

**P4-1 · Linux runtime behaviour (M)**
- **Scope:**
  - The XDG home (from P0-4).
  - Case-sensitive guard (from P0-6).
  - Tray fallback: default "When the window is closed" to quit or minimise when a tray may be invisible.
  - `setBadgeCount` with `desktopName`.
  - Notifications without relying on click.
- **Acceptance:** run from source on Ubuntu 24.04; a ticket runs end to end; closing the window never strands the app; e2e passes under `xvfb-run` in CI.

**P4-2 · Linux packages (S to M)**
- **Scope:** `linux` targets `deb` (primary) and `AppImage`, with category, icon and `desktopName`; a `build-stable.sh` path for Linux.
- **Acceptance:** the deb installs and launches with the Chromium sandbox on Ubuntu 24.04; the `.desktop` entry shows the icon; `mainbus` works from a terminal.

### Order, risks and what the user provides

1. **Phase 0** (P0-1 to P0-7). Doable now on Windows plus CI; about 3 to 4 weeks of tickets. P0-2, P0-3 and P0-6 are the meaty ones.
2. **Phase 1.** Blocked on **a Mac to test on**; about 2 weeks.
3. **Phase 2.** About 1 week. **Decision:** keep the "build locally into the data home" model on macOS (no Apple account needed), or move to a dmg.
4. **Phase 3.** Blocked on **an Apple Developer account** (US$99 per year) and secrets; about 1 week plus Apple's enrolment time.
5. **Phase 4.** About 1 to 2 weeks; needs **a Linux desktop or VM**.

**Main risks:**
- Login-shell PATH capture: hangs, noisy dotfiles, nvm.
- Detached process groups changing how agents are stopped. Keep the Windows path untouched and cover it with real-process tests.
- The guard refactor touching security-critical code. Keep the win32 fixtures as the regression net.
- macOS privacy prompts with ad-hoc builds (a usability, not correctness, argument for signing).
- Linux tray fragmentation.
- Unknown unit-test fallout until P0-1 runs.

**Decisions for the user:**
- the macOS data home (`~/Library/Application Support/Mainbus` versus `~/.mainbus`);
- the macOS needs-you indicator style;
- the distribution model (local build versus a notarised dmg);
- arm64-only versus universal.
