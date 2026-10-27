import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'node:crypto'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'
import { seedEntry } from '../test/entryFixtures'
import { saveLogo, removeLogo, readLogoAsDataUrl } from './logo'
import { createRun, openRunPdf, renderRunHtml } from './billingRuns'
import { createBackupSync } from './backup'

let userDataDir: string
vi.mock('electron', () => ({ app: { getPath: () => userDataDir } }))
let Sqlite: DatabaseCtor
beforeAll(async () => {
  Sqlite = await loadSqlite()
})
afterEach(() => {
  if (userDataDir) rmSync(userDataDir, { recursive: true, force: true })
})
it('carries the PDF BLOB and hash through the real WAL backup mechanism', async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'tt-run-backup-'))
  const db = new Sqlite(join(userDataDir, 'source.sqlite'))
  let path: string
  let id: number
  let expected: Buffer
  let pdfHash: string
  try {
    db.pragma('journal_mode = WAL')
    db.pragma('wal_autocheckpoint = 0')
    applyMigrations(db)
    db.exec("INSERT INTO clients (id, name, short_code) VALUES (1, 'A', 'A')")
    seedEntry(db, {
      client_id: 1,
      started_at: '2026-10-20T09:00:00Z',
      stopped_at: '2026-10-20T10:00:00Z'
    })
    const run = await createRun(
      db,
      { clientId: 1, fromIso: '2026-10-01', toIso: '2026-10-31' },
      async (html) => Buffer.from(html)
    )
    id = run.id
    pdfHash = run.pdf_sha256
    expected = openRunPdf(db, id)
    path = createBackupSync(db, 'manual')
  } finally {
    db.close()
  }
  const restored = new Sqlite(path!)
  try {
    expect(openRunPdf(restored, id!)).toEqual(expected!)
    expect(createHash('sha256').update(openRunPdf(restored, id!)).digest('hex')).toBe(pdfHash!)
    expect(restored.pragma('integrity_check', { simple: true })).toBe('ok')
  } finally {
    restored.close()
  }
})

it('keeps the embedded logo after saveLogo replaces and removeLogo deletes the original', async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'tt-run-logo-'))
  const db = new Sqlite(':memory:')
  try {
    applyMigrations(db)
    db.exec("INSERT INTO clients (id, name, short_code) VALUES (1, 'A', 'A')")
    seedEntry(db, {
      client_id: 1,
      started_at: '2026-10-20T09:00:00Z',
      stopped_at: '2026-10-20T10:00:00Z'
    })
    const source = join(userDataDir, 'source.png')
    writeFileSync(source, 'original image')
    const stored = saveLogo(source, join(userDataDir, 'logos'))
    const run = await createRun(
      db,
      { clientId: 1, fromIso: '2026-10-01', toIso: '2026-10-31' },
      async (html) => Buffer.from(html),
      { logoDataUrl: readLogoAsDataUrl(stored) }
    )
    writeFileSync(source, 'replacement image')
    saveLogo(source, join(userDataDir, 'logos'))
    expect(createHash('sha256').update(renderRunHtml(db, run.id)).digest('hex')).toBe(
      run.html_sha256
    )
    removeLogo(join(userDataDir, 'logos'))
    expect(readLogoAsDataUrl(stored)).toBe('')
    expect(createHash('sha256').update(renderRunHtml(db, run.id)).digest('hex')).toBe(
      run.html_sha256
    )
  } finally {
    db.close()
  }
})
