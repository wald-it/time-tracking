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
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'
import {
  appLocale,
  cancelledResult,
  dbErrorDialog,
  dialogT,
  exportFileName,
  hotkeyConflictDialog,
  mergedFileName,
  trayLabels,
  trayTooltip,
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
  // The rule itself (localeFromSetting) is tested in shared/i18n.test.ts.
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

  it('appLocale never throws: setting, then system language, then German', () => {
    const db = new DatabaseImpl(':memory:')
    applyMigrations(db)
    db.prepare(`UPDATE settings SET value = 'en' WHERE key = 'language'`).run()
    expect(
      appLocale(
        () => db,
        () => ['de-DE']
      )
    ).toBe('en')
    const broken = new DatabaseImpl(':memory:') // open, but no settings table
    expect(
      appLocale(
        () => broken,
        () => ['de-DE']
      )
    ).toBe('de')
    expect(
      appLocale(
        () => broken,
        () => ['en-US']
      )
    ).toBe('en')
    db.close()
    expect(
      appLocale(
        () => db,
        () => ['en-US']
      )
    ).toBe('en')
    const fail = (): never => {
      throw new Error('unavailable')
    }
    expect(appLocale(fail, fail)).toBe('de')
    broken.close()
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

describe('#296 — default file names follow the app language', () => {
  const month = '2026-04'

  it('German: the names the app always wrote, byte for byte', () => {
    // The old templates, written out: `Stundennachweis-${safe}${suffix}-${month}.pdf`
    expect(exportFileName('de', 'pdf', { client: 'Acme', month })).toBe(
      'Stundennachweis-Acme-2026-04.pdf'
    )
    expect(exportFileName('de', 'pdf', { client: 'Acme', project: 'Rollout', month })).toBe(
      'Stundennachweis-Acme-Rollout-2026-04.pdf'
    )
    expect(exportFileName('de', 'csv', { client: 'Acme', month })).toBe(
      'Zeiterfassung-Acme-2026-04.csv'
    )
    expect(exportFileName('de', 'ical', { client: 'Acme', project: 'Rollout', month })).toBe(
      'Zeiterfassung-Acme-Rollout-2026-04.ics'
    )
    expect(mergedFileName('de', 'Rechnung-17')).toBe('Rechnung-17_inkl_Stundennachweis.pdf')
    expect(mergedFileName('de', 'Rechnung-17', '2026-04-30T10-00-00')).toBe(
      'Rechnung-17_inkl_Stundennachweis_2026-04-30T10-00-00.pdf'
    )
  })

  it('English: Timesheet / Time-entries / _incl_Timesheet', () => {
    expect(exportFileName('en', 'pdf', { client: 'Acme', project: 'Rollout', month })).toBe(
      'Timesheet-Acme-Rollout-2026-04.pdf'
    )
    expect(exportFileName('en', 'csv', { client: 'Acme', month })).toBe(
      'Time-entries-Acme-2026-04.csv'
    )
    expect(exportFileName('en', 'ical', { client: 'Acme', month })).toBe(
      'Time-entries-Acme-2026-04.ics'
    )
    expect(mergedFileName('en', 'Invoice-17')).toBe('Invoice-17_incl_Timesheet.pdf')
    expect(mergedFileName('en', 'Invoice-17', 'x')).toBe('Invoice-17_incl_Timesheet_x.pdf')
  })

  it('cleans the name parts as before; an empty client name falls back', () => {
    expect(exportFileName('de', 'pdf', { client: 'A/B:C*?', project: ' P|Q ', month })).toBe(
      'Stundennachweis-A_B_C__-P_Q-2026-04.pdf'
    )
    expect(exportFileName('de', 'csv', { client: ' <> ', month })).toBe(
      'Zeiterfassung-__-2026-04.csv'
    )
    expect(exportFileName('de', 'csv', { client: '  ', month })).toBe(
      'Zeiterfassung-Kunde-2026-04.csv'
    )
    expect(exportFileName('en', 'csv', { client: '', month })).toBe(
      'Time-entries-Client-2026-04.csv'
    )
  })

  // Kept as the app always did it, and named here so nobody "fixes" one side
  // silently: CSV and PDF add `-` for a project row whose name is empty,
  // iCal (whose caller passes `name || null`) does not.
  it('an empty project name: a given project adds the dash, none adds nothing', () => {
    expect(exportFileName('de', 'csv', { client: 'Acme', project: '', month })).toBe(
      'Zeiterfassung-Acme--2026-04.csv'
    )
    expect(exportFileName('de', 'ical', { client: 'Acme', project: null, month })).toBe(
      'Zeiterfassung-Acme-2026-04.ics'
    )
  })

  it('a client name that looks like a slot stays as written', () => {
    expect(exportFileName('de', 'pdf', { client: '{month}', month })).toBe(
      'Stundennachweis-{month}-2026-04.pdf'
    )
  })
})

describe('#296 — tray', () => {
  it('German labels and tooltip as before', () => {
    expect(trayLabels('de')).toEqual({
      idle: 'Kein Timer aktiv',
      stop: 'Stop',
      quickStart: 'Quick-Start',
      noClients: 'Keine aktiven Kunden',
      showWindow: 'Fenster anzeigen',
      quit: 'Beenden'
    })
    expect(trayTooltip('de', true, 'Acme', '01:30')).toBe('● Acme · Heute 01:30')
    expect(trayTooltip('de', false, '', '00:00')).toBe('TimeTrack — Heute 00:00')
  })

  it('English labels and tooltip', () => {
    expect(trayLabels('en')).toEqual({
      idle: 'No timer running',
      stop: 'Stop',
      quickStart: 'Quick start',
      noClients: 'No active clients',
      showWindow: 'Show window',
      quit: 'Quit'
    })
    expect(trayTooltip('en', true, 'Acme', '01:30')).toBe('● Acme · Today 01:30')
    expect(trayTooltip('en', false, '', '00:00')).toBe('TimeTrack — Today 00:00')
  })
})

describe('#296 — a closed dialog is a code, not a text', () => {
  it('carries code cancelled and a text in the app language', () => {
    expect(cancelledResult('de', 'mainError.exportCancelled')).toEqual({
      ok: false,
      error: 'Export abgebrochen',
      code: 'cancelled'
    })
    expect(cancelledResult('en', 'mainError.saveCancelled')).toEqual({
      ok: false,
      error: 'Saving cancelled',
      code: 'cancelled'
    })
  })

  // The renderer used to compare these texts; none may come back.
  it('no renderer source compares an error text with a cancel wording', () => {
    const root = join(__dirname, '..', 'renderer', 'src')
    const hits: string[] = []
    for (const f of readdirSync(root, { recursive: true }) as string[]) {
      if (!/\.tsx?$/.test(f) || /\.test\.tsx?$/.test(f)) continue
      const src = readFileSync(join(root, f), 'utf8')
      if (/error\s*===\s*['"`]/.test(src)) hits.push(f)
    }
    expect(hits).toEqual([])
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
