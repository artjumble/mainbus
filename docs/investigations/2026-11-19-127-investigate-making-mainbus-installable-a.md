> **Investigation #127:** Investigate: making Mainbus installable and launchable through npm / npx
> **Date:** 2026-11-19 · **Status:** report, recommends but doesn't authorise changes
> **The question (the user's words):** @mainbus I would like an investigation into what it would take to make mainbus installable through npm/npx (assume after it has multi-platform support).

# Investigation: installing and launching Mainbus through npm / npx

Ticket #127. Date: 2026-11-19. No code was changed.

## The question

What would it take for a user to get Mainbus with `npx mainbus` or `npm install -g mainbus`, the way people install Claude Code? Assume macOS, Linux and Windows support already exists (#126, `2026-11-19-126-investigate-what-it-would-take-to-run-ma.md`; not re-investigated here). Recommend an approach and an ordered plan of change tickets.

## What I looked at

- Repo: `package.json`, `electron-builder.yml`, `vite.cli.config.ts`, `src/cli/main.ts`, `scripts/mainbus.cmd`, `scripts/build-stable.ps1`, `src/engine/home.ts`, `src/engine/db/open.ts`, `src/main/index.ts` (single-instance lock, `userData`), and the #126 report.
- npm registry (queried 2026-11-19 with `npm view`): name availability, and how `@anthropic-ai/claude-code`, `electron` and `esbuild` package themselves.
- Docs fetched: npm trusted publishing and Electron installation. Other URLs below are cited from knowledge and were not re-fetched; the first ticket verifies the riskiest claims.

## Summary

- **Recommended: approach (c), refined.** One public package `mainbus` (the `bin`, the CLI bundle, a small launcher, no install scripts) plus per-platform packages `@mainbus/<os>-<arch>` as `optionalDependencies`. Each platform package carries the built app **as one archive** (not an unpacked tree). The launcher extracts it once into the data home and runs it. If the platform package is missing (`--omit=optional`, unsupported platform), the launcher falls back to downloading the same archive from GitHub Releases and verifying a SHA-256 baked into the launcher.
- The unscoped name `mainbus` is **unclaimed** today (404). Whether the `@mainbus` scope is free can't be told from the registry; the user has to check on npmjs.com.
- The existing CLI fits naturally: it is already one self-contained CJS file that needs only Node. It goes in the main package, so `mainbus ticket ...` and `mainbus mcp` work without extracting Electron at all.
- Two real hazards: (1) npm tarballs don't reliably preserve the symlinks inside a macOS `.app` (assumed, to verify), which would break a signed bundle, hence the single archive; (2) the data home is shared by every build, and I found no downgrade guard on the DB.
- There is no auto-updater today (no `electron-updater`, no publish config). Keep it that way: npm is the only update path, and the app only *tells* the user a newer version exists.

## 1. Approaches compared

| | (a) Full app as one npm package (`electron` dependency, `bin` runs it) | (b) Thin launcher; downloads the signed app from GitHub Releases | (c) Per-platform optional-dependency packages (recommended; (b) as fallback) |
|---|---|---|---|
| What the user installs | `mainbus` with `electron` as a dependency, plus the app's `out/` JS | A few KB of JS | A few KB launcher + the one matching `@mainbus/<os>-<arch>` (npm picks it by the `os`/`cpu` fields) |
| Install size / time | Electron's postinstall downloads its ~100–130 MB zip from GitHub (cached in `~/.cache/electron` etc.); app code is small. Disk: 250 MB+ | Install is instant. First run downloads the app (~150–250 MB) | One download from the npm registry, similar size. Claude Code's darwin-arm64 package is 355 MB unpacked, so that size is accepted practice |
| Offline | Needs network for the Electron download at install (cached afterwards) | Needs network on first run and on every upgrade | Works offline after install; works from a corporate npm mirror |
| Native modules | None to rebuild today: SQLite is built-in `node:sqlite`, dictation is WASM (#126 §7). A future native module would need an Electron-ABI rebuild at install in (a) | Same; built once in CI | Same; built once per platform in CI |
| Signing / notarisation | **Poor.** Runs as the *generic* `electron` binary from the cache: not Mainbus-branded or signed as Mainbus. No bundle id, icon, notification identity, TCC or microphone permission of its own on macOS (permissions are tied to the signature, #126 §6) | **Good.** A signed, notarised build (Developer ID; Authenticode) is what is downloaded. A download by Node sets no quarantine attribute or Mark-of-the-Web, so Gatekeeper and SmartScreen don't prompt, but the signature is still valid | **Good if shipped as an archive.** Extraction with `tar`/`ditto`/`unzip` keeps symlinks, modes and the signature. Shipping the unpacked `.app` as tarball *files* is risky (npm packing doesn't carry symlinks such as `Versions/Current` in Electron's frameworks, and may normalise modes): verify, don't rely on it |
| Updates | `npm i -g mainbus@latest` re-downloads Electron if its version changed | `npx mainbus@latest` gets a new launcher, which fetches the new build | `npm i -g mainbus@latest` or `npx mainbus@latest`; one version for everything, pinned by the lockfile |
| Uninstall | `npm uninstall -g` leaves the Electron cache | Leaves the downloaded app; needs a `mainbus uninstall` | `npm uninstall -g` removes the packages; the extracted copy and data home remain (documented; `mainbus uninstall --purge-app` removes the copy) |
| Install scripts | Needs `electron`'s postinstall (blocked by `--ignore-scripts` and pnpm's default; binary then missing) | None; download at run time | **None.** npm resolves the platform package without scripts |
| Supply chain | Trusts npm, `electron`, `@electron/get`, GitHub | The launcher downloads and runs executables; integrity depends on a hash the launcher verifies, which must not come from the same channel as the file | Everything from the npm registry: sha512 integrity in the lockfile, provenance on every package. No second host |
| Publish effort | Low | Medium (GitHub Releases + npm) | Highest: N+1 packages in lockstep, a CI matrix |
| Verdict | Not recommended: can't be a signed Mainbus app | Good fallback | **Recommended** |

References: Electron installation <https://www.electronjs.org/docs/latest/tutorial/installation> (fetched: binary is downloaded from GitHub by `@electron/get`, cached per OS, mirrors via `ELECTRON_MIRROR`); `@electron/get` <https://github.com/electron/get>; esbuild's platform packages <https://github.com/evanw/esbuild/tree/main/npm/esbuild>; Claude Code's `@anthropic-ai/claude-code` (registry: eight `@anthropic-ai/claude-code-<os>-<arch>[-musl]` optional dependencies, each with `os`/`cpu`, a `postinstall` of `node install.cjs`, `engines.node >=22`); npm `os`/`cpu`/`optionalDependencies` <https://docs.npmjs.com/cli/v11/configuring-npm/package-json>; Electron code signing <https://www.electronjs.org/docs/latest/tutorial/code-signing>; Gatekeeper <https://support.apple.com/en-us/102445>.

Note Claude Code itself keeps a `postinstall` that links the binary; Mainbus can avoid any script by having the launcher resolve and extract at run time.

### Why (c) over (b)

- Integrity and trust come from one channel with attestation: npm's hash and provenance. In (b), a flaw in the download or checksum logic is a remote-code-execution path.
- It works offline, behind mirrors, and with `--ignore-scripts`.
- (b)'s advantage is small published artefacts and simpler CI. It stays as the **fallback** for `--omit=optional` and unsupported platform/libc combinations.

## 2. Package name

- `mainbus`: **404 on the registry** (2026-11-19), so unclaimed. `mainbus-app`, `@mainbus/cli` and `@mainbus/darwin-arm64` also 404, but a 404 for a scoped *package* doesn't show the *scope* is free: an org or user can own `@mainbus` with no packages.
- The user must check <https://www.npmjs.com/org/mainbus> and either create the `mainbus` org (free for public packages) or pick another scope. Publishing a first version soon reserves the unscoped name; only a real publish proves npm accepts it (its similarity rules can reject names too close to existing ones).
- Fallback if the scope is taken: unscoped platform packages (`mainbus-darwin-arm64`), as esbuild's older layout did.

## 3. The existing CLI

- Today `vite.cli.config.ts` builds `out/cli/mainbus.cjs`, one self-contained CommonJS file (all dependencies bundled, only Node builtins external, target `node22`). The stable install runs it on the app's own `Mainbus.exe` in Node mode (`ELECTRON_RUN_AS_NODE`). It talks to the running app over the intake protocol and never starts the app (`scripts/mainbus.cmd`).
- Under npm there is always a Node, so the CLI runs on plain `node`. Put `mainbus.cjs` **in the main package** and make `bin/mainbus.js` dispatch:
  - `mainbus` / `mainbus app` → ensure the app is extracted, then launch it detached;
  - `mainbus ticket ...`, `mainbus mcp` → the existing CLI, unchanged.
- One package gives one command and one version. "Connect agents" snippets can become plain `mainbus mcp` on PATH (`npx mainbus mcp` would cost a registry round trip on each agent start; prefer a global install for agents).
- Version skew: a global CLI may talk to an older app still running. Add a version to the intake handshake and a clear mismatch error (not checked in detail whether one exists; none seen in `protocol.ts`).

## 4. Data home and coexisting versions

- Data home (`src/engine/home.ts`): `MAINBUS_HOME`, else `%LOCALAPPDATA%\Mainbus`, else `~/.mainbus` (#126 §2 may move macOS/Linux to platform folders). The launcher must reuse `resolveHome`, not its own logic.
- Extract the app **inside the home**, `<home>/app/<version>/`, with `current.txt`: the layout `build-stable.ps1` already uses. A user-writable stable path suits a signed macOS app, survives `npm uninstall`/reinstall, and lets Windows keep a running exe while a new version is extracted beside it. Keep the last 2–3 versions.
- Single instance: `app.requestSingleInstanceLock()` keeps its lock in `userData`, which the app sets to `<home>/electron`. So an npm build and a desktop build that share a home also share the lock: the second launch just focuses the first window. Good for avoiding two writers on one SQLite file; whichever version starts first wins.
- Risk: `src/engine/db/open.ts` backs the DB up before migrating, but I found **no downgrade guard**. An older npm version run on a DB a newer build already migrated could misbehave. Add a "database is newer than this app" refusal naming the needed version.
- Dev builds use the separate `-dev` home; npm installs are always stable mode.

## 5. Updates: `npx mainbus@latest` vs in-app

- No updater exists today. **Don't add `electron-updater`**: two updaters would fight over `<home>/app/` and `current.txt`.
- npm is the single update path: `npx mainbus@latest` always gets the newest (`npx` caches, so `@latest` matters); global installs use `npm i -g mainbus@latest`, wrapped as `mainbus update`.
- The app may check the registry once a day and show "version X is available: run `mainbus update`". It never replaces itself. The notice should be off for builds not installed through npm (the launcher can set a marker such as `MAINBUS_INSTALL=npm`).
- Source-built stable Windows users keep `build-stable.ps1`.

## 6. Publishing pipeline

1. On a `v*` tag, a CI matrix (`windows-latest`, macOS arm64, `ubuntu-latest`, and later Intel macOS and Linux arm64) builds with electron-builder (`dir`), signs, notarises on macOS, archives the app, and packs `@mainbus/<os>-<arch>`.
2. A final job publishes the platform packages first, then `mainbus` (its `optionalDependencies` pin the exact same version), then creates the GitHub Release with the archives and `SHASUMS256.txt` (the fallback download).
3. **Provenance and credentials:** npm **trusted publishing** (OIDC) <https://docs.npmjs.com/trusted-publishers>. From the docs: npm CLI ≥ 11.5.1 and Node ≥ 22.14, `id-token: write`, GitHub-hosted runners only, the exact workflow file name (with `.yml`) entered on npmjs.com for each package, and `package.json` `repository.url` matching the repo. Provenance is generated by default for a public repo and public package. It doesn't remove tokens by itself: enable "Require two-factor authentication and disallow tokens" on each package. A new package must exist before a trusted publisher can be configured, so publish the first version by hand with 2FA.
4. **Versioning:** one lockstep SemVer (`0.x` for now). The app's `package.json` is `private: true` with no `bin`/`files`/`engines`/`repository`; generate a separate published `package.json` under `packaging/npm/`. Use `latest` for releases and `next` for pre-releases; fix forward and `npm deprecate` bad versions.
5. Publish only from GitHub-hosted runners on the tagged commit.

## 7. Requirements and first-launch checks

- Node: `engines.node >=22` (as Claude Code; the CLI bundle targets node22). The app uses Electron's own Node; Node matters only for launcher and CLI.
- Claude Code: Mainbus already runs `resolveClaude`, `claude --version` and `claude auth status`. Show a first-launch checklist when `claude` is missing or logged out, linking <https://code.claude.com/docs/en/setup>; check `git` too. The launcher can print the same hints in the terminal, where an `npx` user is looking. A terminal launch inherits the user's PATH, which softens #126 §3's GUI-PATH problem.
- Unsupported os/cpu/libc (musl, 32-bit): a clear error. Linux needs a desktop session and GTK/NSS libraries; no display (SSH, CI): say so and exit.

## 8. Security

- **No install scripts** in any package; platform choice is by npm, extraction by the launcher at run time. Works under `--ignore-scripts` and pnpm's default.
- **Integrity:** npm verifies sha512. The main package pins each archive's SHA-256 in a manifest; the launcher checks it before extracting and re-checks the cached copy when asked, so tampering is detected.
- **Fallback downloader (b):** HTTPS only, fixed host and path, version taken from the launcher (never "latest"), hash from the launcher (never from the release), mismatch is fatal, off-host redirects refused, `MAINBUS_NO_DOWNLOAD=1` to disable.
- **Account and CI:** 2FA, trusted publishing with tokens disallowed, a protected GitHub `release` environment with approval, actions pinned by SHA, tag protection; signing secrets only in that environment.
- **Signing stays the real trust anchor** for the app itself, independent of npm.

## 9. Open questions I could not settle

- Whether `npm pack` keeps `.app` symlinks and modes (assumed not, hence the archive); cheap to confirm in ticket 1.
- Real archive size per platform. Exclude the SDK's bundled `claude` (~288 MB, #126 §7) first, or every package grows by that much. npm has no published hard size cap, but very large packages publish slowly and some mirrors refuse them.
- Antivirus heuristics may still flag a new unsigned Windows exe even without Mark-of-the-Web. Sign it.
- Intel macOS, Linux arm64, musl: skip until asked.

## 10. Phased plan: proposed change tickets

Assumes #126's early phases (the app runs and builds on each OS) have landed; tickets 1–3 can start on Windows alone.

### Phase 0: groundwork

**1. Spike: prove the packaging approach**
- Scope: build with electron-builder (`dir`) on Windows, zip it into a throwaway platform package, `npm i -g` it from a local tarball, extract and launch. On a Mac if available, test `npm pack` with a real `.app` (symlinks, modes, signature). Measure sizes, with and without the SDK's `claude`.
- Criteria: a short write-up in `docs/` with tarball size, extraction time, whether an unpacked `.app` survives `npm pack`, and the chosen archive format.

**2. Exclude the SDK's bundled `claude` from the packaged app (skip if #126 already did)**
- Scope: a `files` exclusion in `electron-builder.yml`; confirm the app still starts agents through `pathToClaudeCodeExecutable`.
- Criteria: package shrinks by about 288 MB; an agent run still works.

**3. Database-newer-than-app guard and intake protocol version**
- Scope: refuse to open a DB migrated by a newer app, naming the version; add a protocol version to the CLI↔app handshake with a readable mismatch error.
- Criteria: unit tests with a temporary `MAINBUS_HOME` for both refusals; unchanged behaviour when versions match.

### Phase 1: launcher and CLI package

**4. `mainbus` package skeleton: `bin`, CLI dispatch**
- Scope: `packaging/npm/` with its own `package.json` (`name`, `version`, `bin`, `engines`, `optionalDependencies`, `files`, `repository`), `bin/mainbus.js` dispatching `app` to the launcher and `ticket`/`mcp` to `mainbus.cjs`; a build step copying `out/cli`. No install scripts.
- Criteria: `node bin/mainbus.js ticket list` works against a running dev app; `npm pack` contains only intended files; installs under `--ignore-scripts`.

**5. Platform resolution, extraction and launch**
- Scope: map os/arch/libc to `@mainbus/<os>-<arch>`, verify the pinned SHA-256, extract to `<home>/app/<version>` through `resolveHome`, write `current.txt`, keep the last 3, launch detached; clear errors for unsupported platforms and missing display; `mainbus uninstall [--purge-app]`.
- Criteria: unit tests for platform mapping and extraction in a temporary home; a second launch reuses the extraction; a corrupt archive is detected and re-extracted.

**6. GitHub Releases fallback download**
- Scope: used only when the platform package is absent; fixed host and path, pinned version and hash, `MAINBUS_NO_DOWNLOAD`.
- Criteria: tests against a local HTTP server: hash mismatch aborts, an off-host redirect is refused, success extracts.

**7. First-launch checks and the update notice**
- Scope: checklist for `claude` / login / `git` in the app and a terminal hint from the launcher; a daily "update available" notice (off when not installed via npm); `mainbus update`.
- Criteria: tests for each state (missing, logged out, fine) using FakeRuntime; the notice never replaces files.

### Phase 2: release pipeline

**8. Per-platform CI build and package job**
- Scope: matrix workflow producing signed archives and `@mainbus/<os>-<arch>` tarballs as artefacts; `npm publish --dry-run`.
- Criteria: each tarball installs and launches on a clean runner (smoke test); sizes reported.

**9. Publish workflow: trusted publishing, provenance, GitHub Release**
- Scope: tag-triggered workflow with `id-token: write` and an approval environment; platform packages, then main, then the GitHub Release with archives and `SHASUMS256.txt`; release docs.
- Criteria: a `next` pre-release publishes with provenance; `npm i -g mainbus@next` then `mainbus` works on each OS; tokens are disallowed on the packages.

**10. Documentation**
- Scope: README install section (`npx mainbus`, `npm i -g mainbus`, requirements), Connect-agents text for `mainbus mcp`, uninstall and data-home notes, the marketing site.
- Criteria: `pnpm site:check` passes; a fresh-machine walk-through is documented.

## 11. What the user must provide or decide

1. **npm account and name:** claim `mainbus` (publish a first version soon), decide the scope (create the `@mainbus` org or choose another; check <https://www.npmjs.com/org/mainbus>), turn on 2FA.
2. **Public repository:** provenance needs a public repo and package; confirm the repo (`github.com/artjumble/mainbus`) will be public by the first release.
3. **Trusted-publisher setup** on npmjs.com for each package after the manual first publish, then disallow tokens.
4. **Signing identities:** an Apple Developer ID (paid) with notarisation credentials, and a Windows code-signing certificate or service. npm distribution works without them, but first runs on macOS and Windows then rely on unsigned behaviour (#126 §8).
5. **First platforms to publish:** suggest win32-x64, darwin-arm64, linux-x64; say whether Intel macOS, Linux arm64 or musl matter.
6. **Update policy:** confirm npm is the only update path (recommended) and whether the in-app "update available" notice is wanted.
7. **Licence notices:** the repo is MIT; keep Electron's and Chromium's bundled licence files in the archive.
