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

function hooks(): IpcHooks {
  const record =
    (name: string) =>
    (...args: unknown[]): boolean => {
      calls.push(`${name}(${args.join(',')})`)
      return true
    }
  return {
    refreshTrayClients: record('refreshTrayClients'),
    setHotkey: record('setHotkey'),
    setAutoStart: record('setAutoStart'),
    setIdleThreshold: record('setIdleThreshold'),
    setMiniEnabled: record('setMiniEnabled'),
    setMiniHotkey: record('setMiniHotkey'),
    setMcpWriteEnabled: record('setMcpWriteEnabled'),
    setControllerEnabled: record('setControllerEnabled'),
    pokePresence: record('pokePresence'),
    setIcalFeedEnabled: record('setIcalFeedEnabled'),
    restartIcalFeed: record('restartIcalFeed'),
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
  it('stores an allowed key and applies its side effect', async () => {
    const res = await writeSettingFromRenderer(db, hooks(), 'hotkey_toggle', 'Alt+Shift+T')
    expect(res).toEqual({ ok: true, data: undefined })
    expect(stored('hotkey_toggle')).toBe('Alt+Shift+T')
    expect(calls).toEqual(['setHotkey(Alt+Shift+T)'])
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
