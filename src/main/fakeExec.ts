import type { ExecFn } from '../engine/runtime/resolveClaude'

const CLAUDE_PATH = process.platform === 'win32' ? 'C:/fake/claude.exe' : '/fake/claude'

/**
 * Stands in for the real `claude` probes (where/which, `--version`, `auth status`) in test runs with a
 * fake agent runtime, so `setup.check` is ok on a machine that has no Claude Code.
 */
export const fakeClaudeExec: ExecFn = async (file, args) => {
  if (file === 'where.exe' || file === 'which') return { code: 0, stdout: `${CLAUDE_PATH}\n`, stderr: '' }
  if (args[0] === '--version') return { code: 0, stdout: '0.0.0 (fake Claude Code)\n', stderr: '' }
  if (args[0] === 'auth' && args[1] === 'status') return { code: 0, stdout: 'Logged in (fake)\n', stderr: '' }
  return { code: 1, stdout: '', stderr: `fake claude: unexpected call ${file} ${args.join(' ')}` }
}
