import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as sdk from '@anthropic-ai/claude-agent-sdk'
import { afterAll, describe, expect, test } from 'vitest'
import type { AgentEvent } from '../../shared/events'
import { execFileNode, resolveClaude } from './resolveClaude'
import { SdkRuntime, type SdkApi } from './sdkRuntime'
import type { RunSpec } from './types'

// Uses the real claude binary and the user's subscription. Run with MAINBUS_LIVE=1.
const LIVE = process.env.MAINBUS_LIVE === '1'

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'core.longpaths=true', ...args], { cwd, windowsHide: true, stdio: 'ignore' })
}

describe.skipIf(!LIVE)('SdkRuntime (live)', () => {
  let repo = ''
  let scratch = ''
  afterAll(() => {
    for (const dir of [repo, scratch]) {
      if (!dir) continue
      try {
        // stop() has already waited for the child to exit; the retries only cover antivirus scanners.
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      } catch {
        // Leave the temp folder for the OS to clear.
      }
    }
  })

  test(
    'a real run creates a file and calls the handoff tool',
    async () => {
      const setup = await resolveClaude(execFileNode)
      if (!setup.ok) throw new Error(`claude is not usable: ${setup.reason}: ${setup.detail}`)

      repo = mkdtempSync(join(tmpdir(), 'mainbus-live-'))
      scratch = mkdtempSync(join(tmpdir(), 'mainbus-live-scratch-'))
      git(repo, 'init', '-q', '-b', 'main')
      git(repo, 'config', 'user.email', 'live@mainbus.test')
      git(repo, 'config', 'user.name', 'Mainbus Live')
      writeFileSync(join(repo, 'README.md'), '# live\n')
      git(repo, 'add', '-A')
      git(repo, 'commit', '-q', '-m', 'init')

      // Tap the raw SDK messages so the test can read system/init, which the Normalizer reduces to a session id.
      const raw: Array<Record<string, unknown>> = []
      let optionsSeen: Record<string, unknown> | undefined
      const tapped: SdkApi = {
        ...sdk,
        query: ((params: Parameters<typeof sdk.query>[0]) => {
          optionsSeen = params.options as Record<string, unknown>
          const q = sdk.query(params)
          const gen = (async function* () {
            for await (const m of q) {
              raw.push(m as unknown as Record<string, unknown>)
              yield m
            }
          })()
          return Object.assign(gen, { interrupt: () => q.interrupt() })
        }) as unknown as typeof sdk.query
      }

      const handoffs: Array<{ summary: string; notesForNext: string }> = []
      const permissions: string[] = []
      const spec: RunSpec = {
        cwd: repo,
        tempDir: scratch,
        ownBranch: 'main',
        prompt:
          'Create a file a.txt containing hi, then call handoff (the tool mcp__mainbus__handoff) with a one-line summary and notes_for_next "none". Do not do anything else.',
        appendSystemPrompt: 'You are the Implementer. Finish by calling mcp__mainbus__handoff.',
        model: 'haiku',
        effort: 'low',
        toolProfile: 'edit',
        disallowedTools: ['AskUserQuestion', 'Agent', 'Task'],
        additionalDirectories: [scratch],
        roleTools: {
          askUser: async () => 'no one is available',
          handoff: async (a) => {
            handoffs.push(a)
            return 'Recorded. End your turn now.'
          },
          submitReport: async () => 'no one is available',
          reportProblem: async () => 'no one is available',
          reportWaiting: async () => 'no one is available',
          checkCriterion: async () => 'Checked'
        },
        onPermission: async (r) => {
          permissions.push(`${r.toolName}: ${r.reason ?? ''}`)
          return { allow: true }
        }
      }

      const runtime = new SdkRuntime(setup.path, tapped)
      const run = await runtime.start(spec)
      const events: AgentEvent[] = []
      const deadline = Date.now() + 120_000
      // Done once the turn that called handoff has ended, so the tool handler has run.
      const watcher = (async () => {
        let calledHandoff = false
        for await (const e of runtime.events(run)) {
          events.push(e)
          if (e.kind === 'tool_call' && e.name.includes('handoff')) calledHandoff = true
          if (calledHandoff && e.kind === 'turn_end') return
          if (Date.now() > deadline) return
        }
      })()
      const timer = setTimeout(() => void runtime.stop(run), 120_000)
      await watcher
      clearTimeout(timer)
      const stopStart = Date.now()
      await runtime.stop(run)
      const stopMs = Date.now() - stopStart

      const init = raw.find((m) => m.type === 'system' && m.subtype === 'init')
      const toolNames = events.filter((e) => e.kind === 'tool_call').map((e) => (e as { name: string }).name)
      const userHooks = raw.filter((m) => m.type === 'system' && m.subtype === 'hook_started')
      console.log(
        JSON.stringify(
          {
            claude: setup,
            apiKeySource: init?.apiKeySource,
            permissionMode: init?.permissionMode,
            settingSourcesPassed: optionsSeen?.settingSources,
            hooksStarted: userHooks.length,
            plugins: init?.plugins,
            mcpServers: init?.mcp_servers,
            skills: init?.skills,
            slashCommands: init?.slash_commands,
            agents: init?.agents,
            stopMs,
            toolCalls: toolNames,
            permissionRequests: permissions,
            handoffs
          },
          null,
          2
        )
      )

      expect(init).toBeDefined()
      expect(init?.apiKeySource).toBe('none')
      expect(optionsSeen?.settingSources).toEqual(['project', 'local'])
      expect(init?.permissionMode).toBe('acceptEdits')
      // Writing a.txt inside the worktree is an accepted edit, so nothing should have asked.
      expect(permissions).toEqual([])
      // Isolation from the user's own setup: only the binary's built-in plugins, and only our MCP server.
      const plugins = (init?.plugins ?? []) as Array<{ name: string; source: string }>
      expect(plugins.filter((p) => !p.source.endsWith('@builtin'))).toEqual([])
      const mcpServers = (init?.mcp_servers ?? []) as Array<{ name: string; source?: string }>
      expect(mcpServers.map((m) => m.name)).toEqual(['mainbus'])
      expect(mcpServers[0].source).toBe('sdk')
      // Plugin skills are namespaced (plugin:skill); user skills and plugin skills must not appear.
      const skills = (init?.skills ?? []) as string[]
      expect(skills.filter((n) => n.includes(':'))).toEqual([])
      expect(toolNames.some((n) => n.includes('handoff'))).toBe(true)
      expect(handoffs).toHaveLength(1)
    },
    150_000
  )
})
