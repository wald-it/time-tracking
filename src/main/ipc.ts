import { isExternalUrlAllowed } from './externalLinks'
import { ipcMain, shell } from 'electron'
import { app } from 'electron'
import { dialog } from 'electron'
import { writeFileSync, readFileSync, mkdirSync, readdirSync } from 'fs'
import { dirname, join, normalize } from 'path'
import log from 'electron-log/main'
import { getDb, getDbPath } from './db'
import { getBackupsDir, getDefaultBackupsDir, readBackupPathSetting } from './backup'
import { createBackup, listBackups, restoreListedBackupOrReport } from './backup'
import { readSettingSync, writeSettingFromRenderer } from './settingsWrite'
import {
  createManualEntry,
  updateManualEntry,
  switchTimerAndNotify,
  stopEntry
} from './entryMutations'
import { emitWebhooks } from './webhooks'
import { logWebhookDelivery } from './webhookLog'
import { buildJsonExportPayload } from './jsonExport'
import { buildPdfHtml, buildPdfPayload, type PdfRequest } from './pdf'
import { renderPdfBuffer } from './pdfWindow'
import { readLogoAsDataUrl, removeLogo, saveLogo } from './logo'
import { handleCsvExport, type CsvRequest } from './csvExport'
import { handleIcalExport, type IcalRequest } from './icalExport'
import { mergeExportHandler, mergeOnlyHandler, pdfInfoHandler } from './pdfMergeHandlers'
import { registerAnalyticsHandlers } from './analyticsHandlers'
import { registerBudgetHandlers } from './budgetHandlers'
import { registerTagHandlers } from './tagHandlers'
import { registerGraphHandlers } from './graphHandlers'
import { feedUrl, generateFeedToken } from './icalFeed'
import { buildMcpRegistration, type McpRegistration } from './mcpLaunch'
import {
  readTodayEntries,
  readTopClients30d,
  readTotals,
  readWeekDaySeconds
} from './dashboardTotals'
import type {
  Client,
  Entry,
  Project,
  CreateClientInput,
  UpdateClientInput,
  CreateEntryInput,
  SwitchTimerResult,
  CreateManualEntryInput,
  UpdateEntryInput,
  CreateProjectInput,
  UpdateProjectInput,
  MonthQuery,
  Settings,
  IpcResult,
  BackupInfo,
  DashboardSummary,
  LicenseEntry
} from '../shared/types'
import { monthEntries } from './entryRanges'

export interface IpcHooks {
  refreshTrayClients(): void
  setHotkey(accelerator: string): boolean
  setAutoStart(enabled: boolean): void
  setIdleThreshold(minutes: number): void
  setMiniEnabled(enabled: boolean): void
  setMiniHotkey(accelerator: string): boolean
  setMcpWriteEnabled(enabled: boolean): void
  setControllerEnabled(enabled: boolean): void
  /** Re-run the presence reconciler (#132) after a relevant settings change. */
  pokePresence(): void
  /** Start/stop the local iCal feed server (#169). */
  setIcalFeedEnabled(enabled: boolean): void
  /** Restart the feed server after a port/token change (no-op when disabled). */
  restartIcalFeed(): void
}

function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data }
}
function fail(error: unknown): IpcResult<never> {
  return { ok: false, error: String(error) }
}

/**
 * Coerce optional `rate_cent` from the renderer into a non-negative integer.
 * `undefined` (legacy callers) → 0; negative or NaN → throws so the IPC
 * surfaces the error instead of silently saving garbage.
 */
function normaliseRateCent(value: unknown): number {
  if (value === undefined || value === null) return 0
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) {
    throw new Error('Stundensatz darf nicht negativ sein')
  }
  return Math.round(n)
}

/**
 * Coerce optional `budget_minutes` from the renderer into a positive integer
 * or null. `undefined`, `null`, `0`, or negative values all become null
 * ("no budget set"). Non-integer values are rounded.
 *
 * Exported for unit testing.
 */
export function normaliseBudgetMinutes(value: unknown): number | null {
  if (value === undefined || value === null) return null
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.round(n)
}

