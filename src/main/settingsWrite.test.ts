/**
 * #272 — `settings:set` accepts only the keys the UI writes, and
 * `settings:getSync` answers only the theme key.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import type Database from 'better-sqlite3'
import { loadSqlite, type DatabaseCtor } from '../test/sqlite'
import { DEFAULT_CLIENT_ID } from '../shared/graphAuth'
import type { IpcHooks } from './ipc'
import type { HotkeyChange } from './hotkeySlot'
import {
  RENDERER_WRITABLE_SETTINGS,
  readSettingSync,
  sensitiveSettingChange,
  writeSettingFromRenderer,
  type SensitiveSettingChange
} from './settingsWrite'

let DatabaseImpl: DatabaseCtor
beforeAll(async () => {
  DatabaseImpl = await loadSqlite()
})

let db: Database.Database
let calls: string[]
let answer: boolean
let asked: SensitiveSettingChange[]

/** `hotkey` is what the shortcut hooks answer: accepted unless said otherwise. */
function hooks(hotkey: HotkeyChange = { ok: true }): IpcHooks {
  const record =
    (name: string) =>
    (...args: unknown[]): boolean => {
      calls.push(`${name}(${args.join(',')})`)
      return true
    }
  const hotkeyHook =
    (name: string) =>
    (accelerator: string): HotkeyChange => {
      calls.push(`${name}(${accelerator})`)
      return hotkey
    }
  return {
    refreshTrayClients: record('refreshTrayClients'),
    refreshTrayLanguage: record('refreshTrayLanguage'),
    setHotkey: hotkeyHook('setHotkey'),
    setAutoStart: record('setAutoStart'),
    setIdleThreshold: record('setIdleThreshold'),
    setMiniEnabled: record('setMiniEnabled'),
    setMiniHotkey: hotkeyHook('setMiniHotkey'),
    setMcpWriteEnabled: record('setMcpWriteEnabled'),
    setControllerEnabled: record('setControllerEnabled'),
    pokePresence: record('pokePresence'),
    setIcalFeedEnabled: record('setIcalFeedEnabled'),
    restartIcalFeed: record('restartIcalFeed'),
    forgetMcpApproval: record('forgetMcpApproval'),
    getMcpApprovalState: () => ({ state: 'off' }),
    confirmSensitiveSetting: async (change) => {
      asked.push(change)
      return answer
    }
  }
}

function stored(key: string): string | undefined {
  return (
    db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  )?.value
}

beforeEach(() => {
  db = new DatabaseImpl(':memory:')
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  db.prepare("INSERT INTO settings (key, value) VALUES ('backup_path', '')").run()
  db.prepare("INSERT INTO settings (key, value) VALUES ('theme_mode', 'dark')").run()
  db.prepare("INSERT INTO settings (key, value) VALUES ('ical_feed_token', 'secret')").run()
  calls = []
  answer = true
  asked = []
})

afterEach(() => {
  db.close()
})

