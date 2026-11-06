> **Status:** proposal from investigation #73 (2026-11-06), not yet decided or scheduled.
>
> **Question:** how Mainbus instances on different computers could share tickets, so a ticket created on one shows on the others, only one instance works it, and its state shows everywhere.
>
> Line references are to the code as it was on 2026-11-06.

# Sharing tickets between Mainbus instances on different computers

**Short answer:** the best fit is **the repo's own git remote as the shared store**: a hidden ref, `refs/mainbus/board`, that Mainbus writes with git plumbing and pushes and fetches with the user's own git login. A push without force works as an atomic compare-and-swap, so it gives a real claim on a ticket and unique ticket numbers. It needs no new account or service and doesn't require GitHub. **The big caveat: this repo is public** (`gh repo view` says `PUBLIC`), and anything in that ref can be fetched by anyone. Each board therefore needs a private remote: either the repo itself is private, or the board goes on a separate private "board remote".

No code was changed. The only files written were throwaway test repos in the scratch folder, and the worktree is clean.

---

## 0. What the code has today (the seams)

- **There is no `source` or `external_id` column, and no ticket adapter interface.** The `tickets` table (`src/engine/db/schema.ts:49-81`) has neither. "Source: Local" in the ticket view is a fixed string (`src/renderer/src/ticket/TicketView.tsx:68`). The `source` that does exist in the code is `IntentSource` (`src/shared/domain.ts:143`): which local agent filed an intent entry. It has nothing to do with where a ticket lives. The seam named in §2/§6 of the design is still to be built.
- **Ticket numbers** are `max(number)+1` per workspace, taken inside the insert (`src/engine/store/tickets.ts:149`, again at `:171` for promotions), with a unique index on `(workspace_id, number)` (`schema.ts:80`). `number` is `NOT NULL`.
- **Branch and folder names use the number:** `mainbus/<n>-<slug>` and `<n>-<slug>` (`src/engine/git/worktrees.ts:57-58`). If two machines picked the same number, their branches would clash on the shared remote and in pull requests.
- **Workspaces are matched by repo path only:** `openWorkspace` uses `samePath` on `repoPath` (`src/engine/index.ts:340`). The workspace record has no remote URL.
- **Where tickets are created:** `createTickets` (`index.ts:447`), used by the New Ticket form, agent intake and confirmed proposals. **Promote doesn't go through it:** it calls `repos.tickets.createPromoted` directly (`index.ts:547`). A sync hook has to cover both.
- **Where work starts:** `TicketRunner.startNow` (`src/engine/runner/ticketRunner.ts:838`). Start, confirmed proposals, drags and unattended mode all reach it. Unattended mode starts "the lowest-numbered Ready ticket" (`unattended.ts:49`), so **two machines in unattended mode would both pick the same ticket**. Some kind of claim is required.
- **State is derived locally** from runs, decisions and whether the process is alive (`src/engine/state/currentState.ts:29`). A machine that isn't running a ticket has none of those inputs, so for a ticket worked elsewhere it has to show a state that the owning machine published.
- **Pushing already has a precedent:** `PullRequestPublisher` pushes only the ticket's own branch, never with force, using the user's credential helper and `gh` login, with `GIT_TERMINAL_PROMPT=0` (`src/engine/git/pullRequests.ts:11,73`). §8 of the design still says "the engine never pushes", which is already out of date.
- **"`MAINBUS_HOME` never in a synced folder"** is a rule; nothing in the code checks it (`src/engine/home.ts`, `db/open.ts`).

## 1. The options

### A. git as the shared store (hidden refs in the repo)

**How it works**
- The board lives on one ref, `refs/mainbus/board`. Its tree holds:
  - `meta.json`: share id and format version;
  - `counter.json`: the next number;
  - `tickets/<n>/ticket.json`: title, spec, criteria, labels, kind, manual column;
  - `tickets/<n>/intent.jsonl`: the user's words, append-only;
  - `tickets/<n>/claim.json` and `tickets/<n>/state.json`;
  - `machines/<id>.json`.