export function registerIpcHandlers(hooks: IpcHooks): void {
  const db = getDb()

  // ── Clients ──────────────────────────────────────────────────
  ipcMain.handle('clients:getAll', (): IpcResult<Client[]> => {
    try {
      const rows = db.prepare(`SELECT * FROM clients ORDER BY name ASC`).all() as Client[]
      return ok(rows)
    } catch (e) {
      return fail(e)
    }
  })

  ipcMain.handle('clients:create', (_e, input: CreateClientInput): IpcResult<Client> => {
    try {
      const rate = normaliseRateCent(input.rate_cent)
      const info = db
        .prepare(
          `INSERT INTO clients (name, color, rate_cent,
             billing_address_line1, billing_address_line2,
             billing_address_line3, billing_address_line4,
             vat_id, contact_person, contact_email)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.name.trim(),
          input.color,
          rate,
          input.billing_address_line1?.trim() ?? null,
          input.billing_address_line2?.trim() ?? null,
          input.billing_address_line3?.trim() ?? null,
          input.billing_address_line4?.trim() ?? null,
          input.vat_id?.trim() ?? null,
          input.contact_person?.trim() ?? null,
          input.contact_email?.trim() ?? null
        )
      const row = db
        .prepare(`SELECT * FROM clients WHERE id = ?`)
        .get(info.lastInsertRowid) as Client
      hooks.refreshTrayClients()
      return ok(row)
    } catch (e) {
      return fail(e)
    }
  })

  ipcMain.handle('clients:update', (_e, input: UpdateClientInput): IpcResult<Client> => {
    try {
      const rate = normaliseRateCent(input.rate_cent)
      db.prepare(
        `UPDATE clients SET
           name = ?, color = ?, active = ?, rate_cent = ?,
           billing_address_line1 = ?, billing_address_line2 = ?,
           billing_address_line3 = ?, billing_address_line4 = ?,
           vat_id = ?, contact_person = ?, contact_email = ?
         WHERE id = ?`
      ).run(
        input.name.trim(),
        input.color,
        input.active,
        rate,
        input.billing_address_line1?.trim() ?? null,
        input.billing_address_line2?.trim() ?? null,
        input.billing_address_line3?.trim() ?? null,
        input.billing_address_line4?.trim() ?? null,
        input.vat_id?.trim() ?? null,
        input.contact_person?.trim() ?? null,
        input.contact_email?.trim() ?? null,
        input.id
      )
      const row = db.prepare(`SELECT * FROM clients WHERE id = ?`).get(input.id) as Client
      hooks.refreshTrayClients()
      return ok(row)
    } catch (e) {
      return fail(e)
    }
  })

  ipcMain.handle('clients:delete', (_e, id: number): IpcResult<void> => {
    try {
      db.prepare(`DELETE FROM clients WHERE id = ?`).run(id)
      hooks.refreshTrayClients()
      return ok(undefined)
    } catch (e) {
      return fail(e)
    }
  })

  // ── Entries ───────────────────────────────────────────────────
  ipcMain.handle('entries:start', (_e, input: CreateEntryInput): IpcResult<Entry> => {
    try {
      const res = startOrSwitch(input)
      return res.ok ? ok(res.data.entry) : res
    } catch (e) {
      return fail(e)
    }
  })

  // B1 — the quick-start switch: same mutation as entries:start, but the
  // renderer also gets the stopped entry (quick-note prompt for it).
  ipcMain.handle('entries:switch', (_e, input: CreateEntryInput): IpcResult<SwitchTimerResult> => {
    try {
      return startOrSwitch(input)
    } catch (e) {
      return fail(e)
    }
  })

  /**
   * One start path for entries:start and entries:switch: stop + start at one
   * instant (switchTimer), then fire-and-forget outbound webhooks (#134) —
   * `timer.stopped` for the ended entry BEFORE `timer.started`. Never awaited,
   * never throws: a broken webhook must not affect the timer. Covers
   * tray/mini/hotkey too, since they all funnel through here.
   */
  function startOrSwitch(input: CreateEntryInput): IpcResult<SwitchTimerResult> {
    return switchTimerAndNotify(db, input, (event, entry) =>
      emitWebhooks(db, event, entry, { log: logWebhookDelivery })
    )
  }

  ipcMain.handle('entries:stop', (_e, id: number): IpcResult<Entry> => {
    try {
      const res = stopEntry(db, id)
      if (res.ok) emitWebhooks(db, 'timer.stopped', res.data, { log: logWebhookDelivery })
      return res
    } catch (e) {
      return fail(e)
    }
  })

  ipcMain.handle('entries:heartbeat', (_e, id: number): IpcResult<void> => {
    try {
      db.prepare(`UPDATE entries SET heartbeat_at = ? WHERE id = ?`).run(
        new Date().toISOString(),
        id
      )
      return ok(undefined)
    } catch (e) {
      return fail(e)
    }
  })

  ipcMain.handle('entries:getRunning', (): IpcResult<Entry | null> => {
    try {
      const row =
        (db
          .prepare(
            `SELECT * FROM entries
             WHERE stopped_at IS NULL AND deleted_at IS NULL
             ORDER BY started_at DESC LIMIT 1`
          )
          .get() as Entry) ?? null
      return ok(row)
    } catch (e) {
      return fail(e)
    }
  })

  ipcMain.handle('entries:getByMonth', (_e, query: MonthQuery): IpcResult<Entry[]> => {
    try {
      // The local calendar month: 00:30 on the 1st and 23:30 on the last day
      // belong to it, wherever the user lives.
      return ok(monthEntries(db, query.year, query.month))
    } catch (e) {
      return fail(e)
    }
  })

  /**
   * Manual-entry creation (Today "+ Eintrag nachtragen", Calendar Drawer
   * "+ Eintrag hinzufügen"). Server-side validation per v1.2 plan E3 — UI
   * may also pre-validate but must not be the only line of defence.
   *
   * v1.3 PR B: Cross-midnight entries are auto-split at local midnight
   * into linked halves sharing a `link_id` (UUID). The first half's row
   * is returned for UI selection; the renderer's `getByMonth` query will
   * surface the second half on its own day.
   */
  ipcMain.handle('entries:create', (_e, input: CreateManualEntryInput): IpcResult<Entry> => {
    try {
      const res = createManualEntry(db, input)
      if (res.ok) emitWebhooks(db, 'entry.created', res.data, { log: logWebhookDelivery })
      return res
    } catch (e) {
      return fail(e)
    }
  })

  ipcMain.handle('entries:update', (_e, input: UpdateEntryInput): IpcResult<Entry> => {
    try {
      const res = updateManualEntry(db, input)
      if (res.ok) emitWebhooks(db, 'entry.updated', res.data, { log: logWebhookDelivery })
      return res
    } catch (e) {
      return fail(e)
    }
  })

  /**
   * Soft-delete: flip deleted_at instead of removing the row, so the Toast
   * "Rückgängig" path can restore the SAME id (preserves future PDF FKs — E10).
   *
   * v1.3 PR B: when `cascadeLinked` is true and the row has a `link_id`,
   * all rows sharing that id are soft-deleted in one transaction (used by
   * the Drawer's "auch zweite Hälfte löschen" confirm).
   */
  ipcMain.handle('entries:delete', (_e, id: number, cascadeLinked = false): IpcResult<void> => {
    try {
      const now = new Date().toISOString()
      if (cascadeLinked) {
        const row = db.prepare(`SELECT link_id FROM entries WHERE id = ?`).get(id) as
          | { link_id: string | null }
          | undefined
        if (row?.link_id) {
          db.prepare(`UPDATE entries SET deleted_at = ? WHERE link_id = ?`).run(now, row.link_id)
          return ok(undefined)
        }
      }
      db.prepare(`UPDATE entries SET deleted_at = ? WHERE id = ?`).run(now, id)
      return ok(undefined)
    } catch (e) {
      return fail(e)
    }
  })

  ipcMain.handle('entries:undelete', (_e, id: number): IpcResult<Entry> => {
    try {
      db.prepare(`UPDATE entries SET deleted_at = NULL WHERE id = ?`).run(id)
      const row = db.prepare(`SELECT * FROM entries WHERE id = ?`).get(id) as Entry
      return ok(row)
    } catch (e) {
      return fail(e)
    }
  })

  /**
   * Return distinct tag names used in entries from the last 90 days,
   * sorted by frequency descending. Used for TagInput autocomplete.
   * Only non-empty tags columns are considered.
   */
  ipcMain.handle('tags:recent', (): IpcResult<string[]> => {
    try {
      const cutoff = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString()
      const rows = db
        .prepare(
          `SELECT tags FROM entries
           WHERE deleted_at IS NULL
             AND tags != ''
             AND started_at >= ?`
        )
        .all(cutoff) as Array<{ tags: string }>

      const freq = new Map<string, number>()
      for (const { tags } of rows) {
        for (const tag of tags.split(',').filter((t: string) => t.length > 0)) {
          freq.set(tag, (freq.get(tag) ?? 0) + 1)
        }
      }
      const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([tag]) => tag)
      return ok(sorted)
    } catch (e) {
      return fail(e)
    }
  })

  // ── Projects (v1.9 #75 / v1.11 #94) ─────────────────────────
  ipcMain.handle(
    'projects:getAll',
    (_e, req?: { clientId?: number | null }): IpcResult<Project[]> => {
      try {
        const base = `SELECT p.*,
            COALESCE(ec.cnt, 0) AS entry_count,
            ec.last_used_at,
            COALESCE(bud.used_minutes, 0) AS used_minutes
          FROM projects p
          LEFT JOIN (
            SELECT project_id, COUNT(*) AS cnt, MAX(started_at) AS last_used_at
            FROM entries WHERE deleted_at IS NULL GROUP BY project_id
          ) ec ON ec.project_id = p.id
          LEFT JOIN (
            SELECT project_id, COALESCE(SUM(rounded_min), 0) AS used_minutes
            FROM entries
            WHERE deleted_at IS NULL AND stopped_at IS NOT NULL
            GROUP BY project_id
          ) bud ON bud.project_id = p.id`
        const order = `ORDER BY CASE WHEN p.status = 'active' THEN 0 WHEN p.status = 'paused' THEN 1 ELSE 2 END, p.name`
        let query: string
        let params: unknown[]
        if (req !== undefined && req !== null && 'clientId' in req) {
          if (req.clientId === null) {
            query = `${base} WHERE p.client_id IS NULL ${order}`
            params = []
          } else {
            query = `${base} WHERE p.client_id = ? ${order}`
            params = [req.clientId]
          }
        } else {
          query = `${base} ${order}`
          params = []
        }
        const rows = db.prepare(query).all(...params) as Project[]
        return ok(rows)
      } catch (e) {
        return fail(e)
      }
    }
  )

  ipcMain.handle('projects:create', (_e, input: CreateProjectInput): IpcResult<Project> => {
    try {
      const err = validateProject(input, db)
      if (err) return fail(err)
      const budget = normaliseBudgetMinutes(input.budget_minutes)
      const result = db
        .prepare(
          `INSERT INTO projects
             (client_id, name, color, rate_cent,
              external_project_number, start_date, end_date, budget_minutes, status,
              contact_person)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
        )
        .get(
          input.client_id ?? null,
          input.name.trim(),
          input.color ?? '',
          input.rate_cent ?? null,
          input.external_project_number?.trim() ?? null,
          input.start_date ?? null,
          input.end_date ?? null,
          budget,
          input.status ?? 'active',
          input.contact_person?.trim() || null
        ) as Project
      return ok(result)
    } catch (e) {
      return fail(e)
    }
  })

  ipcMain.handle('projects:update', (_e, input: UpdateProjectInput): IpcResult<Project> => {
    try {
      const err = validateProject(input, db)
      if (err) return fail(err)
      const current = db.prepare('SELECT client_id FROM projects WHERE id = ?').get(input.id) as
        | { client_id: number | null }
        | undefined
      if (!current) return fail('Projekt nicht gefunden')
      if (current.client_id !== input.client_id) {
        const countRow = db
          .prepare(`SELECT COUNT(*) AS n FROM entries WHERE project_id = ? AND deleted_at IS NULL`)
          .get(input.id) as { n: number }
        if (countRow.n > 0) {
          return fail(
            'Projekt hat Einträge und kann nicht zu einem anderen Kunden verschoben werden'
          )
        }
      }
      const budget = normaliseBudgetMinutes(input.budget_minutes)
      const status = input.status ?? 'active'
      // Keep `active` in sync with `status` for backward compatibility.
      const activeFlag = status === 'active' ? 1 : 0
      const result = db
        .prepare(
          `UPDATE projects SET
             client_id=?, name=?, color=?, rate_cent=?, active=?,
             external_project_number=?, start_date=?, end_date=?,
             budget_minutes=?, status=?, contact_person=?
           WHERE id=? RETURNING *`
        )
        .get(
          input.client_id ?? null,
          input.name.trim(),
          input.color ?? '',
          input.rate_cent ?? null,
          activeFlag,
          input.external_project_number?.trim() ?? null,
          input.start_date ?? null,
          input.end_date ?? null,
          budget,
          status,
          input.contact_person?.trim() || null,
          input.id
        ) as Project
      return ok(result)
    } catch (e) {
      return fail(e)
    }
  })

  ipcMain.handle('projects:archive', (_e, id: number): IpcResult<void> => {
    try {
      // Keep `active` in sync with `status` for backward compatibility.
      db.prepare('UPDATE projects SET active = 0, status = ? WHERE id = ?').run('archived', id)
      return ok(undefined)
    } catch (e) {
      return fail(e)
    }
  })

  ipcMain.handle('projects:delete', (_e, id: number): IpcResult<void> => {
    try {
      const tx = db.transaction(() => {
        const countRow = db
          .prepare(`SELECT COUNT(*) AS n FROM entries WHERE project_id = ? AND deleted_at IS NULL`)
          .get(id) as { n: number }
        if (countRow.n > 0) throw new Error('Projekt hat noch aktive Einträge')
        db.prepare('DELETE FROM projects WHERE id = ?').run(id)
      })
      tx()
      return ok(undefined)
    } catch (e) {
      return fail(e)
    }
  })

  // ── Dashboard ─────────────────────────────────────────────────
  // Sum of today's tracked seconds, including the running entry up to now.
  // Cross-midnight: a running entry started yesterday is counted via the
  // `stopped_at IS NULL` branch (E7 in v1.2 plan) so the tray total never
  // shows 0h while a 6h timer is visibly running.
  ipcMain.handle('dashboard:todayTotal', (): IpcResult<number> => {
    try {
      const row = db
        .prepare(
          `SELECT COALESCE(SUM(
             CASE
               WHEN stopped_at IS NULL
                 THEN CAST(strftime('%s', 'now') AS INTEGER) - CAST(strftime('%s', started_at) AS INTEGER)
               ELSE CAST(strftime('%s', stopped_at) AS INTEGER) - CAST(strftime('%s', started_at) AS INTEGER)
             END
           ), 0) AS seconds
           FROM entries
           WHERE deleted_at IS NULL
             AND (DATE(started_at, 'localtime') = DATE('now', 'localtime')
                  OR stopped_at IS NULL)`
        )
        .get() as { seconds: number }
      const seconds = Math.max(0, Math.floor(row.seconds ?? 0))
      return ok(seconds)
    } catch (e) {
      return fail(e)
    }
  })

  /**
   * One-shot dashboard payload for the Today view. All four queries run in
   * a single read transaction so the snapshot is consistent. Cross-midnight
   * running entry counted via `stopped_at IS NULL` (matches todayTotal).
   */
  ipcMain.handle('dashboard:summary', (): IpcResult<DashboardSummary> => {
    try {
      const tx = db.transaction((): DashboardSummary => {
        // Today/week come from readTotals() so the stat cards, the tray and
        // the Stream Deck dial can never drift apart (#186).
        const totals = readTotals(db)

        const recentEntries = db
          .prepare(
            `SELECT * FROM entries
               WHERE deleted_at IS NULL
               ORDER BY started_at DESC LIMIT 5`
          )
          .all() as Entry[]

        return {
          todaySeconds: totals.today_seconds,
          weekSeconds: totals.week_seconds,
          weekDaySeconds: readWeekDaySeconds(db),
          recentEntries,
          todayEntries: readTodayEntries(db),
          topClients30d: readTopClients30d(db)
        }
      })
      return ok(tx())
    } catch (e) {
      return fail(e)
    }
  })

  // ── Settings ──────────────────────────────────────────────────
  ipcMain.handle('settings:getAll', (): IpcResult<Settings> => {
    try {
      const rows = db.prepare(`SELECT key, value FROM settings`).all() as {
        key: string
        value: string
      }[]
      const settings = Object.fromEntries(rows.map((r) => [r.key, r.value])) as unknown as Settings
      return ok(settings)
    } catch (e) {
      return fail(e)
    }
  })

  // #272: only keys on the renderer allow-list (see settingsWrite.ts).
  ipcMain.handle(
    'settings:set',
    (_e, key: unknown, value: unknown): IpcResult<void> =>
      writeSettingFromRenderer(db, hooks, key, value)
  )

  // ── iCal feed (#169) ───────────────────────────────────────────
  const readSetting = (key: string): string | undefined =>
    (
      db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
        | { value: string }
        | undefined
    )?.value

  ipcMain.handle('icalFeed:url', (): IpcResult<string> => {
    try {
      return ok(feedUrl(readSetting))
    } catch (e) {
      return fail(e)
    }
  })

  // Regenerating invalidates every stored subscription URL — the UI says so.
  ipcMain.handle('icalFeed:regenerate', (): IpcResult<string> => {
    try {
      db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('ical_feed_token', ?)`).run(
        generateFeedToken()
      )
      hooks.restartIcalFeed()
      return ok(feedUrl(readSetting))
    } catch (e) {
      return fail(e)
    }
  })

  // ── Synchronous settings read (preload FOUC fix only) ──────────
  // ipcMain.on + event.returnValue is the only synchronous IPC pattern.
  // Used exclusively by preload to read theme_mode before first paint, and
  // answers nothing else (#272).
  ipcMain.on('settings:getSync', (event, key: unknown) => {
    event.returnValue = readSettingSync(db, key)
  })

  // ── Backups ───────────────────────────────────
  /** Reads backup_path setting from DB (empty string = use default dir). */
  function getBackupPathSetting(): string {
    return readBackupPathSetting(db) ?? ''
  }

  ipcMain.handle('backup:list', (): IpcResult<BackupInfo[]> => {
    try {
      return ok(listBackups(getBackupPathSetting() || undefined))
    } catch (e) {
      return fail(e)
    }
  })

  ipcMain.handle('backup:create', async (): Promise<IpcResult<string>> => {
    try {
      const path = await createBackup(db, 'manual', undefined, getBackupPathSetting() || undefined)
      return ok(path)
    } catch (e) {
      return fail(e)
    }
  })

  // #272: the renderer names a backup from `backup:list` by its file name; a
  // path is never accepted. Snapshots the current DB, closes it, then replaces
  // the file. A failure is shown as a native dialog here: the renderer
  // relaunches right after, and its own message would vanish with the window.
  ipcMain.handle(
    'backup:restore',
    (_e, filename: unknown): IpcResult<{ safetyBackupPath: string }> => {
      try {
        return restoreListedBackupOrReport(
          db,
          filename,
          getBackupPathSetting() || undefined,
          getDbPath(),
          (title, message) => dialog.showErrorBox(title, message)
        )
      } catch (e) {
        return fail(e)
      }
    }
  )

  ipcMain.handle('backup:set-path', async (): Promise<IpcResult<string>> => {
    try {
      const { canceled, filePaths } = await dialog.showOpenDialog({
        properties: ['openDirectory', 'createDirectory'],
        title: 'Backup-Pfad wählen'
      })
      if (canceled || filePaths.length === 0) return ok('')
      const dir = filePaths[0]
      db.prepare("UPDATE settings SET value = ? WHERE key = 'backup_path'").run(dir)
      return ok(dir)
    } catch (e) {
      return fail(e)
    }
  })

  ipcMain.handle('backup:reset-path', (): IpcResult<void> => {
    try {
      db.prepare("UPDATE settings SET value = '' WHERE key = 'backup_path'").run()
      return ok(undefined)
    } catch (e) {
      return fail(e)
    }
  })

  ipcMain.handle(
    'backup:get-path-info',
    (): IpcResult<{ dir: string; isCustom: boolean; isReachable: boolean }> => {
      try {
        const configuredPath = getBackupPathSetting()
        const defaultDir = getDefaultBackupsDir()
        const isCustom = !!configuredPath
        if (!isCustom) {
          return ok({ dir: defaultDir, isCustom: false, isReachable: true })
        }
        const dir = normalize(configuredPath)
        let isReachable = true
        try {
          mkdirSync(dir, { recursive: true })
          readdirSync(dir)
        } catch {
          isReachable = false
        }
        return ok({ dir, isCustom: true, isReachable })
      } catch (e) {
        return fail(e)
      }
    }
  )

  ipcMain.handle('app:relaunch', (): IpcResult<void> => {
    // Release the single-instance lock BEFORE spawning the successor:
    // graceful quit takes long enough that the relaunched process would
    // otherwise request the lock while we still hold it, lose, and quit —
    // leaving the user with no app at all after a restore/onboarding
    // relaunch (v1.13.2).
    app.releaseSingleInstanceLock()
    app.relaunch()
    // quit(), not exit(0): exit() skips Chromium's shutdown flush, losing
    // localStorage writes from the last few seconds (v1.13.2 — this is how
    // export prefs went missing after a backup restore). quit() runs
    // before-quit, which sets isQuitting so the tray-hide close handler
    // lets the window actually close.
    app.quit()
    return ok(undefined)
  })

  // ── Shell helpers ────────────────────────────────
  ipcMain.handle('shell:openPath', async (_e, path: string): Promise<IpcResult<void>> => {
    const err = await shell.openPath(path)
    if (err) return fail(err)
    return ok(undefined)
  })

  ipcMain.handle('shell:openExternal', async (_e, url: string): Promise<IpcResult<void>> => {
    if (!isExternalUrlAllowed(url)) return fail('Nur http:// und https:// Links erlaubt')
    await shell.openExternal(url)
    return ok(undefined)
  })

  ipcMain.handle('shell:showItemInFolder', (_e, path: string): IpcResult<void> => {
    shell.showItemInFolder(path)
    return ok(undefined)
  })

  // ── Paths (for Settings-View) ──────────────────────────
  ipcMain.handle(
    'paths:get',
    (): IpcResult<{
      db: string
      backups: string
      logs: string
      logFile: string
      mcp: McpRegistration
    }> => {
      // electron-log returns a File transport whose `getFile()` resolves
      // the on-disk log path lazily; the directory is its parent.
      const logFile = log.transports.file.getFile().path
      let backupsDir: string
      try {
        backupsDir = getBackupsDir(getBackupPathSetting() || undefined)
      } catch {
        backupsDir = getDefaultBackupsDir()
      }
      return ok({
        db: getDbPath(),
        backups: backupsDir,
        logs: dirname(logFile),
        logFile,
        // Settings → Integrationen renders this as a copy-paste `.mcp.json`.
        mcp: buildMcpRegistration(process.execPath, app.getAppPath())
      })
    }
  )

  ipcMain.handle('app:getVersion', (): IpcResult<string> => {
    return ok(app.getVersion())
  })

  /**
   * Full JSON export (#17, v1.3 PR B). Bundles every client + entry
   * (including soft-deleted + linked halves) + every settings row, plus a
   * meta header (`schemaVersion`, `exportedAt`, `appVersion`). Output is
   * intentionally human-readable (2-space indent) so the file is also a
   * trust-building artefact: open it in any text editor, see your data,
   * confidence in the app goes up.
   *
   * Pure data dump — no transforms, no PII filtering, no field renaming.
   * Future v1.3.x or v1.4 CSV/PDF exports build on top of this snapshot.
   */
  ipcMain.handle('export:json', async (): Promise<IpcResult<{ path: string; bytes: number }>> => {
    try {
      const today = new Date().toISOString().slice(0, 10)
      const result = await dialog.showSaveDialog({
        title: 'Datenexport speichern',
        defaultPath: `timetrack-export-${today}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }]
      })
      if (result.canceled || !result.filePath) {
        return fail('Export abgebrochen')
      }
      const payload = buildJsonExportPayload(db, app.getVersion())
      const json = JSON.stringify(payload, null, 2)
      writeFileSync(result.filePath, json, 'utf8')
      return ok({ path: result.filePath, bytes: Buffer.byteLength(json, 'utf8') })
    } catch (e) {
      return fail(e)
    }
  })

  // === PDF export (v1.3 PR C, issues #16 + #19) ===========================
  // The hero feature: client + date range → printable A4 PDF.
  // Pipeline: gather payload from DB → render template HTML → hidden
  // BrowserWindow + printToPDF → write to user-chosen path.

  ipcMain.handle(
    'pdf:export',
    async (_e, req: PdfRequest): Promise<IpcResult<{ path: string }>> => {
      try {
        if (!req || typeof req.clientId !== 'number' || !req.fromIso || !req.toIso) {
          return fail('Ungültige PDF-Anfrage')
        }
        const client = db.prepare(`SELECT id, name FROM clients WHERE id = ?`).get(req.clientId) as
          | { id: number; name: string }
          | undefined
        if (!client) return fail(`Kunde ${req.clientId} nicht gefunden`)

        const monthHint = req.fromIso.slice(0, 7) // YYYY-MM
        // Strip filesystem-hostile chars from the client name for the suggested filename.
        const safeName = client.name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'Kunde'
        // v1.9 #75: append project name when filtered to a single project.
        let projectSuffix = ''
        if (req.projectId != null) {
          const proj = db.prepare(`SELECT name FROM projects WHERE id = ?`).get(req.projectId) as
            | { name: string }
            | undefined
          if (proj) {
            projectSuffix = `-${proj.name.replace(/[\\/:*?"<>|]/g, '_').trim()}`
          }
        }
        const result = await dialog.showSaveDialog({
          title: 'Stundennachweis speichern',
          defaultPath: `Stundennachweis-${safeName}${projectSuffix}-${monthHint}.pdf`,
          filters: [{ name: 'PDF', extensions: ['pdf'] }]
        })
        if (result.canceled || !result.filePath) {
          return fail('Export abgebrochen')
        }

        const settingsRows = db.prepare(`SELECT key, value FROM settings`).all() as Array<{
          key: string
          value: string
        }>
        const settings = Object.fromEntries(
          settingsRows.map((r) => [r.key, r.value])
        ) as unknown as Settings
        const logoDataUrl = readLogoAsDataUrl(settings.pdf_logo_path ?? '')

        const payload = buildPdfPayload(db, req, logoDataUrl)
        const html = buildPdfHtml(payload)
        const buf = await renderPdfBuffer({ html })
        writeFileSync(result.filePath, buf)
        return ok({ path: result.filePath })
      } catch (e) {
        return fail(e)
      }
    }
  )

  // PDF merge-export: renders the Stundennachweis and appends it to an
  // existing invoice PDF chosen by the user. The invoice file is never
  // modified — the merged result is written next to it as
  // <stem>_inkl_Stundennachweis.pdf. Falls back to a save dialog when the
  // target directory is not writable (e.g. a corporate archive folder).
  // Core logic lives in pdfMergeHandlers.ts for testability.
  ipcMain.handle('pdf:merge-export', (_e, req) => mergeExportHandler(db, req))

  // PDF merge-only: merges two existing PDFs (Stundennachweis + invoice) without
  // re-rendering. Core logic lives in pdfMergeHandlers.ts for testability.
  ipcMain.handle('pdf:merge-only', (_e, req) => mergeOnlyHandler(req))

  // PDF info: returns page count for a given PDF path. Used by the renderer to
  // show page counts before confirming a merge.
  ipcMain.handle('pdf:pdf-info', (_e, req) => pdfInfoHandler(req))

  // PDF open dialog: opens a native file picker and returns the selected path.
  // Safer than relying on file.path in the renderer (not available with contextIsolation).
  ipcMain.handle(
    'pdf:open-pdf-dialog',
    async (): Promise<IpcResult<{ filePath: string } | null>> => {
      try {
        const result = await dialog.showOpenDialog({
          title: 'PDF auswählen',
          filters: [{ name: 'PDF', extensions: ['pdf'] }],
          properties: ['openFile']
        })
        if (result.canceled || !result.filePaths[0]) return ok(null)
        return ok({ filePath: result.filePaths[0] })
      } catch (e) {
        return fail(e)
      }
    }
  )

  // Logo picker — copies user-chosen image into userData/pdf-logo.<ext>
  // and persists the path into settings.pdf_logo_path.
  ipcMain.handle('logo:set', async (): Promise<IpcResult<{ path: string }>> => {
    try {
      const result = await dialog.showOpenDialog({
        title: 'Logo auswählen',
        properties: ['openFile'],
        filters: [{ name: 'Bilder', extensions: ['png', 'jpg', 'jpeg', 'svg', 'webp'] }]
      })
      if (result.canceled || result.filePaths.length === 0) {
        return fail('Auswahl abgebrochen')
      }
      const userDataDir = app.getPath('userData')
      const target = saveLogo(result.filePaths[0], userDataDir)
      db.prepare(
        `INSERT INTO settings (key, value) VALUES ('pdf_logo_path', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ).run(target)
      return ok({ path: target })
    } catch (e) {
      return fail(e)
    }
  })

  ipcMain.handle('logo:clear', async (): Promise<IpcResult<void>> => {
    try {
      const userDataDir = app.getPath('userData')
      removeLogo(userDataDir)
      db.prepare(
        `INSERT INTO settings (key, value) VALUES ('pdf_logo_path', '')
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ).run()
      return ok(undefined)
    } catch (e) {
      return fail(e)
    }
  })

  // === CSV export (v1.5 PR C, issue #18) ===================================
  ipcMain.handle(
    'csv:export',
    async (_e, req: CsvRequest): Promise<IpcResult<{ path: string }>> => {
      return handleCsvExport(db, req)
    }
  )

  // === iCal export (#135, Stufe 1 — statischer .ics-Export) ================
  ipcMain.handle(
    'ical:export',
    async (_e, req: IcalRequest): Promise<IpcResult<{ path: string }>> => {
      return handleIcalExport(db, req)
    }
  )

  // === Licenses (v1.5 PR F, issue #35) =====================================
  // Reads resources/licenses.json generated by scripts/generate-licenses.mjs.
  // In dev: app.getAppPath() → project root. In production: asar root.
  ipcMain.handle('app:getLicenses', (): IpcResult<LicenseEntry[]> => {
    try {
      const licensesPath = join(app.getAppPath(), 'resources', 'licenses.json')
      const raw = readFileSync(licensesPath, 'utf8')
      return ok(JSON.parse(raw) as LicenseEntry[])
    } catch (e) {
      return fail(e)
    }
  })

  // ── Analytics (v1.10 #93) ─────────────────────────────────────────────
  registerAnalyticsHandlers(db)

  // ── Budget (v1.11 #94) ────────────────────────────────────────────────
  registerBudgetHandlers(db)

  // ── Tags (v1.12 #107) ────────────────────────────────────────────────
  registerTagHandlers(db)

  // ── Microsoft Graph account (#130) ───────────────────────────
  registerGraphHandlers(db)
}

/**
 * Server-side validation for project create/update.
 * Returns an error string if invalid, `null` if valid.
 */
function validateProject(
  input: CreateProjectInput | UpdateProjectInput,
  db?: ReturnType<typeof getDb>
): string | null {
  const name = input.name?.trim() ?? ''
  if (name.length === 0) return 'Name darf nicht leer sein'
  if (name.length > 100) return 'Name darf höchstens 100 Zeichen lang sein'
  if (['allgemein', 'general'].includes(name.toLowerCase())) {
    return `"${input.name}" ist ein reservierter Name`
  }
  if (input.rate_cent !== undefined && input.rate_cent !== null) {
    const rate = Number(input.rate_cent)
    if (!Number.isFinite(rate) || rate < 0) return 'Stundensatz darf nicht negativ sein'
  }
  if (db && input.client_id !== null && input.client_id !== undefined) {
    const clientRow = db.prepare('SELECT id FROM clients WHERE id = ?').get(input.client_id) as
      | { id: number }
      | undefined
    if (!clientRow) return 'Kunde existiert nicht'
  }
  return null
}