describe('settings:set allow-list', () => {
  it.each([
    ['target_hours_week', '16.5'],
    ['target_rate_cent', '9550']
  ])('stores and clears optional target %s without side effects', async (key, value) => {
    expect(await writeSettingFromRenderer(db, hooks(), key, value)).toEqual({
      ok: true,
      data: undefined
    })
    expect(stored(key)).toBe(value)
    expect(await writeSettingFromRenderer(db, hooks(), key, '')).toEqual({
      ok: true,
      data: undefined
    })
    expect(stored(key)).toBe('')
    expect(calls).toEqual([])
    expect(asked).toEqual([])
  })
  it('returns the error message without the Error prefix when a hook throws', async () => {
    const failingHooks = hooks()
    failingHooks.setHotkey = () => {
      throw new Error('Hotkey registration failed')
    }
    const result = await writeSettingFromRenderer(db, failingHooks, 'hotkey_toggle', 'Alt+Shift+T')
    expect(result).toEqual({ ok: false, error: 'Hotkey registration failed' })
  })

  it('stores an allowed key and applies its side effect', async () => {
    const res = await writeSettingFromRenderer(db, hooks(), 'hotkey_toggle', 'Alt+Shift+T')
    expect(res).toEqual({ ok: true, data: undefined })
    expect(stored('hotkey_toggle')).toBe('Alt+Shift+T')
    expect(calls).toEqual(['setHotkey(Alt+Shift+T)'])
  })

  // #292: refused by the shortcut hook, the stored hotkey stays what the OS
  // still has registered.
  it.each(['hotkey_toggle', 'mini_hotkey'])(
    '%s refused by the OS: stored value unchanged, previous one kept',
    async (key) => {
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, 'Alt+Shift+S')
      const res = await writeSettingFromRenderer(
        db,
        hooks({ ok: false, reason: 'refused', previousKept: true }),
        key,
        'Ctrl+Alt+Del'
      )
      expect(res).toEqual({
        ok: false,
        error: 'Hotkey "Ctrl+Alt+Del" konnte nicht registriert werden.'
      })
      expect(stored(key)).toBe('Alt+Shift+S')
    }
  )

  it('refused, and the previous hotkey is lost as well: says both, stores nothing new', async () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('hotkey_toggle', 'Alt+Shift+S')").run()
    const res = await writeSettingFromRenderer(
      db,
      hooks({ ok: false, reason: 'refused', previousKept: false }),
      'hotkey_toggle',
      'Ctrl+Alt+Del'
    )
    expect(res).toEqual({
      ok: false,
      error:
        'Hotkey "Ctrl+Alt+Del" konnte nicht registriert werden. Der bisherige Hotkey ist jetzt auch nicht mehr aktiv.'
    })
    expect(stored('hotkey_toggle')).toBe('Alt+Shift+S')
  })

  it('storing fails after the new hotkey was registered: reported, no rollback (accepted gap)', async () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('hotkey_toggle', 'Alt+Shift+S')").run()
    db.exec(
      "CREATE TRIGGER no_write BEFORE INSERT ON settings WHEN NEW.key = 'hotkey_toggle' " +
        "BEGIN SELECT RAISE(ABORT, 'database is locked'); END"
    )
    const res = await writeSettingFromRenderer(db, hooks(), 'hotkey_toggle', 'Ctrl+Alt+T')
    expect(res).toEqual({ ok: false, error: expect.stringMatching(/database is locked/) })
    expect(stored('hotkey_toggle')).toBe('Alt+Shift+S')
    expect(calls).toEqual(['setHotkey(Ctrl+Alt+T)'])
  })

  // #296: the tray follows a language change at once, not at the next timer event.
  it('a language change rebuilds the tray and re-renders presence', async () => {
    const res = await writeSettingFromRenderer(db, hooks(), 'language', 'en')
    expect(res).toEqual({ ok: true, data: undefined })
    expect(calls).toEqual(['pokePresence()', 'refreshTrayLanguage()'])
  })

  it('a failing tray rebuild does not report the saved language change as failed', async () => {
    const h = hooks()
    h.refreshTrayLanguage = () => {
      throw new Error('tray destroyed')
    }
    const res = await writeSettingFromRenderer(db, h, 'language', 'en')
    expect(res).toEqual({ ok: true, data: undefined })
    expect(stored('language')).toBe('en')
  })

  it('a failing presence re-render neither fails the change nor skips the tray', async () => {
    const h = hooks()
    h.pokePresence = () => {
      throw new Error('graph state not ready')
    }
    const res = await writeSettingFromRenderer(db, h, 'language', 'en')
    expect(res).toEqual({ ok: true, data: undefined })
    expect(calls).toEqual(['refreshTrayLanguage()'])
  })

  it('refuses an unknown key and writes nothing', async () => {
    const res = await writeSettingFromRenderer(db, hooks(), 'something_new', 'x')
    expect(res.ok).toBe(false)
    expect(stored('something_new')).toBeUndefined()
    expect(calls).toEqual([])
  })

  it.each(['backup_path', 'pdf_logo_path', 'window_bounds', 'ical_feed_token'])(
    'refuses %s, which only the main process writes',
    async (key) => {
      const before = stored(key)
      const res = await writeSettingFromRenderer(db, hooks(), key, 'C:\\elsewhere')
      expect(res.ok).toBe(false)
      expect(stored(key)).toBe(before)
    }
  )

  it('refuses a key or value that is not a string', async () => {
    expect(
      (await writeSettingFromRenderer(db, hooks(), { toString: () => 'theme_mode' }, 'x')).ok
    ).toBe(false)
    expect((await writeSettingFromRenderer(db, hooks(), 'theme_mode', 1)).ok).toBe(false)
    expect(stored('theme_mode')).toBe('dark')
  })

  // RendererSettingKey rejects writes to keys outside the list at compile time.
  // Keep the reverse check: every allowed key must still have a renderer writer.
  it('every allowed key is still written somewhere in the renderer', () => {
    const root = join(__dirname, '..', 'renderer', 'src')
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.tsx?$/.test(name) && !/\.(test|typecheck)\.tsx?$/.test(name)) files.push(p)
      }
    }
    walk(root)
    const written = new Set<string>()
    const call = /(?:settings\.set|setSetting|\bupdate)\(\s*['"`]([a-z_]+)['"`]/g
    // SettingsView writes the two hotkeys through a variable typed by this union.
    const hotkeyUnion = /type HotkeyKey = ([^\n]+)/
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      for (const m of src.matchAll(call)) written.add(m[1])
      const union = src.match(hotkeyUnion)
      if (union) for (const m of union[1].matchAll(/'([a-z_]+)'/g)) written.add(m[1])
    }
    // The scan must find something, or a changed call shape would pass vacuously.
    expect(written.size).toBeGreaterThan(20)
    expect(written.has('mini_hotkey')).toBe(true)
    // A key nothing writes any more leaves the list.
    const unused = [...RENDERER_WRITABLE_SETTINGS].filter((k) => !written.has(k))
    expect(unused).toEqual([])
  })
})

