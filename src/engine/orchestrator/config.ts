import type { Effort } from '../../shared/domain'
import { DISALLOWED_TOOLS } from '../roles/hardening'

/** The orchestrator's model and effort. There is no setting for them yet. */
export const ORCHESTRATOR_MODEL = 'opus'
export const ORCHESTRATOR_EFFORT: Effort = 'medium'

/**
 * Named as well as left out of its built-in tools, in case a later binary adds one back: everything a role may
 * not use, and every tool that runs commands, changes files, reaches the web or loads more instructions.
 */
export const ORCHESTRATOR_DISALLOWED: string[] = [
  ...DISALLOWED_TOOLS,
  'Bash',
  'PowerShell',
  'BashOutput',
  'KillShell',
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'Skill',
  'SlashCommand',
  'TodoWrite',
  'ExitPlanMode',
  'EnterPlanMode',
  'Monitor'
]
