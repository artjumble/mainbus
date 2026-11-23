import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vitest'
import type { CommandName } from '../shared/api'
import { KINDS } from './proposals/registry'
import type { WakeKind } from './store/wakes'

/**
 * Insurance for the human-owned rule: every engine command, proposal kind and wake is classified by whether it can start a
 * role on a ticket. The Records are exhaustive, so adding a command fails `pnpm typecheck` until it is listed here; a
 * path that starts a role must then name the test in owner.engine.test.ts that shows a human ticket is refused or skipped.
 *
 *   starts_role    starts a role (or puts a start in front of the user): must have a human-owned test
 *   needs_open_run acts only on an open run, and setOwner is refused while one is open
 *   none           starts nothing
 */
type Effect = 'starts_role' | 'needs_open_run' | 'none'

const COMMANDS: Record<CommandName, Effect> = {
  'setup.check': 'none',
  'workspace.get': 'none',
  'workspace.list': 'none',
  'workspace.summaries': 'none',
  'workspace.open': 'none',
  'workspace.check': 'none',
  'workspace.previewSetup': 'none',
  'workspace.prepare': 'none',
  'workspace.focus': 'none',
  'workspace.remove': 'none',
  'workspace.setOpenPrOnReview': 'none',
  'workspace.branches': 'none',
  'workspace.setBaseBranch': 'none',
  'workspace.setMergeMethod': 'none',
  'workspace.setReportSettings': 'none',
  'workspace.setRailBadge': 'none',
  'workspace.setUnattendedAtOnce': 'none',
  'workspace.setAutoArchiveDays': 'none',
  'workspace.setSetupSettings': 'none',
  'workspace.setTestCommands': 'none',
  'workspace.baseTests': 'none',
  'workspace.runBaseTests': 'none',
  'github.check': 'none',
  'board.get': 'none',
  'archive.countOlder': 'none',
  'archive.olderThan': 'none',
  'archive.restoreBatch': 'none',
  'archive.closeNotice': 'none',
  'ticket.view': 'none',
  'archive.list': 'none',
  'ticket.create': 'none',
  'attachment.add': 'none',
  'attachment.remove': 'none',
  'attachment.list': 'none',
  'attachment.data': 'none',
  'ticket.update': 'none',
  'ticket.setBlockedBy': 'none',
  'ticket.appendIntent': 'none',
  'ticket.undoEdit': 'none',
  'ticket.move': 'none',
  'ticket.reorder': 'none',
  'ticket.hold': 'none',
  'ticket.unhold': 'none',
  'ticket.archive': 'none',
  'ticket.unarchive': 'none',
  'ticket.setRunSettings': 'none',
  'ticket.setOwner': 'none',
  'ticket.draftPromotion': 'none',
  'ticket.promote': 'none',
  'ticket.openPr': 'none',
  'ticket.saveReport': 'none',
  'ticket.runSetup': 'none',
  'ticket.updateFromMain': 'starts_role',
  'ticket.mergePreview': 'none',
  'ticket.merge': 'none',
  'ticket.time': 'none',
  'workspace.timeReport': 'none',
  'thread.get': 'none',
  'agent.start': 'starts_role',
  'agent.send': 'needs_open_run',
  'agent.stop': 'needs_open_run',
  'agent.continue': 'needs_open_run',
  'agent.pause': 'needs_open_run',
  'agent.resume': 'needs_open_run',
  'agent.skip': 'needs_open_run',
  'decision.answer': 'needs_open_run',
  'decision.defer': 'needs_open_run',
  'decision.bringBack': 'needs_open_run',
  'lineup.get': 'none',
  'lineup.save': 'none',
  'preset.list': 'none',
  'preset.save': 'none',
  'preset.remove': 'none',
  'allowRules.list': 'none',
  'allowRules.remove': 'none',
  'agents.launcher': 'none',
  'settings.get': 'none',
  'settings.setMaxAgents': 'none',
  'settings.setWhenClosed': 'none',
  'settings.setOrchestratorWebAccess': 'none',
  'settings.setReviewDone': 'none',
  'settings.setTicketFoldersLocation': 'none',
  'settings.setOrchestratorModel': 'none',
  'settings.setOrchestratorEffort': 'none',
  'settings.setTheme': 'none',
  'settings.setMatchWindowsTheme': 'none',
  'settings.setVoice': 'none',
  'voice.models': 'none',
  'voice.downloadModel': 'none',
  'voice.cancelDownload': 'none',
  'voice.removeModel': 'none',
  'unattended.get': 'none',
  'unattended.set': 'none',
  'usage.get': 'none',
  'usage.resumeNow': 'needs_open_run',
  'orchestrator.get': 'none',
  'orchestrator.usage': 'none',
  'orchestrator.model': 'none',
  'models.list': 'none',
  'orchestrator.send': 'none',
  'orchestrator.editQueued': 'none',
  'orchestrator.removeQueued': 'none',
  'orchestrator.sendQueuedNow': 'none',
  'orchestrator.image': 'none',
  'orchestrator.stop': 'none',
  'ticket.proposeStart': 'starts_role',
  'ticket.proposeReplace': 'needs_open_run',
  'proposal.confirm': 'none',
  'proposal.reject': 'none',
}

const PROPOSALS: Record<keyof typeof KINDS, Effect> = {
  create_tickets: 'none',
  start_lineup: 'starts_role',
  pause: 'needs_open_run',
  stop: 'needs_open_run',
  skip: 'needs_open_run',
  hold: 'none',
  answer: 'needs_open_run',
  redirect: 'needs_open_run',
  replace: 'needs_open_run',
  promote: 'none',
  update_from_main: 'starts_role',
  merge: 'none'
}

/** 'needs_run' wakes are about an open run, which a human ticket never has; 'guarded' ones are checked against the owner. */
const WAKES: Record<WakeKind, 'needs_run' | 'guarded'> = {
  failure: 'needs_run',
  stuck: 'needs_run',
  resurfaced: 'needs_run',
  released_hold: 'guarded',
  done_review: 'guarded'
}

/** The test (by title) in owner.engine.test.ts that covers each starting path. */
const HUMAN_TESTS: Record<string, string> = {
  'command agent.start': 'Start refuses it',
  'command ticket.updateFromMain': 'Update from main refuses it',
  'command ticket.proposeStart': 'dragging it into In progress is refused',
  'proposal start_lineup': 'propose_start refuses it',
  'proposal update_from_main': 'Update from main refuses it',
  'wake released_hold': 'a dated hold on it running out wakes nothing',
  'wake done_review': 'a human ticket moved to Done is not reviewed'
}

const named = <T extends string>(record: Record<T, string>, wanted: string): string[] =>
  (Object.keys(record) as T[]).filter((k) => record[k] === wanted).sort()

test("the proposal kinds listed here are the registry's", () => {
  expect(Object.keys(PROPOSALS).sort()).toEqual(Object.keys(KINDS).sort())
})

test('every path that starts a role has a human-owned test, and no test is left over', () => {
  const paths = [
    ...named(COMMANDS, 'starts_role').map((n) => `command ${n}`),
    ...named(PROPOSALS, 'starts_role').map((n) => `proposal ${n}`),
    ...named(WAKES, 'guarded').map((n) => `wake ${n}`)
  ].sort()
  expect(Object.keys(HUMAN_TESTS).sort()).toEqual(paths)

  const tests = fs.readFileSync(path.join(import.meta.dirname, 'tickets', 'owner.engine.test.ts'), 'utf8')
  for (const [which, title] of Object.entries(HUMAN_TESTS)) {
    expect(tests, `${which} needs a test titled "${title}"`).toContain(title)
  }
})
