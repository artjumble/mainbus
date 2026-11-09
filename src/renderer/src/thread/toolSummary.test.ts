import { summariseTools } from './toolSummary'

const calls = (...names: string[]): { name: string; input?: unknown }[] => names.map((name) => ({ name }))
const fetches = (...urls: string[]): { name: string; input: unknown }[] => urls.map((url) => ({ name: 'WebFetch', input: { url } }))

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

test('update_ticket reads as editing a ticket', () => {
  expect(summariseTools(calls('mcp__mainbus__update_ticket'))).toBe('Edited a ticket')
  expect(summariseTools(calls('mcp__mainbus__update_ticket', 'mcp__mainbus__update_ticket'))).toBe('Edited tickets')
})

test('create_tickets reads as creating tickets', () => {
  expect(summariseTools(calls('mcp__mainbus__create_tickets'))).toBe('Created tickets')
  expect(summariseTools(calls('mcp__mainbus__list_workspaces', 'mcp__mainbus__create_tickets', 'mcp__mainbus__create_tickets'))).toBe(
    'Looked at the board, created tickets'
  )
})

test('other tools are counted', () => {
  expect(summariseTools(calls('Bash'))).toBe('Used 1 tool')
  expect(summariseTools(calls('Read', 'TodoWrite', 'Bash'))).toBe('Read 1 file, used 2 tools')
})

test('web pages are named by host, and a search reads as searching the web', () => {
  expect(summariseTools(fetches('https://docs.waveshare.com/esp32-c6'))).toBe('Read docs.waveshare.com')
  expect(summariseTools(fetches('https://a.com/1', 'https://a.com/2'))).toBe('Read a.com')
  expect(summariseTools(fetches('https://a.com', 'https://b.org'))).toBe('Read a.com and b.org')
  expect(summariseTools(fetches('https://a.com', 'https://b.org', 'https://c.net'))).toBe('Read 3 web pages')
  expect(summariseTools(fetches('nonsense'))).toBe('Read a web page')
  expect(summariseTools(calls('WebFetch'))).toBe('Read a web page')
  expect(summariseTools(calls('WebSearch', 'WebSearch'))).toBe('Searched the web')
  expect(summariseTools([{ name: 'Read' }, ...fetches('https://docs.waveshare.com/x'), { name: 'WebSearch' }])).toBe(
    'Read 1 file, read docs.waveshare.com, searched the web'
  )
})
