// Runs the stable build scripts for this OS: pnpm build:stable / pnpm run run:stable.
// Usage: node scripts/stable.mjs <build|run> [--previous]
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const [action, ...args] = process.argv.slice(2)
if (action !== 'build' && action !== 'run') {
  console.error('usage: node scripts/stable.mjs <build|run> [--previous]')
  process.exit(2)
}

let command
let argv
if (process.platform === 'win32') {
  const ps1 = path.join(dir, `${action}-stable.ps1`)
  const translated = args.map((a) => (a === '--previous' ? '-Previous' : a))
  command = 'powershell'
  argv = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, ...translated]
} else if (process.platform === 'darwin') {
  command = 'sh'
  argv = [path.join(dir, `${action}-stable.sh`), ...args]
} else {
  console.error(`The stable build isn't supported on ${process.platform} yet.`)
  process.exit(1)
}

const result = spawnSync(command, argv, { stdio: 'inherit' })
if (result.error) {
  console.error(result.error.message)
  process.exit(1)
}
process.exit(result.status ?? 1)