- Mainbus builds commits with plumbing (`hash-object`, `mktree`, `commit-tree`) and runs `git push origin <sha>:refs/mainbus/board`. It never touches the user's working tree or index.
- Every change is an engine *operation*: Mainbus fetches, applies the operation to the latest tree, and pushes. If the push is rejected, it fetches and applies the operation again.
- Other machines poll `git ls-remote origin refs/mainbus/board`, which is cheap, every 30–60 s and fetch when the value changes. They also check when the window gets focus and right before a claim.

**What I checked** with local bare repos:
- A custom ref pushes and fetches.
- Two machines pushing competing "claim" commits on the same parent: the first was accepted and the second was **rejected ("fetch first") without any force**. The server checks the old value, so this is a true compare-and-swap.
- A fresh `git clone` fetched none of the `refs/mainbus/*` refs, so the user's normal fetches and clones aren't cluttered.
- The working tree stayed untouched.

Prior art: git-bug keeps issues under `refs/bugs/` and pushes them to GitHub.

**What it needs**
- A remote that every machine can push to. GitHub, GitLab, a self-hosted server or a bare repo on a NAS all work.
- The user's existing git login. `gh` isn't needed.

**Effort:** medium, about 6–8 tickets (plan in §9).

**Failure modes**
- **Privacy.** On a public repo, anyone who knows the ref name can fetch every ticket, including the user's words and local paths such as `IntentSource.cwd`. Fix: require a private remote, or a separate private board remote.
- **Offline.** Changes wait in a durable outbox, creates wait for a number, and claims are refused (§6).
- **Credential prompts.** Git Credential Manager can show a GUI prompt during background polling. Use `GIT_TERMINAL_PROMPT=0`, back off after an auth failure and show a banner, never prompt in a loop.
- **Hosts that refuse custom refs** (possible on some Gerrit or enterprise setups). Fall back to an orphan branch `mainbus/board`. It works the same way, but it shows in the branch list and can trigger CI on push.
- **History grows forever,** because there is no force push. The JSON is small and the growth is fine for years. A new ref "generation" can start later if needed.
- **Latency of 30–60 s** from polling. Excessive git traffic could get throttled, so check with `ls-remote` before fetching.

**Non-goals:** this isn't "GitHub or GitLab sync": no tracker, and it works on any git remote. It is **borderline on "any hosted or cloud component"**. Mainbus runs no service, but the data does sit on the user's existing remote host. The design should say plainly that this is allowed.

### B. GitHub Issues (or another tracker) through `gh`

