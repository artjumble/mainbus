import { describe, expect, it } from 'vitest'
import { microphoneError } from './micAudioSource'

describe('microphoneError', () => {
  const denied = Object.assign(new Error('denied'), { name: 'NotAllowedError' })

  it('points macOS users to System Settings', () => {
    const e = microphoneError(denied, true)
    expect(e.kind).toBe('denied')
    expect(e.message).toContain('System Settings › Privacy & Security › Microphone')
  })

  it('points other users to Windows Settings', () => {
    expect(microphoneError(denied, false).message).toContain('Windows Settings')
  })
})
