import type { StuckEpisode } from '../../shared/domain'

/**
 * True when the episode was redirected and has been hit again since: the redirect did not help, so the next step
 * of the recovery ladder, a replacement, is open.
 */
export function firedAgainAfterRedirect(episode: Pick<StuckEpisode, 'redirectedAt' | 'lastHitAt'>): boolean {
  return episode.redirectedAt !== null && Date.parse(episode.lastHitAt) > Date.parse(episode.redirectedAt)
}
