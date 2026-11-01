import fs from 'node:fs/promises'
import type { PullRequest } from '../../shared/domain'
import type { CommandOutput, CommandRunner } from './command'

export interface FakePr extends PullRequest {
  base: string
  head: string
  title: string
  body: string
  draft: boolean
}

/**
 * Stands in for the GitHub CLI in tests and test runs of the app: it keeps pull requests in memory and
 * never reaches GitHub. Everything else (git) goes to the runner it wraps.
 */
export class FakeGh {
  readonly prs: FakePr[] = []
  /** Every gh command line it was given. */
  readonly calls: string[][] = []
  /** 'missing' acts as if gh is not installed; 'signed_out' as if `gh auth status` fails. */
  state: 'ok' | 'missing' | 'signed_out' = 'ok'

  constructor(private readonly repoUrl = 'https://github.com/example/repo') {}

  /** A runner that sends gh to this fake and everything else to `rest`. */
  runner(rest: CommandRunner): CommandRunner {
    return (file, args, opts) => (file === 'gh' ? this.run(args) : rest(file, args, opts))
  }

  private async run(args: string[]): Promise<CommandOutput> {
    this.calls.push(args)
    if (this.state === 'missing') throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })
    const [command, sub] = args
    if (command === '--version') return ok('gh version 0.0.0 (fake)\n')
    if (command === 'auth' && sub === 'status') {
      return this.state === 'signed_out' ? fail('You are not logged into any GitHub hosts. To log in, run: gh auth login') : ok('')
    }
    if (command === 'pr' && sub === 'create') return this.create(args.slice(2))
    if (command === 'pr' && sub === 'view') {
      const pr = this.prs.find((p) => p.head === args[2])
      return pr ? ok(JSON.stringify({ url: pr.url, number: pr.number })) : fail(`no pull requests found for branch "${args[2]}"`)
    }
    return fail(`fake gh: unexpected call gh ${args.join(' ')}`)
  }

  private async create(args: string[]): Promise<CommandOutput> {
    const flag = (name: string): string | undefined => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
    const head = flag('head')
    const base = flag('base')
    const title = flag('title')
    const bodyFile = flag('body-file')
    if (!head || !base || title === undefined || !bodyFile) return fail(`fake gh: missing flags in ${args.join(' ')}`)
    const existing = this.prs.find((p) => p.head === head)
    if (existing) {
      return fail(`a pull request for branch "${head}" into branch "${existing.base}" already exists:\n${existing.url}`)
    }
    const number = this.prs.length + 1
    const pr: FakePr = {
      url: `${this.repoUrl}/pull/${number}`,
      number,
      base,
      head,
      title,
      body: await fs.readFile(bodyFile, 'utf8'),
      draft: args.includes('--draft') || args.some((a) => a.startsWith('--draft='))
    }
    this.prs.push(pr)
    return ok(`\nCreating pull request for ${head} into ${base}\n\n${pr.url}\n`)
  }
}

function ok(stdout: string): CommandOutput {
  return { code: 0, stdout, stderr: '', timedOut: false }
}

function fail(stderr: string): CommandOutput {
  return { code: 1, stdout: '', stderr: `${stderr}\n`, timedOut: false }
}
