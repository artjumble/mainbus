import { execFile } from 'node:child_process'

/** One row of the process table. `createdAt` is in ms since the epoch. */
export interface ProcessInfo {
  pid: number
  parentPid: number
  name: string
  createdAt: number
}

/** A process Mainbus started: its id, and when it started (ms since the epoch). */
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
  return found
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
export type KillProcesses = (processes: readonly ProcessInfo[]) => Promise<void>

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(file, args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 30_000 }, (err, stdout) =>
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

async function posixTable(): Promise<ProcessInfo[]> {
  const out = await run('ps', ['-eo', 'pid=,ppid=,lstart=,comm='])
  const rows: ProcessInfo[] = []
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/.exec(line)
    if (m) rows.push({ pid: Number(m[1]), parentPid: Number(m[2]), name: m[4]!.trim(), createdAt: Date.parse(m[3]!) })
  }
  return rows
}

async function killTrees(processes: readonly ProcessInfo[]): Promise<void> {
  const ids = new Set(processes.map((p) => p.pid))
  if (process.platform === 'win32') {
    // Each survivor whose parent is not also being ended; /T takes its own children with it.
    for (const p of processes.filter((q) => !ids.has(q.parentPid))) {
      await run('taskkill.exe', ['/PID', String(p.pid), '/T', '/F']).catch(() => {})
    }
    return
  }
  for (const p of [...processes].reverse()) {
    try {
      process.kill(p.pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
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
    if (found.length > 0) await this.kill(found)
    return found
  }
}
