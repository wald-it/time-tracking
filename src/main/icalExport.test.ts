/**
 * Integrationstest für handleIcalExport (#135, Stufe 1).
 *
 * Geht — anders als ical.test.ts (reiner Formatter) — durch den echten
 * DB-Query-Pfad: In-Memory-SQLite + Migrations-Loop wie in entryMutations.test.ts.
 * Der Electron-Save-Dialog wird gemockt und in eine echte Temp-Datei
 * geschrieben, die danach zurückgelesen und geprüft wird.
 *
 * Beweist:
 *  - laufende (stopped_at NULL) und gelöschte (deleted_at) Einträge fliegen raus
 *  - Datums-/Kunden-/Projektfilter greifen
 *  - Cross-Midnight-Zeilen ergeben zwei VEVENTs
 *  - weder private_note noch Honorar landen in der Datei — auch wenn in der DB gesetzt
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'
import type Database from 'better-sqlite3'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'
import { seedEntry } from '../test/entryFixtures'

// Save-Dialog mocken: liefert einen Pfad in einem Temp-Verzeichnis.
let saveTargetPath: string
vi.mock('electron', () => ({
  dialog: {
    showSaveDialog: vi.fn(async () => ({ canceled: false, filePath: saveTargetPath }))
  }
}))

let DatabaseImpl: DatabaseCtor

beforeAll(async () => {
  DatabaseImpl = await loadSqlite()
})

let tmpDir: string
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'tt-ical-'))
  saveTargetPath = join(tmpDir, 'out.ics')
})
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function seed(db: Database.Database): void {
  db.pragma('foreign_keys = ON')
  applyMigrations(db)
  // Kunde mit Honorar (darf NIE in den Feed) + zweiter Kunde für den Filtertest.
  db.prepare(
    `INSERT INTO clients (id, name, color, active, rate_cent) VALUES (1,'Acme','#111',1,7500)`
  ).run()
  db.prepare(
    `INSERT INTO clients (id, name, color, active, rate_cent) VALUES (2,'Bosch','#222',1,0)`
  ).run()
  db.prepare(`INSERT INTO projects (id, client_id, name, color) VALUES (5,1,'Portal','')`).run()

  // 1: normaler Eintrag, im Zeitraum, mit private_note + Projekt + Tags
  seedEntry(db, {
    id: 1,
    client_id: 1,
    description: 'Arbeit',
    started_at: '2026-04-10T09:00:00.000Z',
    stopped_at: '2026-04-10T10:00:00.000Z',
    tags: ',dev,',
    private_note: 'GEHEIM-NOTIZ',
    project_id: 5
  })
  // 2: laufender Timer → raus
  seedEntry(db, {
    id: 2,
    client_id: 1,
    description: 'Läuft',
    started_at: '2026-04-11T09:00:00.000Z',
    stopped_at: null
  })
  // 3: gelöscht → raus
  seedEntry(db, {
    id: 3,
    client_id: 1,
    description: 'Gelöscht',
    started_at: '2026-04-12T09:00:00.000Z',
    stopped_at: '2026-04-12T10:00:00.000Z',
    deleted_at: '2026-04-13T00:00:00.000Z'
  })
  // 4: Cross-Midnight-Eintrag, zwei Segmente (2.0 P2: ersetzt das 1.x-Paar 4/5 mit link_id)
  seedEntry(db, {
    id: 4,
    client_id: 1,
    description: 'Nacht',
    // Lokale Zeiten, damit der Schnitt in jeder Zeitzone auf einem lokalen Mitternacht liegt
    segments: [
      {
        started_at: new Date(2026, 3, 14, 22, 0).toISOString(),
        stopped_at: new Date(2026, 3, 14, 23, 59, 59).toISOString()
      },
      {
        started_at: new Date(2026, 3, 15, 0, 0).toISOString(),
        stopped_at: new Date(2026, 3, 15, 1, 0).toISOString()
      }
    ]
  })
  // 6: außerhalb des Zeitraums → raus
  seedEntry(db, {
    id: 6,
    client_id: 1,
    description: 'Alt',
    started_at: '2026-03-01T09:00:00.000Z',
    stopped_at: '2026-03-01T10:00:00.000Z'
  })
  // 7: anderer Kunde → raus
  seedEntry(db, {
    id: 7,
    client_id: 2,
    description: 'Fremdkunde',
    started_at: '2026-04-10T09:00:00.000Z',
    stopped_at: '2026-04-10T10:00:00.000Z'
  })
}

async function run(db: Database.Database, showClientName = true): Promise<string> {
  const { handleIcalExport } = await import('./icalExport')
  const res = await handleIcalExport(db, {
    clientId: 1,
    fromIso: '2026-04-01',
    toIso: '2026-04-30',
    showClientName
  })
  expect(res.ok).toBe(true)
  return readFileSync(saveTargetPath, 'utf8')
}

describe('handleIcalExport', () => {
  let db: Database.Database
  beforeEach(() => {
    db = new DatabaseImpl(':memory:')
    seed(db)
  })

  // #270: the save dialog follows the app language.
  it('titles the save dialog in the app language', async () => {
    const { dialog } = await import('electron')
    const save = vi.mocked(dialog.showSaveDialog)
    save.mockClear()
    await run(db)
    db.prepare(`UPDATE settings SET value = 'en' WHERE key = 'language'`).run()
    await run(db)
    expect(save.mock.calls.map((c) => (c[0] as Electron.SaveDialogOptions).title)).toEqual([
      'iCal speichern',
      'Save iCal'
    ])
    // #296: the suggested name too; German as the app always wrote it.
    const paths = save.mock.calls.map((c) => (c[0] as Electron.SaveDialogOptions).defaultPath ?? '')
    expect(paths.map((p) => basename(p))).toEqual([
      'Zeiterfassung-Acme-2026-04.ics',
      'Time-entries-Acme-2026-04.ics'
    ])
    // #269: the second dialog starts in the folder the first export went to.
    expect(paths[0]).toBe('Zeiterfassung-Acme-2026-04.ics')
    expect(paths[1]).toBe(join(dirname(saveTargetPath), 'Time-entries-Acme-2026-04.ics'))
  })

  it('exportiert nur abgeschlossene, nicht gelöschte Einträge im Zeitraum + Kunde', async () => {
    const ics = await run(db)
    const events = ics.match(/BEGIN:VEVENT/g) ?? []
    // id 1 + Cross-Midnight-Eintrag (4, zwei Segmente) = 3; laufend/gelöscht/außerhalb/fremd raus.
    expect(events).toHaveLength(3)
    expect(ics).toMatch(/UID:timetrack-entry-1-\d{4}-\d{2}-\d{2}@wald-it\.com/)
    // 2.0 P3: the two segments of entry 4 share the id and differ in the segment date (it was 4 and 5 for the 1.x pair)
    expect(ics).toContain('UID:timetrack-entry-4-2026-04-14@wald-it.com')
    expect(ics).toContain('UID:timetrack-entry-4-2026-04-15@wald-it.com')
    expect(ics).not.toContain('Läuft')
    expect(ics).not.toContain('Gelöscht')
    expect(ics).not.toContain('Fremdkunde')
    expect(ics).not.toContain('Alt')
  })

  it('zieht den Projektnamen aus der DB in den Titel', async () => {
    const ics = await run(db)
    expect(ics.replace(/\r\n /g, '')).toContain('Acme / Portal — Arbeit')
  })

  it('lässt private_note und Honorar niemals in die Datei — auch bei DB-Werten', async () => {
    const ics = await run(db)
    expect(ics).not.toContain('GEHEIM-NOTIZ')
    expect(ics).not.toContain('7500')
    expect(ics).not.toContain('75,00')
  })

  it('schreibt DTSTART/DTEND als UTC', async () => {
    const ics = await run(db)
    expect(ics).toContain('DTSTART:20260410T090000Z')
    expect(ics).toContain('DTEND:20260410T100000Z')
  })

  it('Privacy-Modus versteckt Kunde, Beschreibung und Tags', async () => {
    const ics = await run(db, false)
    expect(ics).toContain('SUMMARY:Fokus')
    expect(ics).not.toContain('Acme')
    expect(ics).not.toContain('Arbeit')
    expect(ics).not.toContain('CATEGORIES')
  })
})
