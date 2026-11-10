import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { iconDir, TRAY_SIZES, trayIconFile, windowIconFile } from './appIcon'

const repo = path.resolve(import.meta.dirname, '..', '..')

/** A PNG's width and height, from its IHDR chunk. */
function pngSize(file: string): { width: number; height: number } {
  const head = fs.readFileSync(file).subarray(0, 24)
  expect(head.subarray(1, 4).toString()).toBe('PNG')
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) }
}

describe('iconDir', () => {
  test('is resources/icons in the repo in development', () => {
    expect(iconDir({ packaged: false, resourcesPath: 'C:\\electron\\resources', appPath: 'C:\\repo' })).toBe(
      path.join('C:\\repo', 'resources', 'icons')
    )
  })

  test("is the packaged app's resources\\icons, where extraResources copies them", () => {
    expect(iconDir({ packaged: true, resourcesPath: 'C:\\Mainbus\\resources', appPath: 'C:\\Mainbus\\resources\\app.asar' })).toBe(
      path.join('C:\\Mainbus\\resources', 'icons')
    )
  })

  test('electron-builder copies resources/icons to icons', () => {
    const yml = fs.readFileSync(path.join(repo, 'electron-builder.yml'), 'utf8')
    expect(yml).toMatch(/- from: resources\/icons\s+to: icons/)
    expect(yml).toMatch(/icon: build\/icon\.ico/)
  })
})

describe('the icon files the app loads', () => {
  const dir = iconDir({ packaged: false, resourcesPath: '', appPath: repo })

  test('the window icon is a 256 px PNG', () => {
    expect(pngSize(windowIconFile(dir))).toEqual({ width: 256, height: 256 })
  })

  test.each(['black', 'white'] as const)('the %s tray glyph is there at every tray size', (shade) => {
    for (const size of TRAY_SIZES) expect(pngSize(trayIconFile(dir, shade, size))).toEqual({ width: size, height: size })
  })
})