describe('settings:getSync', () => {
  it('answers the theme key', () => {
    expect(readSettingSync(db, 'theme_mode')).toBe('dark')
  })

  // A narrower surface, not secrecy: the window reads settings through
  // settings:getAll and the feed URL through icalFeed:url anyway.
  it('answers nothing else, not even an existing key', () => {
    expect(readSettingSync(db, 'ical_feed_token')).toBeNull()
    expect(readSettingSync(db, 42)).toBeNull()
  })
})

// #272 (A3): a change that widens access to the user's data is stored only
// after the native confirmation; switching off, clearing and removing never ask.
describe('sensitive settings ask first', () => {
  const target = (url: string, enabled = true): Record<string, unknown> => ({
    id: url,
    url,
    secret: '',
    events: ['timer.started'],
    enabled
  })
  const targets = (...t: Record<string, unknown>[]): string => JSON.stringify(t)
  const A = 'https://hooks.example.com/a'
  const B = 'https://hooks.example.com/b'

  it.each([
    ['mcp_write_enabled', '0', '1', { kind: 'mcpWrite' }],
    ['controller_enabled', '0', '1', { kind: 'controller' }],
    ['mcp_write_confirm_mode', 'per-write', 'silent', { kind: 'silent' }],
    ['webhook_targets', '[]', targets(target(A)), { kind: 'webhook', urls: [A] }],
    [
      'webhook_targets',
      targets(target(A)),
      targets(target(A), target(B)),
      { kind: 'webhook', urls: [B] }
    ],
    [
      'webhook_targets',
      targets(target(A, false)),
      targets(target(A)),
      { kind: 'webhook', urls: [A] }
    ],
    ['graph_client_id', '', ' 1234-abcd ', { kind: 'graphClientId', id: '1234-abcd' }]
  ])('%s %s → %s asks', (key, before, after, expected) => {
    expect(sensitiveSettingChange(key, after, before)).toEqual(expected)
  })

  it.each([
    ['mcp_write_enabled', '1', '0'],
    ['mcp_write_enabled', '1', '1'],
    ['controller_enabled', '1', '0'],
    ['mcp_write_confirm_mode', 'silent', 'per-write'],
    ['mcp_write_confirm_mode', 'per-write', 'session'],
    ['webhook_targets', targets(target(A)), '[]'],
    ['webhook_targets', targets(target(A)), targets(target(A, false))],
    ['webhook_targets', targets(target(A)), targets({ ...target(A), secret: 's' })],
    ['webhook_targets', '[]', targets(target('https://'))],
    ['graph_client_id', 'x', ''],
    ['graph_client_id', 'x', ' x '],
    ['theme_mode', 'light', 'dark']
  ])('%s %s → %s does not ask', (key, before, after) => {
    expect(sensitiveSettingChange(key, after, before)).toBeNull()
  })

  it('asks on the first write too, when nothing is stored yet', () => {
    expect(sensitiveSettingChange('mcp_write_enabled', '1', undefined)).toEqual({
      kind: 'mcpWrite'
    })
  })

  it('stores a confirmed change and applies its side effect', async () => {
    const res = await writeSettingFromRenderer(db, hooks(), 'mcp_write_enabled', '1')
    expect(res).toEqual({ ok: true, data: undefined })
    expect(asked).toEqual([{ kind: 'mcpWrite' }])
    expect(stored('mcp_write_enabled')).toBe('1')
    expect(calls).toEqual(['setMcpWriteEnabled(true)'])
  })

  it('a declined change writes nothing, runs no side effect and says cancelled', async () => {
    answer = false
    const res = await writeSettingFromRenderer(db, hooks(), 'webhook_targets', targets(target(A)))
    expect(res).toMatchObject({ ok: false, code: 'cancelled' })
    expect(stored('webhook_targets')).toBeUndefined()
    expect(calls).toEqual([])
  })

  it('switching off goes through without asking', async () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('controller_enabled', '1')").run()
    answer = false
    const res = await writeSettingFromRenderer(db, hooks(), 'controller_enabled', '0')
    expect(res.ok).toBe(true)
    expect(asked).toEqual([])
    expect(stored('controller_enabled')).toBe('0')
  })
})

