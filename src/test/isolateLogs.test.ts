/**
 * #243: under test, every electron-log file lands in the temp test directory,
 * never in the real userData. Checked on the resolved paths, not on the real
 * main.log's mtime — the installed app may write there at any time.
 */
import { describe, expect, it } from 'vitest'
import log from 'electron-log/main'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { auditLogPath } from '../main/mcpAudit'

// Spelled out here, not imported from ./isolateLogs: importing the setup
// module would apply it and keep this test green without the setupFiles entry.
const TEST_LOG_DIR = join(tmpdir(), 'time-tracking-test-logs')

function under(dir: string, path: string): boolean {
  return resolve(path).toLowerCase().startsWith(resolve(dir).toLowerCase())
}

describe('log isolation in tests', () => {
  const realUserData = join(process.env.APPDATA ?? '', 'time-tracking')

  it('the default logger writes into the temp test directory', () => {
    const path = log.transports.file.getFile().path
    expect(under(TEST_LOG_DIR, path)).toBe(true)
    if (process.env.APPDATA) expect(under(realUserData, path)).toBe(false)
  })

  it('a logger made with log.create keeps its file name but lands there too', () => {
    const scoped = log.create({ logId: 'isolate-test' })
    scoped.transports.file.fileName = 'scoped.log'
    const path = scoped.transports.file.getFile().path
    expect(path).toBe(join(TEST_LOG_DIR, 'scoped.log'))
  })

  it('the MCP audit log, made at import time, is redirected as well', () => {
    // A path check, no write: a test that writes to prove the redirect would
    // write into the real audit log exactly when the redirect is missing.
    expect(auditLogPath()).toBe(join(TEST_LOG_DIR, 'mcp-writes.log'))
  })
})
