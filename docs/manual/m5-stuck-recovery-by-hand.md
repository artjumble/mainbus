# Running the M5 stuck-recovery scenario by hand

The automated version is `e2e/m5Exit.spec.ts` (a FakeRuntime script and a fake clock). This is the same scenario against a real `claude` agent. It uses a temporary `MAINBUS_HOME` and a throwaway repository, so it never touches your stable board or data home.

## Set up

1. Make a throwaway repository:

   ```powershell
   $repo = "$env:TEMP\mainbus-m5-repo"
   git init -b main $repo
   Set-Content "$repo\README.md" "# throwaway"
   git -C $repo add .
   git -C $repo -c user.name=Me -c user.email=me@example.com commit -m initial
   ```

2. Start the dev build with a temporary data home:

   ```powershell
   $env:MAINBUS_HOME = "$env:TEMP\mainbus-m5-manual"
   npm run dev
   ```

3. Open `$repo` as the workspace (Open a repo folder).
4. Workspace settings → edit the **Implementer** role's instructions so it loops on a failing command:

   > Run `node -e "process.exit(1)"`. Whenever it fails, run exactly the same command again. Never change any file and never try anything else.

5. Create a ticket (any title and words), open it, and press **Start**. The Planner runs first; let it hand off (message it if it waits). Then the Implementer starts and loops.

## The scenario

1. **Detected.** After 5 failures in a row, the next detector check (once a minute) marks the ticket stuck. Within about a minute the ticket shows a "looks stuck" chip with the evidence, and Activity says `Implementer looks stuck: same failing command 5 times (detected by Mainbus)`.
2. **Redirect.** Message the orchestrator: "The Implementer looks stuck on ticket 1." It proposes a redirect. Confirm it. The thread shows a "Mainbus · Redirected Implementer" entry, and Activity says `Redirected Implementer: … (suggested by the orchestrator, confirmed by you)`.
3. **Detected again.** The agent keeps looping (its instructions say so). Hits are at least 5 minutes apart, so wait 5 minutes or more. Activity says `Implementer still looks stuck after the redirect: … (detected by Mainbus)`.
4. **Replace.** Message the orchestrator again. It proposes a replacement. Confirm it with **Replace Implementer**. (The **Replace…** button in the ticket view makes the same card at any time; Activity then says `suggested by you with Replace…`.)
5. **Replacement finishes.** The new Implementer gets the handoff summary in its first message. To let it finish, edit the role's instructions back to something that works, or message it to stop looping and hand off, then let the Reviewer run. The ticket reaches Review.

## What to check

- The thread shows an **Implementer replaced** divider where the new run starts, with a **Handoff from the previous run** block collapsed under it. Open it to read the generated summary.
- **View previous run** opens the old run read-only (no message box, no Stop/Pause/Replace… buttons). **← Back to the live thread** returns.
- The lineup strip shows the Implementer once, with `replaced ×1`.
- Activity has every step in order: stuck, redirect, stuck again, replacement, handoffs, each saying who suggested and who confirmed, with links to the run or proposal.
- To see the Failed outcome, replace the Implementer twice (loop again each time): when the third agent gets stuck, the ticket is marked Failed and Activity says `Implementer marked Failed: stuck again after being replaced 2 times (by Mainbus)`.

## Clean up

Close the app, then delete the temporary folders:

```powershell
Remove-Item -Recurse -Force "$env:TEMP\mainbus-m5-manual", "$env:TEMP\mainbus-m5-repo"
Remove-Item Env:\MAINBUS_HOME
```