describe('sensitive settings: review round 1', () => {
  it('setting TimeTrack’s own app id does not ask', () => {
    expect(sensitiveSettingChange('graph_client_id', DEFAULT_CLIENT_ID, '')).toBeNull()
    expect(sensitiveSettingChange('graph_client_id', DEFAULT_CLIENT_ID, undefined)).toBeNull()
  })

  // A write that overtook an open confirmation used to be overwritten by it,
  // and the confirmed write had been decided against a value no longer stored.
  it('writes run one after another, a later one sees the earlier result', async () => {
    let release: (v: boolean) => void = () => {}
    const h = hooks()
    h.confirmSensitiveSetting = (change) => {
      asked.push(change)
      return new Promise<boolean>((r) => (release = r))
    }
    const A = 'https://hooks.example.com/a'
    const first = writeSettingFromRenderer(
      db,
      h,
      'webhook_targets',
      JSON.stringify([{ id: 'a', url: A, secret: '', events: ['timer.started'], enabled: true }])
    )
    const second = writeSettingFromRenderer(db, h, 'webhook_targets', '[]')
    await new Promise((r) => setTimeout(r, 10))
    // The second write waits for the first one's dialog.
    expect(stored('webhook_targets')).toBeUndefined()
    release(true)
    expect((await first).ok).toBe(true)
    expect((await second).ok).toBe(true)
    expect(stored('webhook_targets')).toBe('[]')
    expect(asked).toHaveLength(1)
  })
})

describe('#301: a confirm-mode change ends the approval', () => {
  it('any change of the mode forgets the approval', async () => {
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('mcp_write_confirm_mode', 'session')"
    ).run()
    await writeSettingFromRenderer(db, hooks(), 'mcp_write_confirm_mode', 'per-write')
    expect(calls).toEqual(['forgetMcpApproval()'])
  })

  it('writing the same mode again does not', async () => {
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('mcp_write_confirm_mode', 'session')"
    ).run()
    await writeSettingFromRenderer(db, hooks(), 'mcp_write_confirm_mode', 'session')
    expect(calls).toEqual([])
  })
})
