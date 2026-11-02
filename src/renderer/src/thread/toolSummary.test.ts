import { summariseTools } from './toolSummary'

const calls = (...names: string[]): { name: string }[] => names.map((name) => ({ name }))

test('Read calls count the files', () => {
  expect(summariseTools(calls('Read', 'Read', 'Read'))).toBe('Read 3 files')
  expect(summariseTools(calls('Read'))).toBe('Read 1 file')
})

test("Mainbus's board tools look at the board, with or without the MCP prefix", () => {
  expect(summariseTools(calls('mcp__mainbus__list_tickets'))).toBe('Looked at the board')
  expect(summariseTools(calls('get_ticket', 'mcp__mainbus__get_run_status'))).toBe('Looked at the board')
})

test('a mix is summarised in the order first seen, capitalising only the first part', () => {
  expect(summariseTools(calls('mcp__mainbus__list_tickets', 'Read', 'Grep', 'Read', 'Glob'))).toBe(
    'Looked at the board, read 2 files, searched the code'
  )
})

test('the propose tools count the proposals made', () => {
  expect(summariseTools(calls('mcp__mainbus__propose_create_tickets'))).toBe('Made 1 proposal')
  expect(summariseTools(calls('Read', 'mcp__mainbus__propose_create_tickets', 'propose_create_tickets'))).toBe(
    'Read 1 file, made 2 proposals'
  )
})

test('other tools are counted', () => {
  expect(summariseTools(calls('WebFetch'))).toBe('Used 1 tool')
  expect(summariseTools(calls('Read', 'WebFetch', 'Bash'))).toBe('Read 1 file, used 2 tools')
})
