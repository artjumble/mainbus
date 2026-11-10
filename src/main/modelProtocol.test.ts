import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { modelFilePath } from './modelProtocol'

const DIR = path.resolve(path.sep, 'data', 'models')

describe('modelFilePath', () => {
  test('maps a model file to its place in the models folder', () => {
    expect(modelFilePath('mainbus-model://models/whisper-base/config.json', DIR)).toBe(path.join(DIR, 'whisper-base', 'config.json'))
    expect(modelFilePath('mainbus-model://models/whisper-base/onnx/encoder_model.onnx', DIR)).toBe(
      path.join(DIR, 'whisper-base', 'onnx', 'encoder_model.onnx')
    )
  })

  test.each([
    'mainbus-model://models/../secret.txt',
    'mainbus-model://models/whisper-base/../../secret.txt',
    'mainbus-model://models/whisper-base/%2e%2e/%2e%2e/secret.txt',
    'mainbus-model://models/whisper-base/..%2fsecret.txt',
    'mainbus-model://models/whisper-base/%5c..%5csecret.txt',
    'mainbus-model://models/C:/Windows/win.ini',
    'mainbus-model://models/C%3A/Windows/win.ini',
    'mainbus-model://models//etc/passwd',
    'mainbus-model://other/whisper-base/config.json',
    'mainbus-model://models/.partial-whisper-base/config.json',
    'mainbus-model://models/whisper-base',
    'mainbus-model://models/',
    'https://models/whisper-base/config.json',
    'file:///etc/passwd',
    'not a url',
    'mainbus-model://models/whisper-base/%zz'
  ])('refuses %s', (url) => {
    expect(modelFilePath(url, DIR)).toBeNull()
  })
})
