import { describe, expect, test } from 'vitest'
import { inputText, normalizeCommand } from './normalize'

describe('normalizeCommand', () => {
  test('collapses whitespace', () => {
    expect(normalizeCommand('  npm   test \n -- --run ')).toBe('npm test -- --run')
  })

  test('masks temp paths, whatever the style', () => {
    const a = normalizeCommand('node build.js C:\\Users\\me\\AppData\\Local\\Temp\\run-1\\out.json')
    const b = normalizeCommand('node build.js C:\\Users\\me\\AppData\\Local\\Temp\\run-2\\out.json')
    expect(a).toBe('node build.js <tmp>')
    expect(b).toBe(a)
    expect(normalizeCommand('cat /tmp/abc123/log.txt')).toBe('cat <tmp>')
    expect(normalizeCommand('cat $TEMP/x.log')).toBe('cat <tmp>')
    expect(normalizeCommand('cat %TEMP%\\x.log')).toBe('cat <tmp>')
    expect(normalizeCommand('cat /var/folders/ab/cd/T/x.log')).toBe('cat <tmp>')
  })

  test('keeps a path that only contains the letters of temp', () => {
    expect(normalizeCommand('cat src/template/x.ts')).toBe('cat src/template/x.ts')
  })

  test('masks numbers', () => {
    expect(normalizeCommand('vitest run --retry 3 --seed 1234')).toBe('vitest run --retry N --seed N')
    expect(normalizeCommand('curl localhost:3000/a')).toBe(normalizeCommand('curl localhost:3001/a'))
  })

  test('different commands stay different', () => {
    expect(normalizeCommand('npm test')).not.toBe(normalizeCommand('npm run build'))
  })
})

describe('inputText', () => {
  test('is the command, path or pattern of a tool input, else its JSON', () => {
    expect(inputText({ command: 'npm test', description: 'Run' })).toBe('npm test')
    expect(inputText({ file_path: 'a.ts' })).toBe('a.ts')
    expect(inputText({ other: 1 })).toBe('{"other":1}')
    expect(inputText('x')).toBe('x')
  })
})
