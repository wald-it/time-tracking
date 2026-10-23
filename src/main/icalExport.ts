/**
 * iCal-Export IPC-Handler — Stufe 1, statischer .ics-Export (#135).
 *
 * Verdrahtet den reinen Formatter aus shared/ical.ts mit der Main-Process-
 * IPC-Schicht — exakt nach dem Muster von csvExport.ts:
 *  - Client-Lookup
 *  - Entries-Query über den gewählten Zeitraum + Kunde (+ optional Projekt),
 *    laufende Timer und gelöschte Einträge fliegen raus
 *  - Projektnamen für den SUMMARY-Zusatz nachladen
 *  - Save-Dialog mit vorbefülltem Namen
 *  - UTF-8-.ics schreiben (der Formatter erzeugt bereits CRLF, wie RFC 5545
 *    es verlangt — deshalb hier KEIN Umkodieren der Zeilenenden)
 *
 * Bewusst NICHT das Vorbild jsonExport.ts (Voll-Dump ohne Filter). Und
 * bewusst OHNE Honorar/private_note (Privacy, siehe shared/ical.ts).
 *
 * Anders als csvExport: nicht abrechenbare Einträge (billable = 0) bleiben
 * drin. Der Kalender ist eine Ist-Zeit-Ansicht, kein Rechnungsdokument.
 */
import { dialog } from 'electron'
import { writeFileSync } from 'fs'
import type Database from 'better-sqlite3'
import { formatIcal } from '../shared/ical'
import type { Client, IpcResult } from '../shared/types'
import { exportEntries } from './entryRanges'
import { exportDefaultPath, rememberExportFolder } from './exportFolders'

export interface IcalRequest {
  clientId: number
  /** ISO-date strings, inclusive: '2026-04-01' bis '2026-04-30'. */
  fromIso: string
  toIso: string
  /**
   * Optionaler Projektfilter. Wenn gesetzt, nur Einträge mit dieser
   * project_id. undefined / null = alle Projekte.
   */
  projectId?: number | null
  /**
   * true (Default): Kundenname (+ Projekt) im Titel. false: generischer
   * „Fokus"-Titel ohne identifizierende Inhalte. Schalter aus dem Export-Modal.
   */
  showClientName?: boolean
}

function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data }
}
function fail(e: unknown): IpcResult<never> {
  return { ok: false, error: e instanceof Error ? e.message : String(e) }
}

export async function handleIcalExport(
  db: Database.Database,
  req: IcalRequest
): Promise<IpcResult<{ path: string }>> {
  try {
    if (!req || typeof req.clientId !== 'number' || !req.fromIso || !req.toIso) {
      return fail('Ungültige iCal-Anfrage')
    }

    const client = db
      .prepare(`SELECT id, name, color, active, rate_cent, created_at FROM clients WHERE id = ?`)
      .get(req.clientId) as Client | undefined
    if (!client) return fail(`Kunde ${req.clientId} nicht gefunden`)

    const entries = exportEntries(db, req)

    // Projektnamen für den SUMMARY-Zusatz (project_id → name).
    const projectMap = new Map<number, string>()
    for (const row of db
      .prepare(`SELECT id, name FROM projects WHERE client_id = ?`)
      .all(req.clientId) as Array<{ id: number; name: string }>) {
      projectMap.set(row.id, row.name)
    }

    const rangeHint = `${req.fromIso.slice(0, 7)}`
    const safeName = client.name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'Kunde'

    // Bei Projektfilter den Projektnamen an den Dateinamen anhängen.
    let projectSuffix = ''
    if (req.projectId != null) {
      const proj = projectMap.get(req.projectId)
      if (proj) {
        projectSuffix = `-${proj.replace(/[\\/:*?"<>|]/g, '_').trim()}`
      }
    }

    const result = await dialog.showSaveDialog({
      title: 'iCal speichern',
      defaultPath: await exportDefaultPath(
        db,
        'ical',
        `Zeiterfassung-${safeName}${projectSuffix}-${rangeHint}.ics`
      ),
      filters: [{ name: 'iCalendar', extensions: ['ics'] }]
    })
    if (result.canceled || !result.filePath) {
      return fail('Export abgebrochen')
    }

    const clientMap = new Map([[client.id, client]])
    const ics = formatIcal(entries, clientMap, projectMap, {
      showClientName: req.showClientName ?? true
    })

    writeFileSync(result.filePath, ics, 'utf8')
    rememberExportFolder(db, 'ical', result.filePath)
    return ok({ path: result.filePath })
  } catch (e) {
    return fail(e)
  }
}
