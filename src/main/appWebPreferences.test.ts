/**
 * #272 — the app windows run sandboxed, through one shared set of web
 * preferences; the preload stays within what a sandboxed preload may use.
 * The package smoke (scripts/package-smoke.mjs) proves the same in the
 * packaged app; these checks fail fast in every test run.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { appWebPreferences } from './appWebPreferences'

describe('appWebPreferences', () => {
  it('sandboxes the renderer and keeps Node out of it', () => {
    expect(appWebPreferences('p.js')).toEqual({
      preload: 'p.js',
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    })
  })

  it.each(['index.ts', 'miniWindow.ts'])('%s builds its window with it', (file) => {
    const src = readFileSync(join(__dirname, file), 'utf8')
    expect(src).toContain('webPreferences: appWebPreferences()')
    expect(src).not.toMatch(/sandbox:\s*false/)
  })
})

// A sandboxed preload can load only 'electron' (its contextBridge and
// ipcRenderer) and, from Electron 45 on (#354), loses Buffer,
// setImmediate/clearImmediate and the events/timers/url shims.
describe('the preload under the sandbox', () => {
  const src = readFileSync(join(__dirname, '..', 'preload', 'index.ts'), 'utf8')

  it("imports nothing at run time but 'electron'", () => {
    const runtimeImports = [...src.matchAll(/^import (?!type )[^\n]*from '([^']+)'/gm)].map(
      (m) => m[1]
    )
    expect(runtimeImports).toEqual(['electron'])
    expect(src).not.toMatch(/\brequire\(/)
  })

  it('uses none of the shims Electron 45 removes', () => {
    for (const name of [
      'Buffer',
      'setImmediate',
      'clearImmediate',
      "'events'",
      "'timers'",
      "'url'"
    ]) {
      expect(src, name).not.toContain(name)
    }
  })
})