**How it works**
- One issue per ticket, created with `gh issue create`. The issue number becomes the ticket's `external_id`.
- Labels such as `mainbus`, `mainbus:in-progress` and `mainbus:claimed:<machine>` carry the state. A Projects v2 Status field could do it instead, but that needs `gh auth refresh -s project`.
- Intent additions become comments.
- Mainbus polls `gh api` with ETag conditional requests (a 304 doesn't count against the rate limit).

**What it needs:** GitHub, a signed-in `gh`, and issues enabled on the repo (they are).

**Effort:** high, about 8–10 tickets, plus ongoing work handling edits made on github.com.

**Failure modes**
- **No compare-and-swap on writes.** Issue PATCH doesn't support `If-Match`, so two label changes race. A claim has to be done as an ordered log: post a claim comment carrying a nonce, read the comments back, and the earliest unreleased claim wins. A loser may have started briefly.
- **For one user, the assignee doesn't identify the machine.** Both machines use the same login.
- **Numbering collides with existing tickets.** Issues and PRs share one sequence, and the latest is #67, so GitHub's next issue is #68. Local ticket #68 already exists, which breaks the unique index. So the display needs a separate scheme (for example `GH-68`), or the local and shared numbers drift apart.
- **The text is external and editable.** Anyone can edit the issue body or comment on github.com, and on a public repo that includes strangers. That breaks "nothing ever edits intent", and it opens a prompt-injection path into agents, which treat the ticket as first-party instructions. Mainbus would have to keep its own copy of the intent and filter by author.
- **Public repo:** every ticket is public, and visibly so.
- **Offline:** creating a ticket is impossible.
- Labels clutter the issue tracker, secondary rate limits apply to creating content, and the whole thing only works on GitHub (GitLab would need a second adapter through `glab`).

**Non-goals:** **squarely crosses "GitHub or GitLab sync".** This is the case the `source`/`external_id` seam was meant for, and it is worth doing as an import/export adapter later. It is a poor substrate for claims.

### C. A synced folder (OneDrive, Dropbox) with an append-only log

**How it works**
- A shared folder, chosen per machine because its path differs on each one, holds `<share>/events-<machineId>.jsonl`.
- Each machine appends only to its own file, writing to a temp file and then renaming. Having a single writer per file avoids the sync client's conflict copies.
- Every machine reads all the files and folds them into state.
- The DB never goes in the folder.

**What it needs:** the same sync provider on every machine. No network code in Mainbus.

**Effort:** medium, about 5–7 tickets, but with weak guarantees.

**Failure modes**
- **No atomic operation at all,** so a claim can't be exclusive. Two machines can claim within the sync delay (seconds to minutes, unbounded if sync is paused). A deterministic rule on merge (earliest claim time, then machine id) picks a winner, and the loser must pause its agent. That wastes work, but a double push of the same branch is still rejected because pushes are never forced.
- **Numbering has the same race.** Use per-machine prefixes or number ranges (§4).
- **The sync client's own problems:** placeholder files (Files On-Demand), conflict copies if a file is ever written twice, half-synced files, paused sync, and deletes that propagate.
- It is close to the forbidden "DB in a synced folder" in spirit. The safeguard is that the log is an export, never the DB.

**Non-goals:** uses a cloud service but runs none, so borderline in the same way as A. Multiple users would need a folder shared between accounts.

### D. A small server or hosted database

**How it works**
- A Mainbus sync service, or a hosted Postgres or SQLite (Supabase, Turso, Cloudflare D1 and the like).
- Real transactions do the claim: `UPDATE … SET owner=? WHERE id=? AND owner IS NULL`. A sequence assigns numbers.
- A websocket or realtime push makes changes appear instantly.
- A variant: one Mainbus machine acts as a hub on the LAN or over Tailscale.

**What it needs:** an account or host, a URL, and **a credential Mainbus stores**. It isn't a Claude credential, so it doesn't break the anti-goal, but it is a new secret, against the "user's own logins" approach.

**Effort:** very high. Server, schema, auth, deployment, client, outbox, and keeping server and client versions compatible.

**Failure modes**
- The server is down or unreachable, which means the same offline handling as A anyway.
- An internet-facing endpoint to secure and pay for.
- Two codebases to migrate in step.
- With the hub variant, nothing syncs when the hub machine is off.

**Non-goals:** **crosses "any hosted or cloud component" explicitly,** and it is the natural road to "multiple users".

### E. Direct peer-to-peer on the same network

**How it works**
- Discovery over mDNS. Pairing with a one-time code, then TLS with pinned keys.
- Each instance keeps per-origin append-only logs and asks each peer for "events from origin X after seq N" (a version vector). Alternatively a CRDT library (Automerge, Yjs) handles the ticket documents.

**What it needs:** both machines on and on the same network, a listening port and a firewall rule.

**Effort:** very high.

**Failure modes**
- A laptop away from home doesn't sync at all, and updates spread only while both machines are up.
- A claim needs every peer to agree. With a peer offline you either refuse (unavailable) or risk a double claim (a network split).
- The Windows Firewall prompt, mDNS blocked on some networks, and a new network attack surface: today intake is a local named pipe only.
- Bugs in the replication protocol.

**Non-goals:** crosses neither hosted nor GitHub sync. Multiple users would add pairing between people.

### Comparison

| | A. git refs | B. GitHub Issues | C. Synced folder | D. Server or DB | E. Peer-to-peer |
|---|---|---|---|---|---|
| Needs | a git remote; the user's git login | GitHub and `gh` | the same sync app on every machine | a service, plus a stored credential | both machines online on one network |
| Effort | **Medium (6–8 tickets)** | High (8–10) | Medium (5–7) | Very high | Very high |
| Claim primitive | **Atomic** (push rejected if not fast-forward) | None; ordered comments | None; merge rule after the fact | Atomic (transaction) | Agreement of every peer |
| Latency | 30–60 s polling | 30–60 s polling | Depends on the sync app | Instant | Instant on the LAN |
| Offline creation | Yes, numbered when back online | No | Yes | Yes, numbered when back online | Yes |
| Private by default | Only on a private remote | Only on a private repo | Yes | Depends on the host | Yes |
| Crosses v1 non-goals | Borderline: uses an existing host | **GitHub sync** | Borderline: cloud sync | **Hosted component** (and, if shared, multi-user) | No |

## 2. What gets shared

| Field | Shared? | Why |
|---|---|---|
| Title, kind, spec, labels, criteria (text and ticks) | **Essential** | This is the ticket. |
| The user's words (`intent`), append-only | **Essential** | The acceptance bar. Each entry needs an id so that merging is a de-duplicating union. Strip or mark local paths such as `IntentSource.cwd`. |
| Manual column (Backlog, Ready, Done) | **Essential** | Any machine may move an unclaimed ticket. Once claimed, only the owner may. |
| Claim: owning machine, since when, heartbeat | **Essential** | "Only one instance works it." |
| State snapshot: column, phase, agent status, one-line summary | **Essential** | Published by the owner whenever its derived state changes, so the other machines' boards show "In progress · Implementing · on Desktop" or "Needs you: *question summary*". |
| Report (Investigate tickets), PR URL, `promotedFrom` | Useful | Results the other machine should see. The report also lets Promote work elsewhere. |
| Holds | Single user: shared. Several users: local | For one user, "don't start this" applies everywhere. |
| Attachments (images, up to 10 MB each, 20 per ticket) | Later | As blobs in the ref's tree. They stay in history for good. |
| Decisions | Local, summary only | Only the owner's agent can receive the answer, so the question summary travels in the state snapshot. |
| Thread (`agent_events`), runs, worktree, scratch folder, run settings, allow rules, stuck episodes, wakes, proposals | **Local** | Bound to the machine, its process and its lineup. Run settings refer to lineup role ids, which differ between machines. |

## 3. "Only one instance works a ticket"

The rules don't depend on the store:

- **Claim** at `startNow`, before any worktree or agent exists. That covers Start, a confirmed start proposal, a drag to In progress, and unattended mode.
  - If the claim loses, the start is refused: "Desktop is already working on this."
  - Unattended mode skips a ticket claimed elsewhere and tries the next one.
  - The orchestrator's `propose_start` refuses as well.
- **Release** happens:
  - on **Stop**, when the ticket goes back to Ready;
  - on **Done**, when the claim is closed with the ticket;
  - on an explicit **Release** ("let another computer take this"). That pushes the ticket's branch first, with the user's login and no force, so the other machine can continue from `origin/<branch>`. `WorktreeManager.ensure` would need to learn to create the worktree from the remote branch (`worktrees.ts:68` only checks local `refs/heads`).
  - A ticket in Review stays claimed: its worktree and branch are on the owner's machine.
- **A machine going away:**
  - A **per-machine heartbeat** (`machines/<id>.json`, every ~5 min while Mainbus runs) shows "Laptop last seen 3 h ago".
  - **An expired lease never moves a claim on its own.** The work, any uncommitted changes and the agent session live on that machine, and §10 already says a run is never restarted somewhere else. Instead, the expiry unlocks an explicit **Take over…**, with a warning that unpushed work stays behind.
- **The old owner coming back after a takeover:** it sees that it lost the claim and pauses its agent (never deletes the worktree). It then opens a decision: push the branch, keep the folder, or move to Done locally.
- **Two claims at once:** the store's compare-and-swap decides, and the loser learns before launching anything.
  - A and D: exact.
  - B: the earliest claim comment wins; the loser may have started briefly.
  - C: a merge rule after sync; the loser pauses.
  - E: needs every peer to agree.
- **Offline:**
  - A shared ticket can't be claimed while the store can't be reached (refuse rather than guess).
  - An owner that goes offline keeps working: its claim stands.

**Restart recovery (§10) must not change.** Recovery reads only the local DB and runs before sync starts. Sync then checks the claims of resumed runs in the background. A run whose claim was lost is paused and turned into a decision, as above. If the store can't be reached at launch, runs resume as they do today. For one user, a takeover can only have happened by their own explicit action. Importing a remote ticket never creates a run.

## 4. Ticket numbers across machines

| Option | Pros | Cons |
|---|---|---|
| **Shared counter in the store, by compare-and-swap** (A's `counter.json`, D's sequence) | `#74` means the same ticket everywhere; branch names stay unique on the remote; nothing else changes. | A number needs the store to be reachable. |
| Assigned by the store (issue number) | Free with B. | Collides with existing local numbers (next issue #68 vs local #68), and the sequence is shared with PRs. |
| Per-machine prefix (`D-74`, `L-3`) | Works offline. | `number` is an integer used by search (`#12`), `ticket show 12`, branch and folder names and the CLI. That's a schema and UI change everywhere. |
| Ranges (machine k uses n ≡ k mod m, or blocks of 1000) | Works offline, numbers stay integers. | Gaps, and the number of machines must be known up front. |
| Local numbers only, global id behind them | Nothing to coordinate. | `#74` differs per machine, and branch names clash on the remote. |

**Recommendation: a shared counter.**
- **Seeding:** when a machine joins a shared board, it bumps the counter to `max(counter, its local max + 1)` by compare-and-swap, so a new shared number can never clash with an old local ticket on any machine.
- **No new local numbers:** once a workspace is shared, every new ticket in it is shared, Promote included.
- **Offline:** a ticket created offline waits as **"Not shared yet"** with no number and can't be started until it has one, because branch names use the number. That means `tickets.number` becomes nullable, or unnumbered tickets live in an outbox table until they are published.
- A later option: let an unpublished ticket be worked offline under a branch named by its id. It is safe because no other machine can see it.

## 5. Workspace identity across machines

Today the repo path is the identity (`index.ts:340`), and the same repo sits at different paths on different machines.

Options:
1. The **normalised remote URL**. `https://github.com/artjumble/mainbus.git` and `git@github.com:artjumble/mainbus.git` both become `github.com/artjumble/mainbus`.
2. The **root commit hash**. Forks share it, so it is ambiguous.
3. A **share id kept in the store**.
4. A **file committed to the repo**. Rejected: Mainbus would be writing commits into the user's checkout.

**Recommendation:** with option A the identity is the board's location: `refs/mainbus/board` on a chosen remote, with the share id in `meta.json`.
- The user opts in per workspace with **Share this board** or **Join the board on origin**. Mainbus suggests `origin` and uses the normalised URL to detect an existing board (`ls-remote`).
- The workspace record gains `share_remote`, `share_url` and `share_id`. Paths stop mattering.
- On one machine, two workspaces can't join the same share.
- If the remote moves, the share id stays and the user updates the URL.

## 6. Offline and conflicts (option A; B, D and E are similar)

Mainbus records operations, not file diffs. A rejected push means fetch again and apply the operation again, so text merges never happen.

| Operation | Merge rule |
|---|---|
| Create | Takes a number from the counter by compare-and-swap. Offline, it waits unnumbered in a durable `sync_outbox` (like `pending_cleanup`: done or retried at the next launch, operations idempotent by id). |
| Add to the user's words | Union by entry id, ordered by time. Never conflicts. |
| Title, spec, labels | Last write wins per field, in the order the pushes landed. The overwritten value stays in the board's history. Optionally a notice: "changed on Laptop while you were editing". |
| Criteria ticks | Never unticked (as `checkCriterion` already works), so a tick merges by OR. A criteria list replaced while ticks happen elsewhere: last write wins, and an edit is refused while another machine holds the claim. |
| Manual column | Last write wins while unclaimed; only the owner while claimed. |
| Claim | Compare-and-swap. The first one wins, and nothing merges. |
| State snapshot, report | Written only by the owner. |
| Holds | Last write wins (one user). |

Other options: C needs the same rules but applies them *after* the fact, so claims and numbers can double up. B gets last-write-wins from GitHub but also edits from outside Mainbus.

## 7. One user versus several

The ask doesn't say. The recommendation (option A) holds for both, so I didn't ask.

- **One user, several machines.** This is what's covered above. Identity is the machine, through a machine id and a name the user picks (the default is the computer's name). Holds are shared.
- **Several people:** crosses the **"Multiple users"** non-goal and adds:
  - **Identity** per operation: a person as well as a machine. `git config user.email` isn't verified; on GitHub, `gh api user` is better.
  - **Trust.** Another person's words aren't "your words". Show them as "Alex's words", and don't treat them as the local user's first-party instructions without a step. That means landing in Backlog for the local user to accept, as agent intake already does. Otherwise anyone with push access can steer my agents on my subscription.
  - Decisions stay with the owner ("Waiting on Alex's laptop"). Holds become per person. Takeover needs the other person's agreement, or at least a visible record.
  - Each person runs their own Claude login. No credentials are shared, so the anti-goals still hold.

## 8. Changes needed in the design document

- **§2 non-goals:** keep "GitHub or GitLab sync". Amend "Multiple users, or any hosted or cloud component" to: *one user's machines may share a board through the repo's own git remote, or a private remote chosen for it. Mainbus runs no service, and the board needs a private remote.* Multiple users stay a non-goal unless the user decides otherwise.
- **§6 data model:**
  - `ticket.source` becomes `local` or `shared`. `external_id` holds the share's ticket id, which finally builds the seam.
  - `ticket.number` is nullable until published.
  - New fields: owner machine, published state snapshot.
  - New tables: `sync_outbox` and the remote ticket cache. New workspace share fields. Intent entries get ids.
  - An exception to "current state is derived, never stored": a ticket worked elsewhere shows the owner's published snapshot.
- **§8:** "the engine never pushes" becomes: except the ticket's own branch (PRs, already built) and `refs/mainbus/*`, never with force.
- **§10:** recovery stays local-only and runs before sync. Losing a claim pauses the run and opens a decision; it never moves the work.
- **§5:** the single-instance lock stays per machine.

## 9. Recommendation and a rough ticket plan

Recommended: **Option A, git refs on a private remote**. It fits the design's rules: state on disk, mechanics in engine code (operations and compare-and-swap, no model involvement), the user's own git login, and nothing hosted by Mainbus. B is worth keeping as a later import/export adapter, which is what the seam was meant for. D and E are far more work, and C can't give the "only one instance" guarantee.

1. **Design amendment and board format.** Update §2, §6, §8 and §10 as above. Set out the `refs/mainbus/board` layout and the operations with their merge rules.
2. **Engine sync module, no UI.** Read and write the board with plumbing, the fetch-apply-push retry loop, `ls-remote` polling with back-off, `sync_outbox` with idempotent replay, and no prompts. Tests run against local bare repos, as in this investigation.
3. **Share or join a workspace.** Choose the remote and warn if the repo is public, normalise the URL, share id, machine id and name, and seed the counter.
4. **Publish new tickets.** `createTickets` and `createPromoted` for shared workspaces, a number from the counter, "Not shared yet" while offline, and the `source`/`external_id`/nullable `number` migration.
5. **Show remote tickets.** Import into a local cache. The card and ticket view show "on Laptop" with the published state. Intake and the orchestrator see them, and field edits, intent additions and column moves sync with the rules in §6.
6. **Claims.** Claim at `startNow` (unattended mode, proposals and drags included), release on Stop and Done, per-machine heartbeat, refuse when claimed elsewhere or offline, and publish the state snapshot on `board.changed`.
7. **Takeover and a lost claim.** **Take over…** after the lease runs out, pause plus a decision on the machine that lost, and a claim check after restart recovery.
8. **Hand a ticket to another machine.** **Release** pushes the branch, and `ensure` creates the worktree from `origin/<branch>`.
9. *(Optional)* Attachments as blobs, and identity and trust for several people (§7).

Tickets 1–6 deliver the stated goal: a new ticket shows on the other computer, only one instance works it, and its state shows everywhere. Tickets 7–8 cover a machine going away and moving work between machines.
