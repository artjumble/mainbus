// The `mainbus` program: the ticket CLI and the MCP server, bundled into one CommonJS file
// (out/cli/mainbus.cjs). It only talks to the running app through the intake pipe, so nothing here may
// pull in node:sqlite, Electron or React.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { main, type Io } from './main'
import { createMcpServer } from './mcp'
import { modeOf } from './target'

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk: string) => (text += chunk))
    process.stdin.on('end', () => resolve(text))
    process.stdin.on('error', reject)
  })
}

async function serveMcp(...args: Parameters<Io['serveMcp']>): Promise<void> {
  const server = createMcpServer(...args)
  const transport = new StdioServerTransport()
  const closed = new Promise<void>((resolve) => {
    transport.onclose = resolve
    // The client went away: stdin ends, and there is nobody left to serve.
    process.stdin.once('end', () => void server.close())
  })
  await server.connect(transport)
  await closed
}

const io: Io = {
  env: process.env,
  cwd: process.cwd(),
  mode: modeOf(__dirname),
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
  readStdin,
  serveMcp
}

void main(process.argv.slice(2), io).then((code) => {
  // Setting exitCode rather than calling exit() lets piped output drain first.
  process.exitCode = code
})
