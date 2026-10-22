/**
 * Vitest setup for the node project: no test writes into the real userData
 * log files (#243). Under Vitest the main-process modules run on the Electron
 * binary in node mode, where electron-log resolves its files to the real
 * `%APPDATA%\time-tracking\logs` — test runs ended up in the user's
 * `main.log`, interleaved with the installed app's own lines.
 *
 * Every file transport is pointed at one temp directory instead: the default
 * logger here, and every logger made with `log.create(…)` later (mcpAudit,
 * webhookLog) through a wrapped `create`. The file name each logger sets
 * (`mcp-writes.log`, `webhooks.log`) is kept, so the files stay apart.
 *
 * Runs before the test file imports anything, so no module can log first.
 */
import log from 'electron-log/main'
import { tmpdir } from 'os'
import { join } from 'path'

export const TEST_LOG_DIR = join(tmpdir(), 'time-tracking-test-logs')

type Logger = typeof log

function redirect(logger: Pick<Logger, 'transports'>): void {
  logger.transports.file.resolvePathFn = (variables) =>
    join(TEST_LOG_DIR, variables.fileName ?? 'main.log')
}

redirect(log)

const create = log.create.bind(log)
log.create = ((options: Parameters<Logger['create']>[0]) => {
  const logger = create(options)
  redirect(logger)
  return logger
}) as Logger['create']
