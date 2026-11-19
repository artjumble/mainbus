> **Investigation #129:** Investigate: supporting other model providers for Mainbus's agents and orchestrator
> **Date:** 2026-11-19 · **Status:** report, recommends but doesn't authorise changes
> **The question (the user's words):** create a ticket for investigating adding support for other model providers.

# Investigation #129: supporting other model providers for Mainbus's agents and orchestrator

**Date:** 2026-11-19 · **Status:** report; it recommends changes but doesn't authorise them. No code was changed.

## The question

Every Mainbus role and the orchestrator run through Claude Code, using the Agent SDK and the user's own `claude` binary and login. What would it take to support other model providers? The ticket asks what to support, how, and in what order. It covers two senses of "other providers":

1. **Claude through other routes:** Amazon Bedrock, Google Vertex, Microsoft Foundry, an Anthropic API key, and LLM gateways.
2. **Non-Anthropic models and agents:** other agent CLIs or SDKs, routing Claude Code to a non-Claude model, and a Mainbus-owned tool loop.

## Summary and recommendation

- **Claude through other routes is mostly configuration, and it is worth doing first.** The binary already speaks to Bedrock, Vertex, Foundry, API keys and gateways through environment variables and settings. Mainbus today deliberately blocks all of that (`AUTH_ENV_VARS` in `src/engine/runtime/sdkRuntime.ts:121`) so the agents always use the subscription login. The work is a provider setting, a safe way to pass credentials, model naming that survives provider-specific model IDs, and honest cost wording.
- **Routing Claude Code to a non-Claude model through a gateway: don't build on it.** Anthropic's gateway page states it "doesn't support routing Claude Code to non-Claude models through any gateway". Local models through Ollama's Anthropic-compatible endpoint do work for basic use, but with no prompt caching, no `tool_choice`, no token-count endpoint and approximate token counts. It's an experiment, not a feature.
- **For non-Anthropic models, add a second `AgentRuntime` that wraps another agent's own tool loop.** The best candidates are an ACP (Agent Client Protocol) adapter, which could cover several agents at once, and the Codex app-server. Don't write Mainbus's own loop (option c): it would mean rebuilding file tools, a sandbox, edit semantics and the permission shapes the guard understands.
- **The runtime interface needs work before a second runtime.** `AgentRuntime` is clean, but the permission guard, prompts, `resumeSessionId` and the usage/cost wording all assume Claude Code's tool names and session semantics. A hardening phase comes first.
- **Mixed lineups (for example a Planner on one provider and an Implementer on another) are feasible but need care.** Handoff is text, so it crosses runtimes. Resume does not: a session id belongs to one runtime.

**Recommended order:** Phase 1 (Claude on other routes, app-level setting), then Phase 2 (runtime hardening), then Phase 3 (a spike to choose between ACP and the Codex app-server), then Phase 4 (the second runtime), then Phase 5 (mixed lineups). The tickets are at the end.

## What I looked at

- **Code:** `src/engine/runtime/` (`types.ts`, `sdkRuntime.ts`, `normalize.ts`, `resolveClaude.ts`, `fakeRuntime.ts` and their tests), `src/shared/models.ts`, `src/engine/permissions/` (`policy.ts`, `credentials.ts`, `guard.ts`), `src/engine/stuck/`, `src/engine/store/settings.ts`, and `chooseRuntime` in `src/main/index.ts`.
- **Documentation, fetched 2026-11-19:** the URLs are listed under "Sources". Where a page didn't answer a question, the report says so rather than guessing.
- **Limits:**
  - I did not run any provider or CLI.
  - I did not read `claude-agent-sdk` source.
  - I did not read the Codex app-server protocol, which is where approvals, resume and usage would be specified (its page returned 404).
  - I did not read the ACP schema pages for MCP passing, images and usage.
  - Sizes are estimates.

## How Mainbus uses Claude Code today

| Mainbus relies on | Where | Claude Code feature |
| --- | --- | --- |
| Role tools (`ask_user`, `handoff`, `submit_report`, `report_problem`, `report_waiting`, `check_criterion`) | `createSdkMcpServer` in `sdkRuntime.ts:446`, `RoleToolHandlers` | In-process MCP server |
| Orchestrator read and propose tools | `sdkRuntime.ts:656`, `OrchestratorToolHandlers` | In-process MCP server |
| Permission guard | `canUseTool` (`:579`), `hooks.PreToolUse` (`:577`), `src/engine/permissions/*` | Permission callback and hooks; the guard recognises tool names `Bash`, `PowerShell`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit` (`policy.ts:12-13`) |
| Resume | `resumeSessionId`, `ResumeFailedError`, `usageBaseline` | SDK session resume; its usage totals carry over |
| Usage and cost | `normalize.ts` reads the SDK's per-model `modelUsage` (including `costUSD`) | The SDK's own figures |
| Effort | `effort` option, `applyFlagSettings({ effortLevel })` (`:393`) | `--effort` |
| Model list | `supportedModels()` then `roleModelOptions()` in `src/shared/models.ts` | The binary's model list |
| System prompt | `systemPrompt: { type: 'preset', preset: 'claude_code', append }` | Claude Code's preset plus an appended section |
| Images | `userMessage()` builds base64 image blocks | Anthropic message format |
| Extra folders, disallowed tools, `settingSources: ['project','local']` | `sdkRuntime.ts:514-575` | Claude Code settings |
| Summaries | `summarize()`, a one-shot with no tools | `query()` with `tools: []` |

Other findings that matter:

- **The stuck detector is provider-neutral so far.** `src/engine/stuck/` works on normalised `AgentEvent`s, and I found no model or tool-name assumptions in its normaliser or config. The permission guard is not neutral: it recognises tools by Claude Code's names.
- **Model families are hard-coded.** `MODEL_FAMILIES` is `fable/opus/sonnet/haiku`, and `MODEL_ID` (`models.ts`) parses only `claude-<family>-<major>[-<minor>][-<date>]`. Provider-specific IDs such as `us.anthropic.claude-opus-4-8` or `anthropic.claude-sonnet-5` do not match, so `roleModelOptions()` would show no version labels and no Fable on Bedrock, Vertex or Foundry.
- **Presets and defaults assume Claude aliases.** `DEFAULT_MODELS` uses `opus` and `sonnet`, and `modelAllowed` accepts only picker values or the role's own setting.
- **The "not billed on the user's Claude plan" wording** appears in the orchestrator's usage read tool (`readTools.test.ts:242` pins it). It is true only for the subscription route.
- **A project can change the provider today.** Roles load `settingSources: ['project', 'local']`, so a repository's `.claude/settings.json` can carry an `env` block. Anything that sets `ANTHROPIC_BASE_URL` there would reroute the agents. Today that is mitigated only by the env stripping, which does not cover settings files. This is worth checking whichever phase gets built (see risk R1).

## Part 1: Claude through other routes

### What each route needs

Facts below come from the Claude Code docs cited under "Sources".

| Route | Enable with | Credentials | Notes |
| --- | --- | --- | --- |
| Subscription (today) | the binary's own login | claude.ai login stored by `claude` | Cost figures are API-equivalent, not billed. The Agent SDK overview says Anthropic doesn't allow third-party developers to offer claude.ai login or rate limits for their products unless previously approved, and points to API keys instead. Mainbus uses the user's own local login, which seems different from "offering" it, but it is a point to confirm before wider distribution (R5). |
| Anthropic API key | `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`) | Key | This is the documented path for SDK-built products. Billing is per token. |
| Amazon Bedrock | `CLAUDE_CODE_USE_BEDROCK=1`, `AWS_REGION` | AWS default credential chain, profile, SSO, or `AWS_BEARER_TOKEN_BEDROCK`; settings `awsAuthRefresh` and `awsCredentialExport` | Aliases resolve to older defaults (Sonnet 4.5, Haiku 4.5), so pinning is advised. Web search, fast mode, Advisor and the analytics dashboard are unavailable. Mantle is a second endpoint (`CLAUDE_CODE_USE_MANTLE`) with its own IDs. |
| Claude Platform on AWS | `CLAUDE_CODE_USE_ANTHROPIC_AWS` | AWS | Web search works; fast mode does not. |
| Google Cloud (Anthropic managed) | `CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD` | GCP | |
| Google Vertex AI (now "Agent Platform") | `CLAUDE_CODE_USE_VERTEX` | GCP | Fast mode only for Fable 5.2. |
| Microsoft Foundry | `CLAUDE_CODE_USE_FOUNDRY` | API key or Microsoft Entra ID | Aliases resolve to Opus 4.6 and Sonnet 4.5. Tool search is not supported on Azure-hosted deployments. |
| Gateway | `ANTHROPIC_BASE_URL` (or the provider-specific `*_BASE_URL`), plus a gateway credential | Gateway credential | Feature availability follows the upstream provider. Claude Code turns off features such as Remote Control when the base URL isn't `api.anthropic.com`. A gateway that doesn't forward newer features breaks them. Setting only `ANTHROPIC_BASE_URL` without a credential keeps the subscription. |

### What Mainbus would need

1. **A provider setting.**
   - **App-level default first.** A workspace override can follow (for example, "this repository's client uses Bedrock"). A per-role override only matters for mixed lineups, which are Phase 5 here.
   - **Shape:** `{ kind: 'subscription' | 'apiKey' | 'bedrock' | 'vertex' | 'foundry' | 'gateway', region?, baseUrl?, modelPins? }`.
   - **Where it lives:** in the settings store (`src/engine/store/settings.ts`), plus a Settings section in the UI. Like other settings it needs a migration if it is stored in the database.
2. **Environment passed to the spawned `claude`.**
   - Replace "strip everything" with "strip the ambient values, then add exactly what the chosen provider needs from Mainbus's own settings". Ambient `ANTHROPIC_*`, `CLAUDE_CODE_USE_*`, `AWS_*` and similar values in Mainbus's own `process.env` must not leak in. Otherwise a developer shell's variables would silently change the provider.
   - **Where to inject:** `childEnv()` and the three `query()` call sites (roles, orchestrator, `summarize()`/`supportedModels()`). The existing env-stripping test in `sdkRuntime.test.ts:520` becomes the contract test for each provider.
3. **Credentials kept from the agents.**
   - **Storage.** Prefer references over values: an AWS profile name, `awsAuthRefresh`/`awsCredentialExport` commands, or the user's existing cloud login, so Mainbus stores nothing secret for the cloud routes. Where a key must be stored (API key, Bedrock bearer token), use the OS credential store (Electron `safeStorage` is the natural choice; I didn't verify how Mainbus stores secrets today) and never the SQLite database or settings files in plain text.
   - **Guard.** `permissions/credentials.ts` already blocks `.aws`, `.azure`, `.ssh` and similar folders and commands that print secrets, so the shared-credentials-file cases are covered.
   - **Open question:** whether an env-var credential passed to `claude` is visible to the agent's Bash tool through the process environment (`env`, `printenv`, `$env:`). I haven't confirmed whether the tool subprocess inherits it. Test it before shipping, and if it does inherit it, either extend the guard's "commands that print secrets" list to cover environment listings or prefer file/helper-based credentials. See R2.
4. **Settings-file redirect (R1).** Decide whether project and local settings may carry provider `env` blocks. Options: drop those keys, check the effective provider at start (`/status` shows it in the CLI) and refuse a mismatch, or use the managed-settings `allowedProviders` mechanism (Claude Code v2.1.285 or later, per the docs) if it fits. This needs a decision.

### Model picker and `supportedModels()` under each provider

- **What the docs say:** aliases resolve differently per provider, so pinning with `ANTHROPIC_DEFAULT_OPUS_MODEL`, `_SONNET_`, `_HAIKU_` and `_FABLE_` is advised, and `modelOverrides` maps versions to inference-profile ARNs. On Bedrock, Vertex and Foundry the `/model` picker shows no prices, and listed IDs only become picker rows if they start with `anthropic.` or are in a `modelPicker` lineup. Whether `supportedModels()` reflects the pins and the provider's real availability I did not test; a spike is part of Phase 1.
- **Mainbus impact:**
  - `parseModelId` fails for provider IDs, so version labels and the Fable lookup fail and the pickers fall back to bare aliases.
  - **Design:** extend `parseModelId` to accept the provider wrappers (`us.`/`eu.`/`global.` prefixes, `anthropic.` prefix, Bedrock `-v1:0` suffix, ARNs shown by pin name), and let the provider setting hold pins per family.
  - Keep the picker value an alias (`opus`) so saved lineups and presets keep working across providers. The resolved model is the provider setting's business.
  - Effort levels depend on the model: `xhigh` runs as `high` on Opus 4.6 and Sonnet 4.6 (per the model-configuration docs). The UI offers only low/medium/high, so no change is needed there.

### Usage, cost and the Time report

- The SDK's `costUSD` is a client-side estimate from list prices. On the subscription route Mainbus labels it "API-equivalent, not billed". On API/cloud routes it is closer to real spend, but it will differ from the provider's bill (negotiated rates, cross-region profiles, service tiers such as `ANTHROPIC_BEDROCK_SERVICE_TIER`, 1-hour cache TTL pricing).
- **Change:** make the wording depend on the provider ("estimated cost; actual billing is on your AWS account" and the like), in the orchestrator's usage tool, the Time report and the card UI. Keep the estimate rather than hiding it.
- Prompt caching is on by default, but on Bedrock it varies by model and region. Zero cache tokens would show up as higher cost, not an error.
- Tokens, turns and durations are unaffected. The usage-limit banner (`StoredUsageLimit`) is subscription-specific and should not show for API/cloud routes.

## Part 2: non-Anthropic models and agents

### Candidates

- **(a) Wrap another agent's own tool loop as an `AgentRuntime`.**
  - **Codex (OpenAI).** The TypeScript SDK (`@openai/codex-sdk`) offers `startThread`, `run` and `resumeThread`. The Python SDK drives the local **app-server** over JSON-RPC, which "handles authentication, conversation history, approvals, and streamed agent events". The standalone `codex mcp-server` has been removed. I could not read the app-server protocol page (404), so approval callbacks, injecting our own tools, images and usage events are unverified.
  - **Gemini CLI.** Open source (Apache 2.0). It has headless mode with `--output-format stream-json`, MCP servers configured in `~/.gemini/settings.json`, and API-key or Vertex auth. Its README says the free individual tier and Google AI Pro/Ultra moved to "Antigravity CLI" on 2026-06-18, so the CLI now targets Gemini Code Assist Standard/Enterprise licences. No ACP or approval-callback support was found on the page.
  - **OpenCode.** Open source (MIT per secondary sources; confirm in its repository). It supports many providers including Ollama and LM Studio, an embeddable SDK (`OpenCode.create()`, sessions, an events stream, plugins) and ACP (`opencode acp`). Per its ACP docs, clients can pass local or HTTP MCP servers when they create, load, resume or fork a session; MCP over SSE is not supported there. The SDK page did not document permissions, images or system prompts.
- **ACP (Agent Client Protocol).** A JSON-RPC-over-stdio protocol for editor-to-agent connections, with `initialize`, `session/new`, optional `session/load`, `session/prompt`, `session/update` and `session/request_permission`. A Mainbus ACP client would be one adapter reaching every agent that speaks ACP, with permission requests mapping onto our `onPermission`. I confirmed the baseline methods only. MCP passing (OpenCode docs say yes), image content, model selection and usage are not covered by the pages I read, so they are open questions for the spike.
- **(b) Claude Code routed to a non-Claude model.**
  - **Gateways:** Anthropic "doesn't support routing Claude Code to non-Claude models through any gateway".
  - **Ollama:** its Anthropic-compatible endpoint works with `ANTHROPIC_BASE_URL=http://localhost:11434` and supports tools, base64 images, streaming and thinking. It does not support `tool_choice`, prompt caching or the token-count endpoint, and token counts are approximations.
  - **Fit:** useful for a local-model experiment (all of Mainbus's tooling stays intact) but with no support from either side, and with unknowable quality of tool use. I wouldn't ship it as a provider.
- **(c) Mainbus's own loop over a provider-neutral API.** A loop plus file, search and shell tools, an edit format, context management, a sandbox, and permission shapes that the guard would have to learn. It also loses Claude Code's tuning for its own models. The largest effort and the highest ongoing cost; no benefit that (a) doesn't offer. Not recommended.

### Capability matrix

Legend: ✓ works unchanged · ~ works with changes or emulation · ✗ lost · ? not verified (reason given below the table).

| Mainbus relies on | Subscription (today) | Claude via API key / Bedrock / Vertex / Foundry | Claude via gateway | Claude Code → non-Claude via gateway | Codex (app-server / SDK) | Gemini CLI | OpenCode (SDK or ACP) | Generic ACP agent | Own loop (c) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| In-process role and orchestrator tools | ✓ | ✓ | ✓ | ✓ | ? ~ | ~ (MCP) | ~ (MCP) | ~ (MCP if the agent accepts it) | ✓ |
| Permission guard (callback + hook) | ✓ | ✓ | ✓ | ✓ | ? (approvals exist; shape unverified) | ? | ? | ~ (`session/request_permission`) | ✓ (ours) |
| Session resume | ✓ | ✓ | ✓ | ✓ | ✓ (`resumeThread`) | ? | ✓ (sessions) | ~ (`session/load` is optional) | ours |
| Per-model usage and cost | ✓ (API-equivalent) | ✓ (estimate) | ✓ | ~ (approximate counts) | ? | ? (stream-json may carry it) | ? | ? (not in the pages read) | ours |
| Effort levels | ✓ | ✓ per model | ✓ | ~ | ? | ✗? | ? | ✗? | ours |
| Image input | ✓ | ✓ | ✓ | ~ (Ollama: base64 only) | ? | ? | ? | ? | ours |
| Appended system prompt | ✓ | ✓ | ✓ | ✓ | ~ (AGENTS.md or config) | ~ (GEMINI.md) | ? | ? | ✓ |
| `supportedModels()` / model switch | ✓ | ~ (pins, IDs) | ~ | ✗ | ? | ? | ~ | ? | ours |
| Claude tool names in the guard (Bash, Edit, ...) | ✓ | ✓ | ✓ | ✓ | ✗ (own names) | ✗ | ✗ | ✗ | ours |
| No-tools one-shot `summarize()` | ✓ | ✓ | ✓ | ✓ | ~ (a thread with tools off) | ~ | ~ | ~ | ✓ |

"?" means the documentation pages I read did not answer the question. The spike in Phase 3 must settle each "?" with a working call, not a reading of docs.

### What would be lost on a non-Claude runtime

- The Claude Code preset system prompt and its tool descriptions, so the role prompts that mention Read, Edit, Bash or Grep need runtime-specific wording or neutral wording.
- Fine-grained permission shapes. The guard (`policy.ts`, `guard.ts`, `credentials.ts`) is built on Claude's tool names and input fields (`Bash` command, `file_path`, and so on). Another runtime reports different tool names and arguments, so each needs a mapping into a neutral shape, or the guard falls back to a coarser rule for it.
- Usage and effort comparability, and cost accuracy for models Mainbus has no price list for.
- The `supportedModels()`/picker contract, which needs a per-runtime model list.

## Cross-cutting areas

### Settings and model naming

- Add `runtime` as a value alongside `model` and `effort` on a role: `{ runtime: 'claude' | 'codex' | 'acp:<name>', provider?, model, effort }`.
- Model values become `<family-or-alias>` for Claude and `<id>` for others, shown with the runtime in the picker, for example "Codex · gpt-x". `MODEL_FAMILIES` stays Claude-only; other runtimes bring their own list through `supportedModels()`.
- Presets (`0032_lineup_presets.sql`) and `DEFAULT_MODELS` keep working unchanged because absent runtime means `claude`. `modelAllowed` and `setModelOptions` are global today and would become per runtime.

### Credentials and secrets

Each runtime's credentials are its own concern: Codex has its own login, Gemini an API key or Google login, OpenCode per-provider keys. The guard must cover each runtime's credential files (for example `~/.codex`, `~/.gemini`, OpenCode's auth file) in `credentials.ts`; I did not list their locations, so that is a Phase 4 task. A simple rule: Mainbus stores no secret for a runtime unless the runtime has no login of its own.

### Mixed lineups

- **Worth it?** Plausible uses are cheap or local model for Implementer work, a strong model for Planner or Reviewer, or a second vendor as an independent Reviewer. The value is unproven for this product; the infrastructure should make it possible without building a UI-heavy feature up front.
- **What works:** handoff is text (`summary`, `notesForNext`), so it crosses runtimes. Each role has its own worktree state and git history.
- **What breaks or needs care:**
  - `resumeSessionId` is runtime-specific. Replace/redirect flows ("a fresh one of the same role, which starts from a summary") already use a summary, so those work. A same-session resume after a runtime change must be refused, and the id should be stored with its runtime.
  - `usageBaseline` is per model in Claude's format and must be per runtime.
  - Prompts for roles must say what the agent can do in its own words.
  - Stuck-detector thresholds are not runtime-aware; I found no Claude assumptions in the config but a slower or looser model may need its own tuning.
  - The Reviewer's trust: a reviewer on a weaker model is a quality risk, which the lineup UI should make visible rather than prevent.

### Testing

- `FakeRuntime` (`fakeRuntime.ts`, 527 lines, with scripts) already substitutes for the whole interface, which is the right seam. To cover more than one runtime: (1) add a **runtime contract test suite**, run against `FakeRuntime` and each real adapter's fake transport, that checks event ordering, interrupt, stop, resume failure, permission round-trip and usage shape; (2) add a **per-runtime transport fake** (a recorded JSON-RPC session for ACP or the Codex app-server) so adapters are tested without network or credentials; (3) keep `sdkRuntime.live.test.ts` style live tests as opt-in, one per runtime, gated by an environment variable and never run in default CI; (4) for providers, test `childEnv()` per provider kind and that ambient variables don't leak (extending the existing test at `sdkRuntime.test.ts:520`).
- E2E tests use `FakeRuntime` with a temporary `MAINBUS_HOME`, so they need no change except new ones for the provider settings UI.

### Licensing and terms

- **Claude Agent SDK:** governed by Anthropic's Commercial Terms of Service; third parties may not offer claude.ai login or rate limits in their products unless previously approved, and the docs point to API-key authentication (Agent SDK overview). The API-key and cloud routes are the documented ones, which is a further reason for Phase 1.
- **Branding:** the SDK overview says products must not appear as "Claude Code" and suggests "Claude Agent" or "Powered by Claude". Check the labels Mainbus uses for providers and runtimes.
- **Gemini CLI:** Apache 2.0; its README states it is designed for Gemini Code Assist Standard/Enterprise licences, and individual free access moved to a different CLI. Programmatic use of a Google login is not described on the page I read. Needs a terms check.
- **OpenCode:** MIT per secondary sources (confirm). **Codex:** the pages I read did not state the licence or the terms for driving a ChatGPT login programmatically; check before relying on that route and prefer API keys.
- **None of this is legal advice;** each needs a check against the current terms before release.

## Risks

- **R1.** Project or local Claude settings (`env` blocks) can redirect the provider, or a repository could carry a hostile one. Mitigate when Phase 1 lands.
- **R2.** Env-based credentials may be readable by the agent's Bash tool. Confirm and mitigate.
- **R3.** Gateways must keep forwarding new Claude Code features; a stale gateway breaks agents in ways that look like model errors.
- **R4.** A second runtime doubles the surface that breaks when a CLI changes (the Claude binary already needs `resolveClaude.ts`). Pin and test versions.
- **R5.** Terms: subscription use by a wrapper app, and the other vendors' login rules.
- **R6.** Weaker or unfamiliar models may not follow Mainbus's tool contracts (handoff, `check_criterion`) reliably. This needs measuring, not assuming.

## Phased plan: proposed change tickets

Sizes: S ≈ a day or less, M ≈ several days, L ≈ a week or more. These are estimates.

### Phase 1: Claude through other routes (mostly configuration)

**1.1 Claude provider setting: API key, Bedrock, Vertex, Foundry, gateway** (M)
- **Scope:** an app-level provider setting stored in the settings store with a migration, a Settings UI section, per-kind env building in `childEnv()` for the role, orchestrator, summary and model-list `query()` calls, and ambient provider variables still stripped. Secrets go to the OS credential store, never SQLite or plain files; cloud routes prefer profile names or helper commands over stored keys.
- **Criteria:**
  - with no provider set, behaviour is unchanged (subscription);
  - each provider kind starts an agent with exactly its own variables and none of Mainbus's ambient ones (unit tests per kind, extending the env-stripping test);
  - an agent cannot read the stored secret through the guard (test with the guard's credential rules, and a check of whether Bash can read the child's environment, with the result documented);
  - project and local settings cannot silently change the provider (decision recorded, test added);
  - the setting can be changed without restarting running agents, which keep their route until they end.

**1.2 Provider-aware model naming and pickers** (S–M)
- **Scope:** extend `parseModelId` for provider-style IDs (`us.`/`eu.`/`global.` prefixes, `anthropic.` prefix, Bedrock suffixes), per-provider model pins in the provider setting (`ANTHROPIC_DEFAULT_*_MODEL`), a check of what `supportedModels()` returns per provider, and picker labels that stay aliases.
- **Criteria:** pickers show version labels on each provider; saved lineups and presets keep resolving; an unavailable pinned model produces a clear message rather than a silent fallback; tests use recorded `supportedModels()` output for each provider.

**1.3 Provider-aware usage and cost wording** (S)
- **Scope:** label cost by provider in the orchestrator's usage tool, the Time report and the UI; hide the subscription usage-limit banner on non-subscription routes.
- **Criteria:** "not billed on the user's Claude plan" appears only on the subscription route; other routes say the figure is an estimate and where billing happens; tests updated (`readTools.test.ts`).

**1.4 Provider check and diagnostics** (S)
- **Scope:** a "Test connection" action that starts the binary with the chosen provider, reports provider, region, resolved model and the first error in plain words.
- **Criteria:** a wrong region, an unavailable model and a rejected credential each give a distinct, actionable message.

### Phase 2: make the runtime interface provider-neutral

**2.1 Runtime id and capabilities on `AgentRuntime`** (M)
- **Scope:** a `runtimeId` and a `capabilities` object (resume, images, effort levels, usage, cost, permission shape), a runtime registry replacing the single runtime in `chooseRuntime`, and `runtime` stored with a run's session id so a resume can't cross runtimes.
- **Criteria:** with only the Claude runtime registered nothing changes; resuming with a different runtime is refused with a clear error; `FakeRuntime` declares capabilities and the runner reads them.

**2.2 Neutral tool shapes for the permission guard** (M–L)
- **Scope:** translate each runtime's tool calls into a neutral shell/file/web shape before `policy.ts` and `guard.ts` see them; keep the Claude mapping as the reference; a coarse fallback for unknown tools that asks the user.
- **Criteria:** the existing guard fixtures (`permissions/fixtures/cards.json`) pass unchanged through the Claude mapping; an unknown tool never auto-allows; tests cover the mapping.

**2.3 Runtime-neutral prompts** (S–M)
- **Scope:** audit role prompts for Claude Code tool names and wording, and make them neutral or runtime-specific.
- **Criteria:** a list of every Claude-specific phrase and how each is handled; Claude lineups' prompts unchanged in behaviour.

### Phase 3: spike to choose the second runtime

**3.1 Spike: ACP client versus Codex app-server** (M, no production code)
- **Scope:** for each, a throwaway adapter that drives one real ticket-like task: tool injection (the role tools through MCP), approval round-trip, resume, image input, usage events, effort and model selection, and the one-shot summary. Test against OpenCode over ACP, and Codex through the app-server. Record every "?" in the matrix above.
- **Criteria:** a filled-in capability matrix with evidence; a recommendation of ACP, Codex or both; licence and terms checked from primary sources; an estimate for the adapter.

### Phase 4: the second runtime

**4.1 Second runtime adapter** (L)
- **Scope:** the chosen adapter implementing `AgentRuntime` (including `summarize` and `supportedModels`), its model list, its credentials added to the guard's credential list, an install/detect step like `resolveClaude.ts`, and a runtime/provider choice in role settings.
- **Criteria:** the runtime contract suite passes against it using a recorded transport; a ticket can run end to end on it in a throwaway repository; permission cards work through the neutral shapes; usage is reported or clearly marked as unavailable; opt-in live test exists and is excluded from default CI.

**4.2 Runtime contract test suite** (M; can start in Phase 2)
- **Scope:** shared tests for event ordering, interrupt, stop, resume failure, permission round-trip and usage, run against `FakeRuntime`, `SdkRuntime` (with its mock) and the new adapter.
- **Criteria:** each runtime is listed in the suite; a missing capability is skipped by declared capability, not by silently passing.

### Phase 5: mixed lineups

**5.1 Per-role runtime and provider in lineups and presets** (M)
- **Scope:** `runtime` and `provider` on each lineup role, picker and preset support, validation against installed runtimes, and a visible badge on cards.
- **Criteria:** a lineup with two runtimes runs; handoff text crosses the boundary; a resume across runtimes is refused with a clear message while replace-from-summary works; usage totals are per runtime and per model in the Time report.

### Not recommended now

- **Mainbus's own tool loop (c)** and **shipping Claude Code through a non-Claude gateway (b)** as supported features. Revisit (b) only for a clearly labelled experimental "local model" option if there is demand, after Phase 4.

## Open questions for the user

1. Which providers matter first: Bedrock, Vertex, Foundry or API key? That changes the order of work in ticket 1.1, but not the plan.
2. Is Mainbus used only on your own machine and login, or will it be distributed? That decides how much weight the subscription-terms question (R5) carries.
3. Which non-Anthropic route matters most: OpenAI (Codex), Gemini, or local models? It decides what the Phase 3 spike should test first.

## Sources (all fetched 2026-11-19)

- Enterprise deployment overview: https://code.claude.com/docs/en/third-party-integrations
- LLM gateways: https://code.claude.com/docs/en/llm-gateway (and the gateway compatibility guide, https://code.claude.com/docs/en/llm-gateway-protocol; not read in full)
- Claude Code on Amazon Bedrock: https://code.claude.com/docs/en/amazon-bedrock
- Feature availability by provider: https://code.claude.com/docs/en/feature-availability
- Model configuration (pinning, `availableModels`, effort levels, picker per provider): https://code.claude.com/docs/en/model-config (the last ~34k characters were not read)
- Agent SDK overview (terms, branding, authentication note): https://code.claude.com/docs/en/agent-sdk/overview
- Ollama's Anthropic compatibility: https://docs.ollama.com/api/anthropic-compatibility
- Codex SDK: https://learn.chatgpt.com/docs/codex-sdk (reached through a redirect from https://developers.openai.com/codex/sdk)
- Gemini CLI: https://github.com/google-gemini/gemini-cli
- OpenCode SDK: https://opencode.ai/docs/sdk/ · OpenCode ACP: https://opencode.ai/docs/acp (seen only in search results; license and provider claims come from secondary sources)
- Agent Client Protocol: https://agentclientprotocol.com/overview/introduction and https://agentclientprotocol.com/protocol/overview
- Not found: the Codex app-server page (`https://learn.chatgpt.com/docs/codex-app-server` returned 404). Vertex AI and Foundry setup pages were not fetched separately; their details above come from the deployment overview and feature-availability pages.
