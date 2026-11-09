import { vi } from 'vitest'

/**
 * How long an engine test waits for state that real work produces. Starting a ticket creates its worktree with real
 * git (about 20 processes: roughly 1 s alone, several times that while the full suite shares the machine), so
 * vi.waitFor's 1 s default loses the race. Kept below the engine project's testTimeout so a wait that never settles
 * fails with its own assertion rather than "Test timed out".
 */
export const ENGINE_WAIT_MS = 20_000

/**
 * vi.waitFor with the engine's deadline, for state with no event to await. A longer timeout in `options` still
 * applies; a shorter one is raised to ENGINE_WAIT_MS.
 */
export const eventually: typeof vi.waitFor = (check, options) => {
  const given = typeof options === 'object' ? options : {}
  return vi.waitFor(check, { interval: 25, ...given, timeout: Math.max(given.timeout ?? 0, ENGINE_WAIT_MS) })
}
