/**
 * Shared fixtures for the MCP write-bridge tests (mcpBridgeCore.test.ts and
 * mcpBridgeLocalTime.test.ts): a seeded in-memory DB and a ctx with spies.
 */
import type Database from 'better-sqlite3'
import type { BridgeCtx, BridgeRequest } from '../main/mcpBridgeCore'
import { applyMigrations } from './sqlite'

export function seed(db: Database.Database): void {
  db.pragma('foreign_keys = ON')
  applyMigrations(db)
  db.prepare(
    `INSERT INTO clients (id, name, color, active, rate_cent) VALUES (1,'Acme','#111',1,0)`
  ).run()
  db.prepare(
    `INSERT INTO clients (id, name, color, active, rate_cent) VALUES (2,'Beta','#222',1,0)`
  ).run()
  db.prepare(
    `INSERT INTO projects (id, client_id, name, status, active) VALUES (10, 1, 'Rollout', 'active', 1)`
  ).run()
  db.prepare(
    `INSERT INTO projects (id, client_id, name, status, active) VALUES (20, 2, 'Audit', 'active', 1)`
  ).run()
  db.prepare(
    `INSERT INTO projects (id, client_id, name, status, active) VALUES (30, 1, 'Altlast', 'archived', 0)`
  ).run()
}

export interface Spies {
  confirmCalls: number
  backupCalls: number
  auditCalls: number
  changeCalls: number
  webhooks: string[]
}

export function makeCtx(
  db: Database.Database,
  o: Partial<{
    token: string | null
    incomingWriteEnabled: boolean
    approve: boolean
    controllerToken: string | null
    controllerEnabled: boolean
  }> = {}
): { ctx: BridgeCtx; spies: Spies } {
  const spies: Spies = {
    confirmCalls: 0,
    backupCalls: 0,
    auditCalls: 0,
    changeCalls: 0,
    webhooks: []
  }
  const ctx: BridgeCtx = {
    db,
    token: o.token === undefined ? 'secret' : o.token,
    isWriteEnabled: () => o.incomingWriteEnabled !== false,
    controllerToken: o.controllerToken === undefined ? 'ctl' : o.controllerToken,
    isControllerEnabled: () => o.controllerEnabled !== false,
    confirm: async () => {
      spies.confirmCalls++
      return o.approve !== false
    },
    ensureBackup: async () => {
      spies.backupCalls++
    },
    audit: () => {
      spies.auditCalls++
    },
    onChange: () => {
      spies.changeCalls++
    },
    emitWebhook: (op) => {
      spies.webhooks.push(op)
    }
  }
  return { ctx, spies }
}

export const CREATE: BridgeRequest = {
  v: 1,
  token: 'secret',
  op: 'create_manual_entry',
  args: {
    client_id: 1,
    description: 'Feature',
    started_at: '2026-06-10T09:00:00.000Z',
    stopped_at: '2026-06-10T10:00:00.000Z'
  }
}

export function countEntries(db: Database.Database): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM entries`).get() as { n: number }).n
}
