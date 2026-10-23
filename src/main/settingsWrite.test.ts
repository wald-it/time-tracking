/**
 * #272 — `settings:set` accepts only the keys the UI writes, and
 * `settings:getSync` answers only the theme key.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import type Database from 'better-sqlite3'
import { loadSqlite, type DatabaseCtor } from '../test/sqlite'
import type { IpcHooks } from './ipc'
import type { HotkeyChange } from './hotkeySlot'
import {
  RENDERER_WRITABLE_SETTINGS,
  readSettingSync,
  writeSettingFromRenderer
} from './settingsWrite'

let DatabaseImpl: DatabaseCtor
beforeAll(async () => {
  DatabaseImpl = await loadSqlite()
})

let db: Database.Database
let calls: string[]

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
    setHotkey: hotkeyHook('setHotkey'),
    setAutoStart: record('setAutoStart'),
    setIdleThreshold: record('setIdleThreshold'),
    setMiniEnabled: record('setMiniEnabled'),
    setMiniHotkey: hotkeyHook('setMiniHotkey'),
    setMcpWriteEnabled: record('setMcpWriteEnabled'),
    setControllerEnabled: record('setControllerEnabled'),
    pokePresence: record('pokePresence'),
    setIcalFeedEnabled: record('setIcalFeedEnabled'),
    restartIcalFeed: record('restartIcalFeed')
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
})

afterEach(() => {
  db.close()
})

describe('settings:set allow-list', () => {
  it('stores an allowed key and applies its side effect', () => {
    const res = writeSettingFromRenderer(db, hooks(), 'hotkey_toggle', 'Alt+Shift+T')
    expect(res).toEqual({ ok: true, data: undefined })
    expect(stored('hotkey_toggle')).toBe('Alt+Shift+T')
    expect(calls).toEqual(['setHotkey(Alt+Shift+T)'])
  })

  // #292: refused by the shortcut hook, the stored hotkey stays what the OS
  // still has registered.
  it.each(['hotkey_toggle', 'mini_hotkey'])(
    '%s refused by the OS: stored value unchanged, previous one kept',
    (key) => {
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, 'Alt+Shift+S')
      const res = writeSettingFromRenderer(
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

  it('refused, and the previous hotkey is lost as well: says both, stores nothing new', () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('hotkey_toggle', 'Alt+Shift+S')").run()
    const res = writeSettingFromRenderer(
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

  it('storing fails after the new hotkey was registered: reported, no rollback (accepted gap)', () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('hotkey_toggle', 'Alt+Shift+S')").run()
    db.exec(
      "CREATE TRIGGER no_write BEFORE INSERT ON settings WHEN NEW.key = 'hotkey_toggle' " +
        "BEGIN SELECT RAISE(ABORT, 'database is locked'); END"
    )
    const res = writeSettingFromRenderer(db, hooks(), 'hotkey_toggle', 'Ctrl+Alt+T')
    expect(res).toEqual({ ok: false, error: expect.stringMatching(/database is locked/) })
    expect(stored('hotkey_toggle')).toBe('Alt+Shift+S')
    expect(calls).toEqual(['setHotkey(Ctrl+Alt+T)'])
  })

  it('refuses an unknown key and writes nothing', () => {
    const res = writeSettingFromRenderer(db, hooks(), 'something_new', 'x')
    expect(res.ok).toBe(false)
    expect(stored('something_new')).toBeUndefined()
    expect(calls).toEqual([])
  })

  it.each(['backup_path', 'pdf_logo_path', 'window_bounds', 'ical_feed_token'])(
    'refuses %s, which only the main process writes',
    (key) => {
      const before = stored(key)
      const res = writeSettingFromRenderer(db, hooks(), key, 'C:\\elsewhere')
      expect(res.ok).toBe(false)
      expect(stored(key)).toBe(before)
    }
  )

  it('refuses a key or value that is not a string', () => {
    expect(writeSettingFromRenderer(db, hooks(), { toString: () => 'theme_mode' }, 'x').ok).toBe(
      false
    )
    expect(writeSettingFromRenderer(db, hooks(), 'theme_mode', 1).ok).toBe(false)
    expect(stored('theme_mode')).toBe('dark')
  })

  // The inverse failure: a key the UI writes that the list forgets would be
  // refused, and the setting would silently not save. Every string literal the
  // renderer passes as a settings key must be on the list.
  it('covers every settings key the renderer source writes', () => {
    const root = join(__dirname, '..', 'renderer', 'src')
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(p)
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
    const missing = [...written].filter((k) => !RENDERER_WRITABLE_SETTINGS.has(k))
    expect(missing).toEqual([])
    // And the other way round: a key nothing writes any more leaves the list,
    // so the list cannot grow into "anything goes".
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
