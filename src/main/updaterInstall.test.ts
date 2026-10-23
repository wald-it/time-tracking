/**
 * #198 — the update:install decision, tested through performUpdateInstall.
 *
 * The branch that matters is the refusal: while any MCP server still holds
 * the install directory, quitAndInstall must NOT run — handing over anyway is
 * exactly the state that produces "TimeTrack cannot be closed" with no window
 * to close. (updater.test.ts covers the status reducer; this file covers the
 * real module.)
 */
import { describe, it, expect, vi } from 'vitest'

// updater.ts imports electron, electron-log and electron-updater at module
// level; none of their behaviour is under test here.
vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0-test' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => undefined }
}))
vi.mock('electron-log/main', () => ({
  default: { info: () => undefined, warn: () => undefined, error: () => undefined }
}))
vi.mock('electron-updater', () => ({ default: { autoUpdater: {} } }))

import { performUpdateInstall, blockedByHoldersMessage } from './updater'
import type { Holder, ReleaseOutcome } from '../mcp/holders'

function holder(pid: number, startedAt = 1): Holder {
  return { pid, exe: 'C:\\App\\TimeTrack.exe', entry: 'C:\\App\\server.js', startedAt }
}

function outcome(over: Partial<ReleaseOutcome> = {}): ReleaseOutcome {
  return { ok: true, before: [], remaining: [], stale: [], requestedAt: null, ...over }
}

function deps(
  over: Partial<Parameters<typeof performUpdateInstall>[0]> = {}
): Parameters<typeof performUpdateInstall>[0] {
  return {
    getEndpointDir: () => 'C:\\data',
    release: async (): Promise<ReleaseOutcome> => outcome(),
    clear: vi.fn(),
    quitAndInstall: vi.fn(),
    notify: vi.fn(),
    logWarn: vi.fn(),
    logInfo: vi.fn(),
    locale: () => 'de',
    ...over
  }
}

describe('performUpdateInstall', () => {
  it('refuses and does not install while holders remain', async () => {
    const survivors = [holder(11), holder(99)]
    const d = deps({
      release: async () =>
        outcome({ ok: false, before: survivors, remaining: survivors, requestedAt: 500 })
    })
    const r = await performUpdateInstall(d)
    expect(r.ok).toBe(false)
    expect(d.quitAndInstall).not.toHaveBeenCalled()
    expect(d.notify).toHaveBeenCalledWith({
      status: 'error',
      message: blockedByHoldersMessage('de', survivors, 500)
    })
  })

  it('installs after every holder has withdrawn', async () => {
    const d = deps({
      release: async () => outcome({ before: [holder(11)], requestedAt: 500 })
    })
    const r = await performUpdateInstall(d)
    expect(r.ok).toBe(true)
    expect(d.quitAndInstall).toHaveBeenCalledTimes(1)
    expect(d.clear).not.toHaveBeenCalled()
  })

  it('logs pruned stale registrations without blocking the install (#201)', async () => {
    const d = deps({
      release: async () => outcome({ stale: [holder(41), holder(42)] })
    })
    const r = await performUpdateInstall(d)
    expect(r.ok).toBe(true)
    expect(d.quitAndInstall).toHaveBeenCalledTimes(1)
    expect(d.logInfo).toHaveBeenCalledWith(expect.stringContaining('2 stale'))
  })

  it('skips the handshake entirely without an endpoint dir', async () => {
    const release = vi.fn(async (): Promise<ReleaseOutcome> => outcome())
    const d = deps({ getEndpointDir: undefined, release })
    const r = await performUpdateInstall(d)
    expect(r.ok).toBe(true)
    expect(release).not.toHaveBeenCalled()
    expect(d.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('withdraws the shutdown request when the install throws', async () => {
    const d = deps({
      quitAndInstall: () => {
        throw new Error('nsis exploded')
      }
    })
    const r = await performUpdateInstall(d)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toContain('nsis exploded')
    expect(d.clear).toHaveBeenCalledWith('C:\\data')
  })
})

describe('blockedByHoldersMessage', () => {
  it('names every surviving pid, with plural grammar', () => {
    const m = blockedByHoldersMessage('de', [holder(11), holder(99)])
    expect(m).toContain('PID 11')
    expect(m).toContain('PID 99')
    expect(m).toContain('2 MCP-Server')
    expect(m).toContain('benutzen noch')
    expect(m).toContain('haben auf die')
  })

  it('uses singular grammar for a single survivor', () => {
    const m = blockedByHoldersMessage('de', [holder(7)])
    expect(m).toContain('1 MCP-Server')
    expect(m).toContain('benutzt noch')
    expect(m).toContain('hat auf die')
  })

  // #296 part B: from the locale files now; German word for word as the old
  // concatenation built it, English the same meaning.
  it('German exactly as before, English with the same parts', () => {
    expect(blockedByHoldersMessage('de', [holder(7, 900)], 500)).toBe(
      'Das Update kann nicht installiert werden: 1 MCP-Server (PID 7) benutzt noch die ' +
        'TimeTrack-Programmdatei und hat auf die Aufforderung zum Beenden nicht reagiert. ' +
        'Diese Prozesse haben kein Fenster — sie gehören zu einem laufenden AI-Client ' +
        '(Einstellungen → Integrationen). Beende den AI-Client und versuche es erneut. ' +
        'Mindestens einer dieser Server wurde erst während des Updates gestartet — solange ' +
        'der AI-Client läuft, startet er beendete Server automatisch neu.'
    )
    const en = blockedByHoldersMessage('en', [holder(11), holder(99)])
    expect(en).toMatch(
      /^The update cannot be installed: 2 MCP servers \(PID 11, PID 99\) still use /
    )
    expect(en).not.toContain('started during the update')
  })

  it('covers the started-mid-update case instead of blaming the newcomer (#201)', () => {
    // registered after the request went out — the AI client respawned it
    const late = holder(7, 900)
    expect(blockedByHoldersMessage('de', [late], 500)).toContain('während des Updates gestartet')
    // all survivors predate the request — no mid-update sentence
    const early = holder(7, 100)
    expect(blockedByHoldersMessage('de', [early], 500)).not.toContain('während des Updates')
    // without a request timestamp the message stays as before
    expect(blockedByHoldersMessage('de', [late])).not.toContain('während des Updates')
  })
})
