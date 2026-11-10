import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineEvent } from '../../shared/api'
import { voiceModelSourceUrl, type VoiceModelSpec } from '../../shared/voice'
import { createVoiceModels } from './models'

const sha = (s: string): string => createHash('sha256').update(s).digest('hex')
const FILES = { 'config.json': '{"a":1}', 'onnx/model.onnx': 'model-bytes' }
const SPEC: VoiceModelSpec = {
  id: 'whisper-base',
  label: 'Tiny',
  repo: 'org/tiny',
  revision: 'abc123',
  files: Object.entries(FILES).map(([p, c]) => ({ path: p, size: c.length, sha256: sha(c) }))
}

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mainbus-models-'))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

function fakeFetch(files: Record<string, string> = FILES): ReturnType<typeof vi.fn> & typeof fetch {
  return vi.fn(async (url: string | URL | Request) => {
    const u = String(url)
    const name = Object.keys(files).find((p) => u === voiceModelSourceUrl(SPEC, p))
    if (!name) return new Response('nope', { status: 404, statusText: 'Not Found' })
    return new Response(files[name])
  }) as never
}

function make(f: typeof fetch) {
  const events: EngineEvent[] = []
  const models = createVoiceModels({ dir, fetch: f, manifest: [SPEC], emit: (e) => events.push(e), throttleMs: 0 })
  return { models, events }
}

describe('voice models', () => {
  it('fetches nothing until a download is asked for, and reports the model as not installed', async () => {
    const f = fakeFetch()
    const { models } = make(f)
    expect(await models.statuses()).toEqual([{ id: 'whisper-base', installed: false, download: null, error: null }])
    expect(f).not.toHaveBeenCalled()
  })

  it('downloads every file from its pinned address, checks it and installs the folder', async () => {
    const f = fakeFetch()
    const { models, events } = make(f)
    const after = await models.download('whisper-base')
    expect(after[0]).toMatchObject({ installed: true, download: null, error: null })
    expect(f.mock.calls.map((c) => String(c[0])).sort()).toEqual(SPEC.files.map((x) => voiceModelSourceUrl(SPEC, x.path)).sort())
    expect(fs.readFileSync(path.join(dir, 'whisper-base', 'onnx', 'model.onnx'), 'utf8')).toBe('model-bytes')
    expect(fs.existsSync(path.join(dir, '.partial-whisper-base'))).toBe(false)
    const progress = events.flatMap((e) => (e.type === 'voice.models' && e.models[0]?.download ? [e.models[0].download.loaded] : []))
    expect(progress.length).toBeGreaterThan(0)
    expect(progress.at(-1)).toBe(Object.values(FILES).join('').length)
  })

  it('does not download again once installed', async () => {
    const f = fakeFetch()
    const { models } = make(f)
    await models.download('whisper-base')
    f.mockClear()
    await models.download('whisper-base')
    expect(f).not.toHaveBeenCalled()
  })

  it('fails on a checksum mismatch and leaves nothing behind', async () => {
    const { models } = make(fakeFetch({ ...FILES, 'config.json': '{"a":2}' }))
    const after = await models.download('whisper-base')
    expect(after[0]).toMatchObject({ installed: false })
    expect(after[0]?.error).toMatch(/checksum/)
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('fails on a size mismatch', async () => {
    const { models } = make(fakeFetch({ ...FILES, 'onnx/model.onnx': 'short' }))
    expect((await models.download('whisper-base'))[0]?.error).toMatch(/bytes/)
  })

  it('reports a failed request', async () => {
    const { models } = make(fakeFetch({}))
    expect((await models.download('whisper-base'))[0]?.error).toMatch(/404/)
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('cancels a download in progress, with no error and no partial folder', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const f = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        async start(c) {
          c.enqueue(new TextEncoder().encode('{"a"'))
          await gate
          if (init?.signal?.aborted) c.error(new DOMException('aborted', 'AbortError'))
          else c.close()
        }
      })
      return new Response(stream)
    }) as unknown as typeof fetch
    const { models } = make(f)
    const running = models.download('whisper-base')
    await vi.waitFor(async () => expect((await models.statuses())[0]?.download?.loaded).toBeGreaterThan(0))
    await models.cancel('whisper-base')
    release()
    const after = await running
    expect(after[0]).toMatchObject({ installed: false, download: null, error: null })
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('treats a model with a wrong file size as not installed, and removes an installed one', async () => {
    const { models } = make(fakeFetch())
    await models.download('whisper-base')
    fs.appendFileSync(path.join(dir, 'whisper-base', 'config.json'), 'x')
    expect((await models.statuses())[0]?.installed).toBe(false)
    await models.download('whisper-base')
    expect((await models.statuses())[0]?.installed).toBe(true)
    expect((await models.remove('whisper-base'))[0]?.installed).toBe(false)
    expect(fs.existsSync(path.join(dir, 'whisper-base'))).toBe(false)
  })
})
