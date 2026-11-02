import { ipcMain } from 'electron'
import type Database from 'better-sqlite3'
import type { BudgetStatus, IpcResult, Project } from '../shared/types'
import {
  budgetUsageSql,
  budgetPeriodUsageSql,
  budgetBounds,
  projectBudgetStatus
} from '../shared/currency'

export type { BudgetStatus }

function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data }
}
function fail(error: unknown): IpcResult<never> {
  return { ok: false, error: error instanceof Error ? error.message : String(error) }
}

/** Invoice consumption in the active budget unit and period. */
export function buildBudgetStatus(
  db: Database.Database,
  projectId: number
): IpcResult<BudgetStatus> {
  try {
    const project = db
      .prepare(
        `SELECT p.*, ${budgetPeriodUsageSql()}
      FROM projects p LEFT JOIN (${budgetUsageSql()}) bud ON bud.project_id = p.id
      WHERE p.id = ?`
      )
      .get(budgetBounds(), projectId) as Project | undefined
    return ok(projectBudgetStatus(project ?? {}))
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
