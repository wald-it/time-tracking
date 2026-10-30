// v1.13 #118: per-modal export preferences are remembered across sessions so
// users don't have to re-tick the same toggles every export.
//
// v1.13.2: persisted in the DB `settings` table (key `export_prefs`) instead
// of localStorage. Chromium batches localStorage writes and skips the flush
// on hard exits (app.exit on relaunch, OS shutdown from tray) and falls back
// to in-memory storage entirely when a second app instance can't acquire the
// LevelDB lock — prefs were lost intermittently. The write travels over async
// IPC but lands synchronously in SQLite on the main process, so the loss
// window shrinks from Chromium's batched flush to a single in-flight IPC
// call; the value is also included in backups. The old localStorage key is
// migrated once in ExportModal.

export type ExportTab = 'pdf' | 'csv' | 'ical'
export type CsvFormat = 'de' | 'us'
export type GroupBy = 'none' | 'tag' | 'project' | 'reference'

export interface ExportPrefs {
  tab: ExportTab
  includeSignatures: boolean
  hideFeeColumn: boolean
  csvFormat: CsvFormat
  csvGroupByTag: boolean
  /**
   * #135: iCal-Export — Kundenname im Titel sichtbar (true, Default) oder
   * generischer „Fokus"-Titel (false). Der Schalter gehört ins Export-Modal,
   * nicht in die Einstellungen.
   */
  icalShowClientName: boolean
}

export const DEFAULT_PREFS: ExportPrefs = {
  tab: 'pdf',
  includeSignatures: false,
  hideFeeColumn: false,
  csvFormat: 'de',
  csvGroupByTag: false,
  icalShowClientName: true
}

/** Legacy localStorage key (pre-v1.13.2); read once for migration, then removed. */
export const LS_PREFS_KEY = 'export.modal.prefs.v1'

export function parsePrefs(raw: string | null | undefined): ExportPrefs {
  try {
    if (!raw) return DEFAULT_PREFS
    const parsed = JSON.parse(raw) as Partial<ExportPrefs>
    // Validate each field against its allowed set so corrupted/legacy data
    // can't crash the render.
    return {
      tab: parsed.tab === 'csv' || parsed.tab === 'ical' ? parsed.tab : 'pdf',
      includeSignatures: parsed.includeSignatures === true,
      hideFeeColumn: parsed.hideFeeColumn === true,
      csvFormat: parsed.csvFormat === 'us' ? 'us' : 'de',
      csvGroupByTag: parsed.csvGroupByTag === true,
      // Default true: Kundenname sichtbar (Issue-Vorgabe). Nur explizit false
      // schaltet auf den generischen Titel.
      icalShowClientName: parsed.icalShowClientName !== false
    }
  } catch {
    return DEFAULT_PREFS
  }
}

/** Legacy read for the one-time localStorage → DB migration. */
export function readLegacyPrefs(): string | null {
  try {
    return localStorage.getItem(LS_PREFS_KEY)
  } catch {
    return null
  }
}
