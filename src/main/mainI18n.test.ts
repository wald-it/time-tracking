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
import type Database from 'better-sqlite3'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'
import {
  appLocale,
  forgetLastAppLocale,
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
  sensitiveSettingDialog,
  updateDownloadedNotification
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
    db.close()
    // A closed handle throws here; appLocale (below) is the rule that copes.
    expect(() => readLanguage(db)).toThrow()
  })

  it('appLocale never throws: setting, last setting read, system language, German', () => {
    const fail = (): never => {
      throw new Error('unavailable')
    }
    /** appLocale over a fixed database and fixed system languages. */
    const loc = (db: Database.Database, langs: string[]): string =>
      appLocale(
        () => db,
        () => langs
      )
    const broken = new DatabaseImpl(':memory:') // open, but no settings table

    // Nothing read yet in this run: the system language, then German.
    forgetLastAppLocale()
    expect(loc(broken, ['de-DE'])).toBe('de')
    expect(loc(broken, ['en-US'])).toBe('en')
    expect(loc(broken, [])).toBe('en') // none reported: English
    expect(appLocale(fail, fail)).toBe('de')

    // Once the setting was read, a closed handle or a failing read keeps it,
    // whatever the system says: tray and dialogs stay in one language.
    const db = new DatabaseImpl(':memory:')
    applyMigrations(db)
    db.prepare(`UPDATE settings SET value = 'en' WHERE key = 'language'`).run()
    expect(loc(db, ['de-DE'])).toBe('en')
    db.close()
    expect(loc(db, ['de-DE'])).toBe('en')
    expect(loc(broken, ['de-DE'])).toBe('en')
    expect(appLocale(fail, fail)).toBe('en')
    forgetLastAppLocale()
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
    expect(o.detail).toContain('\na.example — https://a.example/\nb.example — https://b.example/\n')
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

describe('#296 — one way to the app language in the main process', () => {
  // Tray, dialogs, file names and the update notification (#309) all go
  // through appLocale, so they answer alike, also with the handle closed.
  // Allowed exceptions:
  // - mainI18n.ts: defines the rule.
  // - graphPresence.ts: only the Teams status text (`🔴 Fokus|Focus …`, seen
  //   by colleagues, not app UI). The module is Electron-free and gets its
  //   settings through the injected PresenceDeps.getSetting, so it has no DB
  //   handle for appLocale. To drop the exception, inject
  //   `getLocale: () => Locale` as updater.ts does (index.ts passes
  //   appLocale) and remove the file from `allowed`.
  // - mcpBridgeCore.ts: Electron-free, reads the open database of the MCP
  //   write request it is handling (the confirmation dialog's language).
  // A text heuristic over the files directly under src/main: it sees these
  // calls by name, not a hand-written `=== 'en'`, a raw SELECT or an alias.
  // That index.ts wires appLocale into the updater is not tested (no harness
  // for index.ts).
  it('no other main-process source reads the language itself', () => {
    const allowed = new Set(['mainI18n.ts', 'graphPresence.ts', 'mcpBridgeCore.ts'])
    const hits = readdirSync(__dirname)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !allowed.has(f))
      .filter((f) =>
        /\b(localeFromSetting|readLanguage)\(|getSetting\(\s*['"`]language/.test(
          readFileSync(join(__dirname, f), 'utf8')
        )
      )
    expect(hits).toEqual([])
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
      // `error` (bare or `.error`) compared with == / === / != / !== either
      // way round, switched on, or text-tested; and any cancel wording.
      const compares =
        /\berror\s*[!=]==?\s*['"`]|['"`]\s*[!=]==?\s*[\w.?]*\berror\b|switch\s*\(\s*[\w.?]*\berror\s*\)|\berror\??\.(includes|startsWith|endsWith|match)\(/
      const cancelWords = /abgebrochen|(export|selection|saving) cancelled/i
      if (compares.test(src) || cancelWords.test(src)) hits.push(f)
    }
    expect(hits).toEqual([])
  })
})

describe('updater.ts — the notification after a download (#309)', () => {
  it('German and English, word for word', () => {
    expect(updateDownloadedNotification('de', '1.23.0')).toEqual({
      title: 'Ein neues Update kann installiert werden',
      body: 'TimeTrack 1.23.0 wurde heruntergeladen. Zum Installieren klicke oben im TimeTrack-Fenster auf "Jetzt neu starten".'
    })
    expect(updateDownloadedNotification('en', '1.23.0')).toEqual({
      title: 'A new update is ready to install',
      body: 'TimeTrack 1.23.0 has been downloaded. To install it, click "Restart now" in the banner at the top of the TimeTrack window.'
    })
  })

  it.each(['de', 'en'] as const)(
    '%s: names exactly the label the update banner renders',
    (locale) => {
      const label = dialogT(locale)('update.ready.install')
      expect(updateDownloadedNotification(locale, '1.23.0').body).toContain(`"${label}"`)
    }
  )
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

  // #309: system notifications are main-process text too. Same heuristic,
  // same limits: it sees a literal title or body, not text from elsewhere.
  it('finds the notification call sites it guards', () => {
    const withNotifications = sources().filter(([, src]) => /new Notification\(/.test(src))
    expect(withNotifications.map(([f]) => f)).toEqual(['updater.ts'])
  })

  it('notification titles and bodies come from the locale files', () => {
    const literal = /\b(title|body):\s*(['"`]|[A-Z][A-Z0-9_]+\b)/
    for (const [file, src] of sources()) {
      if (!/new Notification\(/.test(src)) continue
      expect(literal.exec(src)?.[0], file).toBeUndefined()
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

describe('#301: the "remember" box only where it applies', () => {
  it('can be left out', () => {
    const o = mcpConfirmDialog('de', 'S', false)
    expect(o.checkboxLabel).toBeUndefined()
    expect(o.buttons).toEqual(['Ablehnen', 'Erlauben'])
  })
})

describe('the webhook host is never cut off (review round 2)', () => {
  it('a long address with userinfo still names the real host first', () => {
    const url = 'https://hooks.trusted-company.example.com.' + 'a'.repeat(110) + '@evil.example/'
    const o = sensitiveSettingDialog('de', { kind: 'webhook', urls: [url] })
    const line = (o.detail ?? '').split('\n').find((l) => l.includes('—')) ?? ''
    expect(line.startsWith('evil.example — ')).toBe(true)
  })
})
