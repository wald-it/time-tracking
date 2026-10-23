/**
 * The bridge's confirmation text and preview in local time (owner review
 * 2026-10-22), pinned to Europe/Berlin.
 *
 * Its own file on purpose: `delete process.env.TZ` does not reset Node's time
 * zone (measured: after TZ=America/New_York and a delete, Date still reads
 * -04:00), while SQLite's 'localtime' never follows process.env.TZ on Windows.
 * Pinned in mcpBridgeCore.test.ts, JS kept computing in Berlin after this
 * block, SQLite in the runner's UTC, and the later get_summary test (JS
 * midnight against DATE('now','localtime')) found no entry for today — on the
 * Windows CI runner only. Vitest runs each test file in its own process, so
 * the pin cannot leak out of this file.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import { handleRequest, type BridgeCtx, type BridgeRequest } from './mcpBridgeCore'
import { loadSqlite, type DatabaseCtor } from '../test/sqlite'
import { makeCtx, seed } from '../test/bridgeKit'

let DatabaseImpl: DatabaseCtor

beforeAll(async () => {
  DatabaseImpl = await loadSqlite()
})

describe('handleRequest — confirmation and preview speak local time (Europe/Berlin)', () => {
  let db: Database.Database
  const previousTz = process.env.TZ
  beforeEach(() => {
    process.env.TZ = 'Europe/Berlin'
    db = new DatabaseImpl(':memory:')
    seed(db)
  })
  afterEach(() => {
    if (previousTz === undefined) delete process.env.TZ
    else process.env.TZ = previousTz
  })

  /** A ctx that records what the owner is asked to confirm. */
  function recording(): { ctx: BridgeCtx; asked: string[] } {
    const { ctx } = makeCtx(db)
    const asked: string[] = []
    ctx.confirm = async (summary) => {
      asked.push(summary)
      return true
    }
    return { ctx, asked }
  }

  function create(started_at: string, stopped_at: string, preview = false): BridgeRequest {
    return {
      v: 1,
      token: 'secret',
      op: 'create_manual_entry',
      args: { client_id: 1, description: 'Workshop', started_at, stopped_at },
      preview
    }
  }

  const HINT =
    'Hinweis: +02:00 weicht von der Ortszeit am 28.10. ab (+01:00) — wird als 08:00 Ortszeit gespeichert.'

  it('create: the dialog shows the local span, no note when the offset fits', async () => {
    const { ctx, asked } = recording()
    await handleRequest(ctx, create('2025-10-28T09:00:00+01:00', '2025-10-28T12:00:00+01:00'))
    expect(asked).toEqual([
      'Eintrag nachtragen — Kunde Acme, Di 28.10.2025 09:00–12:00 (180 min)\nBeschreibung: "Workshop"'
    ])
  })

  it('create: a summer-time offset after the change gets a note in dialog and preview', async () => {
    const { ctx, asked } = recording()
    const prev = await handleRequest(
      ctx,
      create('2025-10-28T09:00:00+02:00', '2025-10-28T12:00:00+01:00', true)
    )
    expect(prev.ok).toBe(true)
    if (prev.ok) {
      expect(prev.data).toMatchObject({
        started_at: '2025-10-28T07:00:00.000Z',
        started_local: '2025-10-28T08:00:00+01:00',
        stopped_local: '2025-10-28T12:00:00+01:00',
        zeit_hinweise: { started_at: HINT }
      })
      expect(prev.data).not.toHaveProperty('zeit_hinweise.stopped_at')
    }
    await handleRequest(ctx, create('2025-10-28T09:00:00+02:00', '2025-10-28T12:00:00+01:00'))
    expect(asked[0]).toBe(
      `Eintrag nachtragen — Kunde Acme, Di 28.10.2025 08:00–12:00 (240 min)\nBeschreibung: "Workshop"\nStart: ${HINT}`
    )
  })

  it('create: Z gets no note', async () => {
    const { ctx } = recording()
    const prev = await handleRequest(
      ctx,
      create('2025-10-28T08:00:00Z', '2025-10-28T11:00:00Z', true)
    )
    expect(prev.ok).toBe(true)
    if (prev.ok) expect(prev.data).not.toHaveProperty('zeit_hinweise')
  })

  it('update: the dialog shows before and after in local time; the preview both sides', async () => {
    const { ctx, asked } = recording()
    await handleRequest(ctx, create('2025-10-28T09:00:00+01:00', '2025-10-28T12:00:00+01:00'))
    const { id } = db.prepare(`SELECT id FROM entries`).get() as { id: number }
    const upd = {
      v: 1,
      token: 'secret',
      op: 'update_entry_fields',
      args: { id, stopped_at: '2025-10-28T13:00:00+01:00' }
    }
    const prev = await handleRequest(ctx, { ...upd, preview: true })
    if (prev.ok) {
      expect(prev.data).toMatchObject({
        before: { stopped_local: '2025-10-28T12:00:00+01:00' },
        after: { stopped_local: '2025-10-28T13:00:00+01:00' }
      })
    }
    await handleRequest(ctx, upd)
    expect(asked[1]).toBe(
      `Eintrag #${id} ändern — vorher Di 28.10.2025 09:00–12:00, nachher Di 28.10.2025 09:00–13:00\nBeschreibung: "Workshop"`
    )
  })

  it('update in the repeated hour: before and after differ in the dialog', async () => {
    const { ctx, asked } = recording()
    await handleRequest(ctx, create('2025-10-26T02:15:00+02:00', '2025-10-26T03:15:00+01:00'))
    const { id } = db.prepare(`SELECT id FROM entries`).get() as { id: number }
    await handleRequest(ctx, {
      v: 1,
      token: 'secret',
      op: 'update_entry_fields',
      args: { id, started_at: '2025-10-26T02:15:00+01:00' }
    })
    expect(asked[1]).toBe(
      `Eintrag #${id} ändern — vorher So 26.10.2025 02:15 (+02:00)–03:15 (+01:00), ` +
        `nachher So 26.10.2025 02:15 (+01:00)–03:15 (+01:00)\nBeschreibung: "Workshop"`
    )
  })

  it('an executed write returns its offset notes too (no dialog in silent mode)', async () => {
    // makeCtx approves without asking — what confirm mode "silent" does
    const { ctx } = makeCtx(db)
    const started = await handleRequest(ctx, {
      v: 1,
      token: 'secret',
      op: 'start_timer',
      args: { client_id: 1, started_at: '2025-10-28T09:00:00+02:00' }
    })
    expect(started.ok).toBe(true)
    if (started.ok) {
      expect(started.data).toMatchObject({
        started_at: '2025-10-28T07:00:00.000Z',
        zeit_hinweise: {
          started_at:
            'Hinweis: +02:00 weicht von der Ortszeit am 28.10. ab (+01:00) — wird als 08:00 Ortszeit gespeichert.'
        }
      })
    }
    const created = await handleRequest(
      ctx,
      create('2025-10-28T09:00:00+02:00', '2025-10-28T12:00:00+01:00')
    )
    if (created.ok) expect(created.data).toHaveProperty('zeit_hinweise.started_at')
    const plain = await handleRequest(
      ctx,
      create('2025-10-29T09:00:00+01:00', '2025-10-29T10:00:00+01:00')
    )
    if (plain.ok) expect(plain.data).not.toHaveProperty('zeit_hinweise')
  })

  it('start_timer: the dialog names a given start, else "ab jetzt"', async () => {
    const { ctx, asked } = recording()
    await handleRequest(ctx, {
      v: 1,
      token: 'secret',
      op: 'start_timer',
      args: { client_id: 1, description: 'Call', started_at: '2025-10-28T09:00:00+01:00' }
    })
    await handleRequest(ctx, {
      v: 1,
      token: 'secret',
      op: 'start_timer',
      args: { client_id: 1, description: 'Call' }
    })
    expect(asked[0]).toBe(
      'Timer starten — Kunde Acme, ab Di 28.10.2025 09:00\nBeschreibung: "Call"'
    )
    // the second start ends the first one "now"
    expect(asked[1]).toMatch(
      /^Timer starten — Kunde Acme, ab jetzt; beendet #\d+ \(Acme\) um (\S+ \d\d\.\d\d\.\d{4} )?\d\d:\d\d\nBeschreibung: "Call"$/
    )
  })

  // Owner review PR 5a: start_timer switches like the app (B1) — the dialog
  // says which entry ends and when, and the receiver hears timer.stopped
  // for it before timer.started.
  it('start_timer while running: dialog and preview name the ended entry, stop before start', async () => {
    const { ctx, asked } = recording()
    const { ctx: base, spies } = makeCtx(db)
    ctx.emitWebhook = base.emitWebhook
    await handleRequest(ctx, {
      v: 1,
      token: 'secret',
      op: 'start_timer',
      args: { client_id: 1, description: 'Call', started_at: '2025-10-28T09:00:00+01:00' }
    })
    const first = db.prepare(`SELECT id FROM entries`).get() as { id: number }
    const req: BridgeRequest = {
      v: 1,
      token: 'secret',
      op: 'start_timer',
      args: { client_id: 2, description: 'Audit', started_at: '2025-10-28T10:00:00+01:00' }
    }
    const prev = await handleRequest(ctx, { ...req, preview: true })
    expect(prev.ok).toBe(true)
    if (prev.ok) {
      expect(prev.data).toMatchObject({
        stops: {
          id: first.id,
          client_name: 'Acme',
          stopped_at: '2025-10-28T09:00:00.000Z',
          stopped_local: '2025-10-28T10:00:00+01:00'
        }
      })
    }
    await handleRequest(ctx, req)
    expect(asked[1]).toBe(
      `Timer starten — Kunde Beta, ab Di 28.10.2025 10:00; beendet #${first.id} (Acme) um 10:00\nBeschreibung: "Audit"`
    )
    expect(spies.webhooks).toEqual(['start_timer', 'stop_running_timer', 'start_timer'])
    const ended = db.prepare(`SELECT stopped_at FROM entries WHERE id = ?`).get(first.id)
    expect(ended).toEqual({ stopped_at: '2025-10-28T09:00:00.000Z' })
  })

  it('start_timer more than a minute ahead is refused before any dialog', async () => {
    const { ctx, asked } = recording()
    await handleRequest(ctx, {
      v: 1,
      token: 'secret',
      op: 'start_timer',
      args: { client_id: 1, description: 'Call' }
    })
    const ahead = new Date(Date.now() + 10 * 60_000).toISOString()
    const req: BridgeRequest = {
      v: 1,
      token: 'secret',
      op: 'start_timer',
      args: { client_id: 2, started_at: ahead }
    }
    for (const preview of [true, false]) {
      const res = await handleRequest(ctx, { ...req, preview })
      expect(res).toMatchObject({
        ok: false,
        code: 'invalid',
        error: 'Startzeit liegt in der Zukunft'
      })
    }
    expect(asked).toHaveLength(1)
    const running = db.prepare(`SELECT client_id FROM entries WHERE stopped_at IS NULL`).all()
    expect(running).toEqual([{ client_id: 1 }])
  })

  it('start_timer before the running start is refused before any dialog', async () => {
    const { ctx, asked } = recording()
    await handleRequest(ctx, {
      v: 1,
      token: 'secret',
      op: 'start_timer',
      args: { client_id: 1, started_at: '2025-10-28T09:00:00+01:00' }
    })
    const res = await handleRequest(ctx, {
      v: 1,
      token: 'secret',
      op: 'start_timer',
      args: { client_id: 2, started_at: '2025-10-28T08:00:00+01:00' },
      preview: true
    })
    expect(res).toMatchObject({
      ok: false,
      error: 'Startzeit liegt vor dem Beginn des laufenden Eintrags'
    })
    expect(asked).toHaveLength(1)
  })

  it('start_timer refuses when the running entry changed while the dialog was open', async () => {
    const { ctx } = makeCtx(db)
    await handleRequest(ctx, {
      v: 1,
      token: 'secret',
      op: 'start_timer',
      args: { client_id: 1, started_at: '2025-10-28T09:00:00+01:00' }
    })
    // The owner switches in the app while the MCP confirmation is open.
    ctx.confirm = async () => {
      db.prepare(`UPDATE entries SET stopped_at = started_at WHERE stopped_at IS NULL`).run()
      db.prepare(
        `INSERT INTO entries (client_id, description, started_at, heartbeat_at)
         VALUES (2, '', '2025-10-28T08:30:00.000Z', '2025-10-28T08:30:00.000Z')`
      ).run()
      return true
    }
    const res = await handleRequest(ctx, {
      v: 1,
      token: 'secret',
      op: 'start_timer',
      args: { client_id: 1, started_at: '2025-10-28T10:00:00+01:00' }
    })
    expect(res).toMatchObject({ ok: false, code: 'invalid' })
    const running = db.prepare(`SELECT client_id FROM entries WHERE stopped_at IS NULL`).all()
    expect(running).toEqual([{ client_id: 2 }])
  })

  it('start_timer ending an entry from another day names the date', async () => {
    const { ctx, asked } = recording()
    await handleRequest(ctx, {
      v: 1,
      token: 'secret',
      op: 'start_timer',
      args: { client_id: 1, started_at: '2025-10-27T17:00:00+01:00' }
    })
    await handleRequest(ctx, {
      v: 1,
      token: 'secret',
      op: 'start_timer',
      args: { client_id: 2, started_at: '2025-10-28T09:00:00+01:00' }
    })
    expect(asked[1]).toMatch(/; beendet #\d+ \(Acme\) um Di 28\.10\.2025 09:00\n/)
  })

  // Owner decision 2026-10-23: the dialog and the preview name every field the
  // write commits, before → after; unchanged fields stay out, and the private
  // note is only ever "geändert", never its text.
  describe('every committed field is visible', () => {
    const NOTE = 'Notiztext-neu-4711'
    const OLD_NOTE = 'Notiztext-alt-0815'

    /** update_entry_fields re-inserts the entry, so its id moves on. */
    function latestId(): number {
      return (
        db.prepare(`SELECT MAX(id) AS id FROM entries WHERE deleted_at IS NULL`).get() as {
          id: number
        }
      ).id
    }

    function update(id: number, args: Record<string, unknown>, preview = false): BridgeRequest {
      return { v: 1, token: 'secret', op: 'update_entry_fields', args: { id, ...args }, preview }
    }

    async function seeded(ctx: BridgeCtx): Promise<number> {
      await handleRequest(ctx, {
        ...create('2025-10-28T09:00:00+01:00', '2025-10-28T12:00:00+01:00'),
        args: {
          client_id: 1,
          project_id: 10,
          description: 'Workshop',
          started_at: '2025-10-28T09:00:00+01:00',
          stopped_at: '2025-10-28T12:00:00+01:00'
        }
      })
      return (db.prepare(`SELECT id FROM entries`).get() as { id: number }).id
    }

    it('update: client, project and billable change show by name, before → after', async () => {
      const { ctx, asked } = recording()
      const id = await seeded(ctx)
      const args = { client_id: 2, project_id: 20, billable: false }
      const prev = await handleRequest(ctx, update(id, args, true))
      expect(prev.ok).toBe(true)
      if (prev.ok) {
        expect((prev.data as { changes: unknown }).changes).toEqual({
          client_id: { before: { id: 1, name: 'Acme' }, after: { id: 2, name: 'Beta' } },
          project_id: { before: { id: 10, name: 'Rollout' }, after: { id: 20, name: 'Audit' } },
          billable: { before: true, after: false }
        })
      }
      await handleRequest(ctx, update(id, args))
      expect(asked[1]).toBe(
        `Eintrag #${id} ändern — vorher Di 28.10.2025 09:00–12:00, nachher Di 28.10.2025 09:00–12:00\n` +
          'Kunde: Acme → Beta\nProjekt: Rollout → Audit\nabrechenbar: ja → nein\nBeschreibung: "Workshop"'
      )
    })

    it('update: removing the project reads "Kein Projekt"; tags and reference before → after', async () => {
      const { ctx, asked } = recording()
      const id = await seeded(ctx)
      const args = { project_id: null, tags: ',bug,ux,', reference: 'JIRA-7' }
      const prev = await handleRequest(ctx, update(id, args, true))
      if (prev.ok) {
        expect((prev.data as { changes: unknown }).changes).toEqual({
          project_id: { before: { id: 10, name: 'Rollout' }, after: null },
          tags: { before: '', after: ',bug,ux,' },
          reference: { before: '', after: 'JIRA-7' }
        })
      }
      await handleRequest(ctx, update(id, args))
      expect(asked[1].split('\n').slice(1)).toEqual([
        'Projekt: Rollout → Kein Projekt',
        'Beschreibung: "Workshop"',
        'Tags: (leer) → bug, ux',
        'Referenz: (leer) → "JIRA-7"'
      ])
    })

    it('update: the dialog shows the private note before → after; preview and audit never the text', async () => {
      const { ctx, asked } = recording()
      const audited: unknown[] = []
      ctx.audit = (e) => {
        audited.push(e)
      }
      const id = await seeded(ctx)
      await handleRequest(ctx, update(id, { private_note: OLD_NOTE }))
      const id2 = latestId()
      const prev = await handleRequest(ctx, update(id2, { private_note: NOTE }, true))
      expect(prev.ok).toBe(true)
      if (prev.ok) {
        // privacy setting off (default): only that the note changes
        expect(JSON.stringify(prev.data)).not.toContain(OLD_NOTE)
        expect(JSON.stringify(prev.data)).not.toContain(NOTE)
        expect((prev.data as { changes: unknown }).changes).toEqual({
          private_note: { changed: true }
        })
      }
      await handleRequest(ctx, update(id2, { private_note: NOTE }))
      expect(asked[2]).toBe(
        `Eintrag #${id2} ändern — vorher Di 28.10.2025 09:00–12:00, nachher Di 28.10.2025 09:00–12:00
Beschreibung: "Workshop"
` + `interne Notiz: "${OLD_NOTE}" → "${NOTE}"`
      )
      expect(JSON.stringify(audited)).not.toContain(OLD_NOTE)
      expect(JSON.stringify(audited)).not.toContain(NOTE)
      expect(audited.at(-1)).toMatchObject({ hasPrivateNote: true })
      const row = db.prepare(`SELECT private_note FROM entries WHERE id = ?`).get(latestId())
      expect(row).toEqual({ private_note: NOTE })
    })

    it('update: with private notes exposed to MCP the preview carries before and after', async () => {
      const { ctx } = recording()
      db.prepare(`UPDATE settings SET value = '1' WHERE key = 'mcp_expose_private_notes'`).run()
      const id = await seeded(ctx)
      const prev = await handleRequest(ctx, update(id, { private_note: NOTE }, true))
      if (prev.ok) {
        expect((prev.data as { changes: unknown }).changes).toEqual({
          private_note: { before: '', after: NOTE }
        })
      }
    })

    it('update: fields passed with their stored value are not listed', async () => {
      const { ctx, asked } = recording()
      const id = await seeded(ctx)
      const args = {
        client_id: 1,
        project_id: 10,
        billable: true,
        tags: '',
        reference: '',
        private_note: '',
        description: 'Workshop',
        stopped_at: '2025-10-28T13:00:00+01:00'
      }
      const prev = await handleRequest(ctx, update(id, args, true))
      if (prev.ok) {
        expect((prev.data as { changes: unknown }).changes).toEqual({
          stopped_at: { before: '2025-10-28T11:00:00.000Z', after: '2025-10-28T12:00:00.000Z' }
        })
      }
      await handleRequest(ctx, update(id, args))
      expect(asked[1]).toBe(
        `Eintrag #${id} ändern — vorher Di 28.10.2025 09:00–12:00, nachher Di 28.10.2025 09:00–13:00\nBeschreibung: "Workshop"`
      )
    })

    it('update: only the description — the line of today plus the old text', async () => {
      const { ctx, asked } = recording()
      const id = await seeded(ctx)
      await handleRequest(ctx, update(id, { description: 'Review' }))
      expect(asked[1]).toBe(
        `Eintrag #${id} ändern — vorher Di 28.10.2025 09:00–12:00, nachher Di 28.10.2025 09:00–12:00\n` +
          'Beschreibung: "Workshop" → "Review"'
      )
    })

    it('create: the dialog names client, project, billable, tags, reference and the note; the preview hides the note', async () => {
      const { ctx, asked } = recording()
      const req: BridgeRequest = {
        ...create('2025-10-28T09:00:00+01:00', '2025-10-28T12:00:00+01:00'),
        args: {
          client_id: 1,
          project_id: 10,
          billable: false,
          tags: ',bug,',
          reference: 'PO-9',
          private_note: NOTE,
          description: 'Workshop',
          started_at: '2025-10-28T09:00:00+01:00',
          stopped_at: '2025-10-28T12:00:00+01:00'
        }
      }
      const prev = await handleRequest(ctx, { ...req, preview: true })
      if (prev.ok) {
        expect(prev.data).toMatchObject({
          client_name: 'Acme',
          project_name: 'Rollout',
          billable: false,
          has_private_note: true
        })
        expect(JSON.stringify(prev.data)).not.toContain(NOTE)
      }
      await handleRequest(ctx, req)
      expect(asked[0]).toBe(
        'Eintrag nachtragen — Kunde Acme, Di 28.10.2025 09:00–12:00 (180 min)\n' +
          `Projekt: Rollout\nabrechenbar: nein\nBeschreibung: "Workshop"\nTags: bug\nReferenz: "PO-9"\ninterne Notiz: "${NOTE}"`
      )
    })
  })

  // Owner review #255: free text from the MCP client must not shape the
  // native dialog — no forged lines, no change lines pushed out of view, no
  // reversed text.
  describe('free text in the dialog is one clean line', () => {
    it('a description of 200 line breaks plus a fake line stays one line below the real field lines', async () => {
      const { ctx, asked } = recording()
      await handleRequest(ctx, create('2025-10-28T09:00:00+01:00', '2025-10-28T12:00:00+01:00'))
      const { id } = db.prepare(`SELECT id FROM entries`).get() as { id: number }
      await handleRequest(ctx, {
        v: 1,
        token: 'secret',
        op: 'update_entry_fields',
        args: { id, client_id: 2, description: '\n'.repeat(200) + 'Kunde: unverändert' }
      })
      const lines = asked[1].split('\n')
      expect(lines).toHaveLength(3)
      expect(lines[1]).toBe('Kunde: Acme → Beta')
      expect(lines[2].startsWith('Beschreibung: "Workshop" → "')).toBe(true)
      expect(lines[2]).toContain('⏎')
      expect([...lines[2]].length).toBeLessThan(300)
      expect(lines[2].endsWith('…"')).toBe(true)
    })

    it('bidi and control characters are removed from description, reference and note', async () => {
      const { ctx, asked } = recording()
      await handleRequest(ctx, {
        v: 1,
        token: 'secret',
        op: 'create_manual_entry',
        args: {
          client_id: 1,
          description: 'abc\u202Edef\u2066x\u0007',
          reference: 'R\u202D1\t2',
          private_note: 'n\u200Fote',
          started_at: '2025-10-28T09:00:00+01:00',
          stopped_at: '2025-10-28T10:00:00+01:00'
        }
      })
      // eslint-disable-next-line no-control-regex -- the test looks for control characters
      expect(asked[0]).not.toMatch(/[\u202A-\u202E\u2066-\u2069\u200E\u200F\u0007\t]/)
      expect(asked[0]).toContain('Beschreibung: "abcdefx"')
      expect(asked[0]).toContain('Referenz: "R1 2"')
      expect(asked[0]).toContain('interne Notiz: "note"')
    })

    it('line and paragraph separators count as line breaks', async () => {
      const { ctx, asked } = recording()
      await handleRequest(ctx, {
        v: 1,
        token: 'secret',
        op: 'create_manual_entry',
        args: {
          client_id: 1,
          description: 'a\u2028b\u2029c',
          started_at: '2025-10-28T09:00:00+01:00',
          stopped_at: '2025-10-28T10:00:00+01:00'
        }
      })
      expect(asked[0]).not.toMatch(/[\u2028\u2029]/)
      expect(asked[0]).toContain('Beschreibung: "a ⏎ b ⏎ c"')
    })

    it('start_timer: description cleaned, client names in the head line cleaned', async () => {
      db.prepare(`UPDATE clients SET name = ? WHERE id = 1`).run('Ac\nme\u202E')
      const { ctx, asked } = recording()
      await handleRequest(ctx, {
        v: 1,
        token: 'secret',
        op: 'start_timer',
        args: { client_id: 1, description: 'x', started_at: '2025-10-28T09:00:00+01:00' }
      })
      await handleRequest(ctx, {
        v: 1,
        token: 'secret',
        op: 'start_timer',
        args: { client_id: 2, description: 'a\nb', started_at: '2025-10-28T10:00:00+01:00' }
      })
      expect(asked[0].split('\n')[0]).toBe('Timer starten — Kunde Ac ⏎ me, ab Di 28.10.2025 09:00')
      expect(asked[1].split('\n')).toEqual([
        expect.stringMatching(/; beendet #\d+ \(Ac ⏎ me\) um 10:00$/),
        'Beschreibung: "a ⏎ b"'
      ])
    })

    it('the preview keeps the values as sent', async () => {
      const { ctx } = recording()
      await handleRequest(ctx, create('2025-10-28T09:00:00+01:00', '2025-10-28T12:00:00+01:00'))
      const { id } = db.prepare(`SELECT id FROM entries`).get() as { id: number }
      const res = await handleRequest(ctx, {
        v: 1,
        token: 'secret',
        op: 'update_entry_fields',
        args: { id, description: 'a\nb\u202E' },
        preview: true
      })
      expect(res.ok).toBe(true)
      if (res.ok) {
        expect(res.data).toMatchObject({ changes: { description: { after: 'a\nb\u202E' } } })
      }
    })
  })
})
