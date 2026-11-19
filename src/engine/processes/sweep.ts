import { execFile } from 'node:child_process'

/** One row of the process table. `createdAt` is in ms since the epoch. */
export interface ProcessInfo {
  pid: number
  parentPid: number
  name: string
  createdAt: number
  /** The process group id. Only the POSIX table has it. */
  groupId?: number
}

/**
 * A process Mainbus started: its id, and when it started (ms since the epoch). Off Windows the process is spawned
 * detached, so it leads its own process group and `pid` is also the group id.
 */
export interface ProcessRef {
  pid: number
  startedAt: number
}

/** How far a stored start time may differ from the table's for the same process (a start time taken just before the spawn). */
const START_TOLERANCE_MS = 2000

/**
 * The processes that descend from `root`, found by parent process id, recursively. On Windows an orphan keeps its
 * dead parent's id, so the walk finds it though `root` has exited. A process only counts as a child if it was
 * created at or after its parent, which rejects a process id that has since been reused. `root` itself is included
 * when it is still running with the start time that was stored. Never returns a process outside that tree.
 */
export function descendantsOf(table: readonly ProcessInfo[], root: ProcessRef): ProcessInfo[] {
  const byParent = new Map<number, ProcessInfo[]>()
  for (const p of table) {
    const siblings = byParent.get(p.parentPid)
    if (siblings) siblings.push(p)
    else byParent.set(p.parentPid, [p])
  }
  const found: ProcessInfo[] = []
  const seen = new Set<number>([root.pid])
  const same = table.find((p) => p.pid === root.pid)
  let rootTime = root.startedAt
  // Newer than the stored start: the id belongs to another process now, and only what was created before it can be ours.
  let cutoff = Infinity
  if (same) {
    if (Math.abs(same.createdAt - root.startedAt) <= START_TOLERANCE_MS) {
      found.push(same)
      rootTime = same.createdAt
    } else {
      cutoff = same.createdAt
    }
  }
  const walk = (pid: number, createdAt: number): void => {
    for (const child of byParent.get(pid) ?? []) {
      if (seen.has(child.pid) || child.createdAt < createdAt || child.createdAt >= cutoff) continue
      seen.add(child.pid)
      found.push(child)
      walk(child.pid, child.createdAt)
    }
  }
  walk(root.pid, rootTime)
  // Group members (POSIX): the root led its own process group, so the group id is the root's pid. Orphans are
  // re-parented to init, so only the group finds them. Not when the root's pid is alive with another start time:
  // POSIX keeps a pid unused while a group has that id, so the group is gone. Members older than the root are not
  // ours either (the start times have 1-second resolution, hence the tolerance). Residual risk: the pid is reused by
  // a new group leader that exits before a crash-recovery sweep; the parent walk above has the same weakness.
  const rootReused = same !== undefined && cutoff !== Infinity
  if (!rootReused) {
    const members = table.filter(
      (p) => p.groupId === root.pid && !seen.has(p.pid) && p.createdAt >= rootTime - START_TOLERANCE_MS
    )
    for (const m of members) {
      if (seen.has(m.pid)) continue
      seen.add(m.pid)
      found.push(m)
    }
    // Children that started their own group while their parent was alive.
    for (const m of members) walk(m.pid, m.createdAt)
  }
  return found.filter((p) => p.pid !== process.pid)
}

/** "4 processes the Implementer left running: python3.exe, bash.exe (3)", from what was ended. Null for none. */
export function endedNotice(role: string, ended: readonly ProcessInfo[]): string | null {
  if (ended.length === 0) return null
  const counts = new Map<string, number>()
  for (const p of ended) counts.set(p.name, (counts.get(p.name) ?? 0) + 1)
  const names = [...counts].map(([name, n]) => (n > 1 ? `${name} (${n})` : name)).join(', ')
  return `Mainbus ended ${ended.length} ${ended.length === 1 ? 'process' : 'processes'} the ${role} left running: ${names}.`
}

export type ProcessTable = () => Promise<ProcessInfo[]>
/** Ends the processes, and whatever each one started. */
export type KillProcesses = (processes: readonly ProcessInfo[], root: ProcessRef) => Promise<void>

function run(file: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(file, args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 30_000, env }, (err, stdout) =>
      err ? reject(err) : resolve(stdout)
    )
  )
}

const WINDOWS_TABLE_SCRIPT =
  'Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ p = [int]$_.ProcessId; pp = [int]$_.ParentProcessId; n = $_.Name; c = [long]([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } } | ConvertTo-Json -Compress'

