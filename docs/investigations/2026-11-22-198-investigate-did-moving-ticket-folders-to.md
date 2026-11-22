> **Investigation #198:** Investigate: did moving ticket folders to the Dev Drive (H:\bus, from #195 on) speed up tests, builds and installs?
> **Date:** 2026-11-22 · **Status:** report, recommends but doesn't authorize changes
> **The question (the user's words):** make a note that I setup the dev drive before starting 195. I am interested in how this affects performance.
> 
> create the investigation ticket

# Did moving ticket folders to the Dev Drive speed up tests, builds and installs?

## Question
From #195 (started 2026-11-21 10:46 local) mainbus ticket folders live on a Windows Dev Drive (`H:\bus\work\mainbus`). Before that they lived on C: (NTFS). Did the move change how long agents' commands take?

## Short answer
**Yes for installs and the setup step (about 10x faster) and for the CPU-and-disk-heavy unit suite and typecheck (about 25–40% faster in a controlled run, only about 5–13% in the real ticket data). No measurable change for the full e2e suite or for git.** The controlled run is the more reliable number. The ticket data is noisy.

## What I looked at
- A read-only copy of the Mainbus database. I replayed each ticket's stored events through the app's own `runBreakdown` (the code behind the Time report) and also took raw tool-call to tool-result durations. I used the mainbus workspace only.
- 11 mainbus tickets on H: that have reached Review (#195–#197, #199–#206). #198 (this ticket) and #207/#208 aren't included.
- Baseline group (C:): tickets #185–#194 (the 10 before the switch; the ticket's baseline covers the last 20).
- A controlled benchmark, `pnpm store path`, volume type and Defender state.

## Before and after, per command
Durations are call to result in seconds. "Median" is more trustworthy than "mean" because one-off outliers (permission waits, a failing run) are common. n is the number of calls.

| Measure | C: before | H: after | Change |
|---|---|---|---|
| Setup step (`pnpm install` in new ticket folder), median | 22.8 s (n=20, tickets #175–#194) | **2.2 s** (n=13, #196–#207); #195 took 23.6 s because it filled the new H: store | **about 10x faster** |
| Full unit run (`pnpm typecheck; pnpm test` and `pnpm test`), #185–#194 vs #195–#206, clean runs only | median 228 s, mean 245 s (n=7; one 373 s outlier) | median 217 s, mean 213 s (n=8) | about -5% (median) to -13% (mean) |
| Full unit run, all calls from #171 on | median 265 s (n=29) | median 195 s (n=10) | -26%, but the C: group includes runs from before the suite speedups (#162–#168) landed, so it overstates |
| Full `pnpm e2e` (clean runs) | median 172 s, mean 184 s (n=11) | median 175 s, mean 181 s (n=8) | **no change** |
| Related tests (`vitest related`) | median 111 s (n=22) | median 65 s (n=6) | looks faster, but n is small and C: includes old runs; weak evidence |
| Single spec / single file runs | e2e spec 22.6 s, vitest files 10.5 s | 19.3 s, 13.8 s | no clear change |
| `pnpm typecheck` alone | median 11.2 s (n=40) | 9.7 s (n=5) | about the same |
| Build (`pnpm build`) | 3 calls, about 2 s | 1 call, 2 s | too few to say |
| Git (per command) | median 0.8 s (n=132) | 0.8 s (n=61) | **no change** |

Baseline figures from the ticket (`pnpm test` about 4.2 min, e2e about 3.1 min each, setup 27 s, git 19 s per ticket) match what I measured on C: (unit about 4 min, e2e about 3 min, setup about 23 s).

### Things that could skew these numbers
- **Concurrency.** #195–#206 were created within about 18 minutes, so up to about 11 agents were running at once on a 24-thread machine, and the Mainbus orchestrator and other Claude processes also load it. I measured how many other heavy calls (tests, builds, installs) overlapped each call: about 0.7–0.85 on average in both groups, so the load looks similar. Individual runs still swing a lot (H: unit runs ranged 157–327 s).
- **Suite size and speedups.** The unit suite was already sped up by #162–#168 and the e2e workers by #167 before the baseline. Since 2026-11-20 only two commits touched `package.json`/vitest/playwright config (a settings UI change and the Archive feature), so there is no test-runner change that would explain the difference. The suite did grow with each merged ticket (it is now 289 files and 5,561 tests), which would make the H: numbers look worse, not better.
- **Failing runs, retries and permission waits** (for example #200's 327 s run, and #194's and #188's long runs) inflate means. I used medians and excluded calls over 30 minutes and under 20 s from the clean-run comparison.
- Setup step: each ticket's setup duration is recorded exactly, so that comparison is solid.
- Not compared: ticket totals and time to Review, as the ticket asked.

## Controlled timing (same commit `0190b0e`, throwaway clones, 3 rounds, C: then H: in each round)
Each clone was made with `git clone --no-hardlinks`. Before each timed step `node_modules` was deleted. Clones: `C:\Users\steve\mainbus198-bench-c` (NTFS) and a folder under `H:\bus\scratch` (ReFS). Both were deleted afterwards. Every run passed (288 test files, 5,561 tests). I didn't touch the user's own checkout or data home.

| Step | C: runs (s) | C: median | H: runs (s) | H: median | Faster on H: |
|---|---|---|---|---|---|
| `pnpm install --frozen-lockfile` | 26.4, 24.0, 22.2 | 24.0 | 5.0, 2.2, 2.2 | 2.2 | about 11x |
| `pnpm typecheck` | 45.7, 34.7, 15.0 | 34.7 | 20.7, 10.8, 10.4 | 10.8 | about 3x (best runs: 15.0 vs 10.4, -31%) |
| `pnpm test` (full unit) | 371.0, 255.8, 273.5 | 273.5 | 252.7, 176.3, 154.8 | 176.3 | -36% (best runs: 255.8 vs 154.8, -39%) |

Caveat: the machine was busy with other agents during the runs (that is why round 1 is slowest on both drives), but runs alternated C:/H: within each round so load hit both sides similarly. This test cannot separate the file system (ReFS vs NTFS) from Defender's Dev Drive treatment; it measures the whole Dev Drive setup versus the default NTFS C: drive.

## pnpm store
`pnpm store path` run from a folder on H: gives **`H:\.pnpm-store\v3`**. From a folder on C: it gives `C:\Users\steve\AppData\Local\pnpm\store\v3`. pnpm 9.5 picks a store on the same volume as the project, so packages on H: are linked from an H: store (not copied across drives), and no `store-dir` setting is needed. The first ticket on H: (#195) paid a cold fill (23.6 s setup); since then installs take about 2 s. The cost is a second copy of the packages on disk, one store per drive. The much faster install is most likely the Dev Drive's block cloning plus an H: store that is the same volume, though I did not test them separately.

## Defender / Dev Drive state
H: is **ReFS**, about 100 GB (95 GB free); C: is NTFS. `fsutil devdrv query` needs admin, so I couldn't confirm the "trusted Dev Drive" flag. `Get-MpPreference` shows real-time monitoring on and `PerformanceModeStatus = 1`. I'm not sure whether 1 means "enabled" or "disabled" in this Windows version, so I'm not drawing a conclusion from it. Running `fsutil devdrv query H:` from an elevated prompt would settle it.

## Conclusion
- **Faster:** installs and setup (22.8 s to 2.2 s median) — a clear win, and a per-ticket saving of about 20 s. Full unit suite and typecheck: about 36% and about 3x faster in the controlled run, but only about 5–13% faster in the real ticket data, because of concurrency noise and because the C: group wasn't clean.
- **No change:** full e2e (about 175 s on both) and git (0.8 s). E2E is dominated by Electron/Playwright start-up and CPU time rather than file I/O, and git on small repos is already fast.
- Overall, expect a saving of roughly 20 s of setup plus 10–60 s on each full unit run per ticket; the effect on time to Review is small next to model and waiting time.
- Caveats: only 11 tickets on H: so far, uneven machine load, and no way here to separate ReFS from Defender's Dev Drive handling.

## Recommendations
1. **Nothing to change for pnpm.** The store is already on H:, so packages are linked. Don't set `store-dir`.
2. **Keep ticket folders (and agents' scratch, already on `H:\bus\scratch`) on the Dev Drive.**
3. **Consider moving your own checkout** (`C:\Users\steve\Projects\mainbus`) to H: if you run the full unit suite or installs yourself; the controlled run suggests it would speed those up the same way. Only do this if you want to; the e2e suite won't benefit.
4. **Watch the 100 GB size of H:.** Each ticket folder holds its own `node_modules` (links into the store), and there are two package stores now.
5. **Re-check in a week** with 25+ H: tickets, or run the controlled timing again when the machine is quiet, to firm up the unit-suite number.
6. Optional: confirm the Dev Drive is "trusted" with `fsutil devdrv query H:` as admin.

No code was changed; the branch has no edits besides this report.
