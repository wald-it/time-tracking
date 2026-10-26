import { ipcMain } from 'electron'
import type Database from 'better-sqlite3'
import type { BudgetStatus, IpcResult } from '../shared/types'
import { budgetUsedMinutesSql } from '../shared/currency'

export type { BudgetStatus }

function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data }
}
function fail(error: unknown): IpcResult<never> {
  return { ok: false, error: String(error) }
}

/**
 * Core budget-status computation — extracted so it can be tested without
 * Electron IPC.
 *
 * - `usedMinutes` is what the invoice bills for the project (#285): completed,
 *   billable entries, each billed by the rule of `billing_lines`. The currently
 *   running entry is excluded; it hasn't been billed yet.
 * - When the project doesn't exist, returns `{ budgetMinutes: null, usedMinutes: 0 }`
 *   (silent fallback — suppresses any budget toast).
 */
export function buildBudgetStatus(
  db: Database.Database,
  projectId: number
): IpcResult<BudgetStatus> {
  try {
    const project = db
      .prepare('SELECT budget_minutes FROM projects WHERE id = ?')
      .get(projectId) as { budget_minutes: number | null } | undefined

    // Unknown project → silent fallback; caller suppresses toast/bar.
    if (!project) {
      return ok({ budgetMinutes: null, usedMinutes: 0 })
    }

    // Billed like the invoice: the view billing_lines.
    const usedRow = db
      .prepare(
        `SELECT used_minutes FROM (${budgetUsedMinutesSql()}) WHERE project_id = ?`
      )
      .get(projectId) as { used_minutes: number } | undefined

    return ok({
      budgetMinutes: project.budget_minutes ?? null,
      usedMinutes: usedRow?.used_minutes ?? 0
    })
  } catch (e) {
    return fail(e)
  }
}

/**
 * Registers the `projects:getBudgetStatus` IPC handler.
 *
 * Used by the timer-start flow to show a toast when a project is ≥80%
 * over budget. The QuickStart pill reads `used_minutes` from
 * `projects:getAll` (aggregated via LEFT JOIN) instead of calling this
 * handler, to avoid N round-trips per render.
 */
export function registerBudgetHandlers(db: Database.Database): void {
  ipcMain.handle('projects:getBudgetStatus', (_e, projectId: number): IpcResult<BudgetStatus> => {
    return buildBudgetStatus(db, projectId)
  })
}
