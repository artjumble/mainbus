import type { StuckRule } from './domain'

/** The short reason a run looks stuck, as the timeline says it: "same failing command 5 times". */
export function stuckHeadline(rule: StuckRule, count?: number): string {
  switch (rule) {
    case 'repeated_failure':
      return count === undefined ? 'same failing command again and again' : `same failing command ${count} times`
    case 'no_progress':
      return 'no progress for a while'
    case 'silence':
      return 'no events for a while'
    case 'no_milestone':
      return 'no commit, tick or message for a while'
    case 'long_turn':
      return 'one turn running very long'
    case 'dead_process':
      return 'its process ended'
  }
}
