/**
 * Append-only audit log for MCP write-mode mutations.
 *
 * Uses a dedicated electron-log scope so entries land next to the app logs
 * (%AppData%/time-tracking/logs on Windows) as `mcp-writes.log`, with the same
 * size-based rotation electron-log already provides. Never records the token
 * or `private_note` content.
 */
import log from 'electron-log/main'

const mcpLog = log.create({ logId: 'mcp' })
mcpLog.transports.file.fileName = 'mcp-writes.log'
// Console transport would duplicate into the main log; keep it file-only.
mcpLog.transports.console.level = false

export interface McpAuditEntry {
  op: string
  /** Origin scope; 'controller' for hardware-key writes (#133), absent for MCP. */
  source?: string
  /** Resulting/affected entry id, if any. */
  id?: number | null
  client_id?: number | null
  started_at?: string | null
  stopped_at?: string | null
  /** True when the request carried a non-empty private note (content omitted). */
  hasPrivateNote?: boolean
}

/** Where the audit log is written; lets the tests check it is never the real file (#243). */
export function auditLogPath(): string {
  return mcpLog.transports.file.getFile().path
}

/** Append one committed mutation to the audit log. */
export function auditWrite(entry: McpAuditEntry): void {
  try {
    mcpLog.info('write', JSON.stringify(entry))
  } catch {
    // Auditing must never break a mutation.
  }
}
