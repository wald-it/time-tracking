import { it } from 'vitest'
import { fsyncSync, openSync, closeSync, writeSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { LAST_V1_VERSION, createMigratedTemplate, loadSqlite, openMigratedCopy } from './sqlite'
import { generateLegacyDb } from './legacyEntriesGenerator'
import { migrateEntriesToV2 } from '../main/entryLifecycle/migrateV2'
const out: string[] = []
const log = (...a: unknown[]): void => { out.push(a.join(' ')) }
const ms = (t: number): number => Math.round(performance.now() - t)
it('probe378', async () => {
  const C = await loadSqlite()
  log('platform', process.platform, 'tmpdir', tmpdir())
  const td = mkdtempSync(join(tmpdir(), 't378-'))
  let t = performance.now()
  const tpl = createMigratedTemplate(C, td, LAST_V1_VERSION)
  log('template ms', ms(t))
  // raw fsync cost
  const fd = openSync(join(td, 'f.bin'), 'w')
  t = performance.now()
  for (let i = 0; i < 20; i++) { writeSync(fd, 'x'); fsyncSync(fd) }
  log('20x write+fsync ms', ms(t))
  closeSync(fd)
  for (const mode of ['default', 'off', 'default', 'off']) {
    t = performance.now()
    const d = mkdtempSync(join(tmpdir(), 't378d-'))
    const tm = ms(t)
    t = performance.now()
    const db = openMigratedCopy(C, tpl, d)
    const tc = ms(t)
    if (mode === 'off') db.pragma('synchronous = OFF')
    t = performance.now()
    const g = generateLegacyDb(db, 5)
    const tg = ms(t)
    t = performance.now()
    db.transaction(() => migrateEntriesToV2(db))()
    const tmig = ms(t)
    t = performance.now()
    db.close()
    const tcl = ms(t)
    t = performance.now()
    rmSync(d, { recursive: true, force: true })
    log(mode, 'mkdtemp', tm, 'copy+open', tc, 'gen', tg, 'rows', g.rows.length, 'migrate', tmig, 'close', tcl, 'rm', ms(t))
  }
  rmSync(td, { recursive: true, force: true })
  throw new Error('PROBE378 ' + out.join(' | '))
}, 120000)
