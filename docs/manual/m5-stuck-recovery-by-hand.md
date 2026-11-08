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
   pnpm dev
   ```

3. On the welcome screen, choose **+ Add workspace** and pick `$repo`. (With a workspace already open, use the rail's **+ Add workspace**.)
4. Workspace settings → edit the **Implementer** role's instructions so it loops on a failing command:

   > Run `node -e "process.exit(1)"`. Whenever it fails, run exactly the same command again. Never change any file and never try anything else.

5. Create a ticket (any title and words), open it, and press **Start**. The Planner runs first; let it hand off (message it if it waits). Then the Implementer starts and loops.

## The scenario

1. **Detected.** After 5 failures in a row, the next detector check (once a minute) marks the ticket stuck. Within about a minute the ticket shows a "looks stuck" chip with the evidence, and Activity says `Implementer looks stuck: same failing command 5 times (detected by Mainbus)`.
2. **Redirect.** The orchestrator wakes by itself when the detector fires, so a redirect card should appear in its panel without a message. (If none appears after a minute or so, message it: "The Implementer looks stuck on ticket 1.") Confirm the card. The thread shows a "Mainbus · Redirected Implementer" entry, and Activity says `Redirected Implementer: … (suggested by the orchestrator, confirmed by you)`.
3. **Detected again.** The agent keeps looping (its instructions say so). Hits are at least 5 minutes apart, so wait 5 minutes or more. Activity says `Implementer still looks stuck after the redirect: … (detected by Mainbus)`.
4. **Replace.** The orchestrator wakes again and proposes a replacement (message it only if no card appears). Confirm it with **Replace Implementer**. (The **Replace…** button in the ticket view makes the same card at any time; Activity then says `Suggested by you with Replace…`.)
5. **Replacement finishes.** The new Implementer gets the handoff summary in its first message. To let it finish, edit the role's instructions back to something that works, or message it to stop looping and hand off, then let the Reviewer run. The ticket reaches Review.

## What to check

- The thread shows an **Implementer replaced** divider where the new run starts, with a **Handoff from the previous run** block open under it, holding the generated summary.
- The divider reads `Implementer replaced · View previous run`.
- **View previous run** opens the old run read-only (no message box, no Stop/Pause/Replace… buttons). **← Back to the live thread** returns.
- The lineup strip shows the Implementer once, with `replaced ×1`.
- Activity has every step in order: stuck, redirect, stuck again, replacement (`Implementer replaced: <headline>`, with `Suggested by orchestrator, confirmed by you`), handoffs, each saying who suggested and who confirmed, with links to the run or proposal.
- The concurrency cap (default 3) and usage limits don't change this scenario: one ticket never queues behind itself. If a usage-limit banner does appear, the agents are paused until the time it shows, or until **Resume now**.
- To see the Failed outcome, replace the Implementer twice (loop again each time): when the third agent gets stuck, the ticket is marked Failed and Activity says `Implementer marked Failed: stuck again after being replaced 2 times (by Mainbus)`.

## Clean up

Close the app, then delete the temporary folders:

```powershell
Remove-Item -Recurse -Force "$env:TEMP\mainbus-m5-manual", "$env:TEMP\mainbus-m5-repo"
Remove-Item Env:\MAINBUS_HOME
```
