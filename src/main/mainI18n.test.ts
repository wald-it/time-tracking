/**
 * Native dialogs of the main process follow the app language (#270).
 *
 * The German texts are pinned word for word: they are the wording the app
 * shipped with, and moving them into the locale files must not change them.
 * The last block is a text heuristic over the files directly under src/main
 * that mention `dialog.show…(` or `showSaveDialog`: it catches the usual ways
 * a dialog text gets written in by hand (a literal or a CAPS constant after
 * the option keys, as the first argument of showErrorBox, a non-format filter
 * name). It is no proof: the exact forms are in the regexes below, and text
 * that reaches a dialog any other way is not seen.
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
  readLanguageOr,
  sensitiveSettingDialog
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
  // The checkbox names the bounded approval since #301 (owner-approved text).
  it('German, byte for byte; Allow stays index 1 and the default', () => {
    expect(mcpConfirmDialog('de', 'S')).toEqual({
      type: 'question',
      buttons: ['Ablehnen', 'Erlauben'],
      defaultId: 1,
      cancelId: 0,
      noLink: true,
      title: 'TimeTrack — MCP-Schreibzugriff',
      message: 'Claude möchte eine Änderung in TimeTrack vornehmen:',
      detail: 'S',
      checkboxLabel: 'Start und Stopp 30 Minuten lang ohne Nachfrage erlauben',
      checkboxChecked: false
    })
  })

  it('English with the same buttons in the same places', () => {
    const o = mcpConfirmDialog('en', 'S')
    expect(o.buttons).toEqual(['Deny', 'Allow'])
    expect([o.defaultId, o.cancelId]).toEqual([1, 0])
    expect(o.title).toBe('TimeTrack — MCP write access')
    expect(o.message).toBe('Claude wants to make a change in TimeTrack:')
    expect(o.checkboxLabel).toBe('Allow start and stop without asking for 30 minutes')
  })
})

describe('index.ts — the confirmation of a sensitive setting (#272 A3)', () => {
  it('cancel is index 0, the default and Esc; confirm is index 1', () => {
    const o = sensitiveSettingDialog('de', { kind: 'mcpWrite' })
    expect(o.buttons).toEqual(['Abbrechen', 'Einschalten'])
    expect([o.defaultId, o.cancelId]).toEqual([0, 0])
    expect(o.title).toBe('TimeTrack — Einstellung bestätigen')
    expect(o.message).toBe('MCP-Schreibzugriff einschalten?')
  })

  it('names every new webhook address, one per line', () => {
    const o = sensitiveSettingDialog('de', {
      kind: 'webhook',
      urls: ['https://a.example', 'https://b.example']
    })
    expect(o.detail).toContain('\nhttps://a.example/\nhttps://b.example/\n')
    expect(o.buttons[1]).toBe('Speichern')
  })

  it('names the app id, in English too', () => {
    const o = sensitiveSettingDialog('en', { kind: 'graphClientId', id: '1234-abcd' })
    expect(o.message).toBe('Use a different app registration?')
    expect(o.detail).toContain('app ID 1234-abcd')
    expect(o.buttons).toEqual(['Cancel', 'Use'])
  })

  it.each(['mcpWrite', 'controller', 'silent'] as const)(
    '%s has text in both languages',
    (kind) => {
      for (const locale of ['de', 'en'] as const) {
        const o = sensitiveSettingDialog(locale, { kind })
        for (const s of [o.message, o.detail, o.buttons[1]]) {
          expect(s).toBeTruthy()
          expect(s).not.toContain('mainDialog.')
        }
      }
    }
  )
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

  it('no dialog lives in a subfolder of src/main, where the guard does not look', () => {
    const subdirs = readdirSync(__dirname, { withFileTypes: true }).filter((d) => d.isDirectory())
    for (const d of subdirs) {
      for (const f of readdirSync(join(__dirname, d.name), { recursive: true }) as string[]) {
        if (!f.endsWith('.ts')) continue
        const src = readFileSync(join(__dirname, d.name, f), 'utf8')
        expect(/dialog\.show\w+\(/.test(src), `${d.name}/${f}`).toBe(false)
      }
    }
  })

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
      // CAPS constants are included because that is how #288 first passed its
      // restore title. See the header for what this does not see.
      /\b(title|message|detail|checkboxLabel):\s*(['"`]|[A-Z][A-Z0-9_]+\b)|buttons:\s*\[\s*(['"`]|[A-Z][A-Z0-9_]+\b)|showErrorBox\(\s*(['"`]|[A-Z][A-Z0-9_]+\b)/
    for (const [file, src] of sources()) {
      if (!/dialog\.show\w+\(|showSaveDialog/.test(src)) continue
      expect(literal.exec(src)?.[0], file).toBeUndefined()
      for (const m of src.matchAll(/\{\s*name:\s*(['"`])([^'"`]*)\1,\s*extensions:/g)) {
        expect(FORMAT_NAMES.has(m[2]), `${file}: filter name ${m[2]}`).toBe(true)
      }
    }
  })
})

describe('sensitive setting values from the renderer are shown cleaned (#272 A3)', () => {
  it('a webhook URL is shown as the parser reads it, without tabs or hidden marks', () => {
    const o = sensitiveSettingDialog('de', {
      kind: 'webhook',
      urls: ['https://legit.example\t\t\t@evil.example/x']
    })
    expect(o.detail).not.toMatch(/\t/)
    expect(o.detail).toContain('evil.example')
  })

  it('an app id cannot add lines to the dialog', () => {
    const o = sensitiveSettingDialog('de', {
      kind: 'graphClientId',
      id: 'abc\n\nDas ist die Standard-ID, es ändert sich nichts.'
    })
    expect((o.detail ?? '').split('\n')).toHaveLength(1)
    expect(o.detail).toContain('⏎')
  })
})
