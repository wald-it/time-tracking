/**
 * Native dialogs of the main process follow the app language (#270).
 *
 * The German texts are pinned word for word: they are the wording the app
 * shipped with, and moving them into the locale files must not change them.
 * The last block guards the call sites: no dialog in src/main may carry a
 * text literal again.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { translateLiteral } from '../shared/i18n'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'
import {
  dbErrorDialog,
  dialogT,
  hotkeyConflictDialog,
  localeFromSetting,
  localeFromSystem,
  mcpConfirmDialog,
  migrationErrorDialog,
  readLanguage,
  readLanguageOr
} from './mainI18n'

let DatabaseImpl: DatabaseCtor
beforeAll(async () => {
  DatabaseImpl = await loadSqlite()
})

describe('the language of a main-process dialog', () => {
  it('follows the renderer rule: en is English, anything else German', () => {
    expect(localeFromSetting('en')).toBe('en')
    expect(localeFromSetting('de')).toBe('de')
    expect(localeFromSetting(undefined)).toBe('de')
    expect(localeFromSetting('fr')).toBe('de')
  })

  it('is read from the settings table and switches with it', () => {
    const db = new DatabaseImpl(':memory:')
    applyMigrations(db)
    expect(readLanguage(db)).toBe('de')
    db.prepare(`UPDATE settings SET value = 'en' WHERE key = 'language'`).run()
    expect(readLanguage(db)).toBe('en')
    expect(dialogT(readLanguage(db))('mainDialog.pdf.saveTitle')).toBe('Save timesheet')
    expect(readLanguageOr(db, () => 'de')).toBe('en')
    db.close()
  })

  it('with the handle closed (after a restore attempt): the fallback', () => {
    const db = new DatabaseImpl(':memory:')
    applyMigrations(db)
    db.prepare(`UPDATE settings SET value = 'en' WHERE key = 'language'`).run()
    db.close()
    expect(() => readLanguage(db)).toThrow()
    expect(readLanguageOr(db, () => 'de')).toBe('de')
  })

  it('before the database is open: the first system language', () => {
    expect(localeFromSystem(['de-DE', 'en-US'])).toBe('de')
    expect(localeFromSystem(['de'])).toBe('de')
    expect(localeFromSystem(['DE-at'])).toBe('de')
    expect(localeFromSystem(['de_DE'])).toBe('de')
    expect(localeFromSystem(['de_DE.UTF-8'])).toBe('de')
    expect(localeFromSystem(['en-GB', 'de-DE'])).toBe('en')
    expect(localeFromSystem(['dev'])).toBe('en')
    expect(localeFromSystem([])).toBe('en')
  })
})

describe('values are filled in literally', () => {
  it('a value that looks like a slot stays as written', () => {
    const strings = { k: '{a} and {b}' }
    expect(translateLiteral(strings, 'k', { a: '{b}', b: 'B' })).toBe('{b} and B')
    expect(translateLiteral(strings, 'k', { a: 'A' })).toBe('A and {b}')
  })
})

describe('mcpBridge.ts — the write confirmation', () => {
  it('German, byte for byte as before; Allow stays index 1 and the default', () => {
    expect(mcpConfirmDialog('de', 'S')).toEqual({
      type: 'question',
      buttons: ['Ablehnen', 'Erlauben'],
      defaultId: 1,
      cancelId: 0,
      noLink: true,
      title: 'TimeTrack — MCP-Schreibzugriff',
      message: 'Claude möchte eine Änderung in TimeTrack vornehmen:',
      detail: 'S',
      checkboxLabel: 'Für diese Session merken (nicht mehr fragen)',
      checkboxChecked: false
    })
  })

  it('English with the same buttons in the same places', () => {
    const o = mcpConfirmDialog('en', 'S')
    expect(o.buttons).toEqual(['Deny', 'Allow'])
    expect([o.defaultId, o.cancelId]).toEqual([1, 0])
    expect(o.title).toBe('TimeTrack — MCP write access')
    expect(o.message).toBe('Claude wants to make a change in TimeTrack:')
    expect(o.checkboxLabel).toBe('Remember for this session (stop asking)')
  })
})

describe('index.ts — the dialogs at start', () => {
  it('hotkey conflict, German as before and English', () => {
    expect(hotkeyConflictDialog('de', 'Alt+Shift+M')).toEqual({
      title: 'TimeTrack — Hotkey-Konflikt',
      message: 'Der Mini-Widget-Hotkey "Alt+Shift+M" konnte nicht registriert werden.',
      detail:
        'Eine andere Anwendung verwendet diese Tastenkombination bereits.\n\n' +
        'Du kannst in den Einstellungen einen anderen Hotkey wählen.',
      buttons: ['OK']
    })
    expect(hotkeyConflictDialog('en', 'Alt+Shift+M').message).toBe(
      'The mini widget hotkey "Alt+Shift+M" could not be registered.'
    )
  })

  it('migration error, German as before and English', () => {
    const e = { version: 27, name: 'n', cause: 'boom {backupPath}', backupPath: 'C:\\b.sqlite' }
    expect(migrationErrorDialog('de', e)).toEqual({
      title: 'TimeTrack — Datenbank-Migration fehlgeschlagen',
      message:
        `Migration #27 (n) ist fehlgeschlagen:\n\n` +
        `boom {backupPath}\n\n` +
        `Deine Datenbank wurde aus dem Pre-Migration-Backup wiederhergestellt:\nC:\\b.sqlite\n\n` +
        `Die App wird jetzt beendet. Bitte melde diesen Fehler.`
    })
    expect(migrationErrorDialog('en', e).title).toBe('TimeTrack — Database migration failed')
    expect(migrationErrorDialog('en', e).message).toMatch(/^Migration #27 \(n\) failed:/)
  })

  it('database error, German as before and English', () => {
    expect(dbErrorDialog('de', 'locked')).toEqual({
      title: 'TimeTrack — Datenbankfehler',
      message: 'Datenbank konnte nicht geöffnet werden:\n\nlocked'
    })
    expect(dbErrorDialog('en', 'locked')).toEqual({
      title: 'TimeTrack — Database error',
      message: 'The database could not be opened:\n\nlocked'
    })
  })
})

describe('no dialog text is written into a call site', () => {
  // Filter names that are format names, the same in every language.
  const FORMAT_NAMES = new Set(['CSV', 'iCalendar', 'JSON', 'PDF'])

  function sources(): Array<[string, string]> {
    return readdirSync(__dirname)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map((f) => [f, readFileSync(join(__dirname, f), 'utf8')])
  }

  it('finds the dialog call sites it guards', () => {
    const withDialogs = sources().filter(([, src]) => /dialog\.show\w+\(/.test(src))
    expect(withDialogs.map(([f]) => f).sort()).toEqual(
      [
        'csvExport.ts',
        'icalExport.ts',
        'index.ts',
        'ipc.ts',
        'mcpBridge.ts',
        'pdfMergeHandlers.ts'
      ].sort()
    )
  })

  it('titles, messages, buttons and filter names come from the locale files', () => {
    const literal =
      /\b(title|message|detail|checkboxLabel):\s*['"`]|buttons:\s*\[\s*['"`]|showErrorBox\(\s*['"`]/
    for (const [file, src] of sources()) {
      if (!/dialog\.show\w+\(|showSaveDialog/.test(src)) continue
      expect(literal.exec(src)?.[0], file).toBeUndefined()
      for (const m of src.matchAll(/filters:\s*\[\s*\{\s*name:\s*'([^']*)'/g)) {
        expect(FORMAT_NAMES.has(m[1]), `${file}: filter name ${m[1]}`).toBe(true)
      }
    }
  })
})