async function windowsTable(): Promise<ProcessInfo[]> {
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_TABLE_SCRIPT])
  const parsed: unknown = JSON.parse(out)
  const rows = (Array.isArray(parsed) ? parsed : [parsed]) as { p: number; pp: number; n: string; c: number }[]
  return rows.filter((r) => typeof r.p === 'number' && typeof r.c === 'number').map((r) => ({ pid: r.p, parentPid: r.pp, name: String(r.n), createdAt: r.c }))
}

/** Parses `ps -eo pid=,ppid=,pgid=,lstart=,comm=` output (lstart in the C locale). Lines that do not fit are skipped. */
export function parsePsTable(out: string): ProcessInfo[] {
  const rows: ProcessInfo[] = []
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/.exec(line)
    if (!m) continue
    const createdAt = Date.parse(m[4]!)
    if (Number.isNaN(createdAt)) continue
    rows.push({ pid: Number(m[1]), parentPid: Number(m[2]), groupId: Number(m[3]), name: m[5]!.trim(), createdAt })
  }
  return rows
}

async function posixTable(): Promise<ProcessInfo[]> {
  return parsePsTable(await run('ps', ['-eo', 'pid=,ppid=,pgid=,lstart=,comm='], { ...process.env, LC_ALL: 'C' }))
}

export interface EndGroupOptions {
  /** How long processes get after SIGTERM before SIGKILL. */
  graceMs?: number
  pollMs?: number
  signal?: (pid: number, signal: NodeJS.Signals | 0) => void
  sleep?: (ms: number) => Promise<void>
}

/**
 * Ends what a POSIX sweep found: SIGTERM to the root's process group (`-root.pid`) and to each found process outside
 * it, a wait for them to exit, then SIGKILL to the group and to whatever is still running. Only the group and the
 * found pids are ever signalled.
 */
export async function endProcessGroup(found: readonly ProcessInfo[], root: ProcessRef, opts: EndGroupOptions = {}): Promise<void> {
  const { graceMs = 3000, pollMs = 100, signal = (pid, sig) => process.kill(pid, sig), sleep = (ms) => new Promise<void>((r) => setTimeout(r, ms)) } = opts
  const send = (pid: number, sig: NodeJS.Signals | 0): boolean => {
    try {
      signal(pid, sig)
      return true
    } catch {
      return false // Already gone (ESRCH), or not ours.
    }
  }
  const hasGroup = found.some((p) => p.groupId === root.pid)
  const loose = found.filter((p) => p.groupId !== root.pid).map((p) => p.pid)
  const targets = [...(hasGroup ? [-root.pid] : []), ...loose]
  for (const t of targets) send(t, 'SIGTERM')
  const alive = (): number[] => found.map((p) => p.pid).filter((pid) => send(pid, 0))
  const deadline = Date.now() + graceMs
  let left = alive()
  while (left.length > 0 && Date.now() < deadline) {
    await sleep(pollMs)
    left = alive()
  }
  if (left.length === 0) return
  if (hasGroup) send(-root.pid, 'SIGKILL')
  for (const pid of left) send(pid, 'SIGKILL')
}

async function killTrees(processes: readonly ProcessInfo[], root: ProcessRef): Promise<void> {
  if (process.platform === 'win32') {
    const ids = new Set(processes.map((p) => p.pid))
    // Each survivor whose parent is not also being ended; /T takes its own children with it.
    for (const p of processes.filter((q) => !ids.has(q.parentPid))) {
      await run('taskkill.exe', ['/PID', String(p.pid), '/T', '/F']).catch(() => {})
    }
    return
  }
  await endProcessGroup(processes, root)
}

/** Finds and ends the processes a Mainbus-started process left running. */
export class ProcessSweeper {
  constructor(
    private readonly table: ProcessTable = process.platform === 'win32' ? windowsTable : posixTable,
    private readonly kill: KillProcesses = killTrees
  ) {}

  /** The start time of a running process, or null when it is not in the table. */
  async startTime(pid: number): Promise<number | null> {
    return (await this.table()).find((p) => p.pid === pid)?.createdAt ?? null
  }

  /** Ends every process that descends from `root`, and `root` if it still runs. Returns what was ended. */
  async sweep(root: ProcessRef): Promise<ProcessInfo[]> {
    const found = descendantsOf(await this.table(), root)
    if (found.length > 0) await this.kill(found, root)
    return found
  }
}
