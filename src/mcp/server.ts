/**
 * TimeTrack MCP server — over stdio.
 *
 * READS open the local SQLite DB directly in read-only mode. WRITES never touch
 * the DB from here — they forward over a local socket to the running TimeTrack
 * app, which executes them through its own validated logic behind opt-in,
 * token, confirmation, backup and audit guards (v1.14 #127).
 *
 * Read tools:
 *   list_clients · list_projects · list_entries · get_running_timer
 *   get_dashboard · get_analytics
 * Write tools (require write mode enabled in the app; each supports preview):
 *   create_manual_entry · update_entry_fields · start_timer · stop_running_timer
 *
 * Privacy: rates and internal notes are hidden by default. Enable per-request
 * either in the app (Einstellungen → Integrationen) or via env override:
 *   TIMETRACK_MCP_EXPOSE_RATES=1 / TIMETRACK_MCP_EXPOSE_PRIVATE_NOTES=1
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { openReadonly } from './db'
import { resolveDbPath } from './dbPath'
import { resolvePrivacy, type PrivacyConfig } from './privacy'
import {
  listClients,
  listProjects,
  listEntries,
  getRunningTimer,
  getDashboard,
  getAnalytics,
  readStoredPrivacy,
  type SqliteDb
} from './queries'
import { sendWrite } from './writeClient'
import { userDataDir } from './socketPath'
import {
  pendingShutdownRequest,
  pruneDeadHolders,
  registerHolder,
  unregisterHolder,
  watchForShutdown
} from './holders'

/**
 * Open the DB fresh per call and close it afterwards. TimeTrack uses WAL, so a
 * read-only connection never blocks the app's writer, and reopening guarantees
 * every tool call sees the latest committed state — including privacy flags
 * just toggled in Einstellungen → Integrationen.
 *
 * The callback receives the effective PrivacyConfig, resolved per call from the
 * stored app settings merged with any env-var overrides.
 */
function withDb<T>(fn: (db: SqliteDb, privacy: PrivacyConfig) => T): T {
  const { db } = openReadonly()
  try {
    const privacy = resolvePrivacy(readStoredPrivacy(db))
    return fn(db, privacy)
  } finally {
    db.close()
  }
}

/** Standard JSON tool result. Data is serialised for the model to read. */
function jsonResult(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
}

function errorResult(e: unknown): {
  content: Array<{ type: 'text'; text: string }>
  isError: true
} {
  return { content: [{ type: 'text', text: `Fehler: ${String(e)}` }], isError: true }
}

export function buildServer(): McpServer {
  const server = new McpServer(
    { name: 'timetrack', version: '0.1.0' },
    {
      instructions:
        'Zugriff auf die lokale TimeTrack-Zeiterfassung. Lesen: list_entries/get_analytics ' +
        'für Auswertungen (Stunden pro Kunde/Projekt), get_dashboard für Tag/Woche. ' +
        'Schreiben (create_manual_entry, update_entry_fields, start_timer, stop_running_timer) ' +
        'erfordert aktivierten Schreibzugriff in der App und kann eine Bestätigung auslösen — ' +
        'rufe Write-Tools bevorzugt zuerst mit preview:true auf. Stundensätze und interne ' +
        'Notizen sind standardmäßig ausgeblendet.'
    }
  )

  server.registerTool(
    'list_clients',
    {
      title: 'Kunden auflisten',
      description:
        'Alle Kunden (Name, Farbe, USt-ID, Ansprechpartner). Standardmäßig nur aktive; ' +
        'include_archived=true zeigt auch archivierte. Für gezielte Lookups nach name oder ' +
        'contact_person filtern (Teilstring, Groß-/Kleinschreibung egal). ' +
        'Stundensätze nur, wenn freigeschaltet.',
      inputSchema: {
        include_archived: z.boolean().optional().describe('Auch archivierte Kunden einschließen'),
        name: z.string().optional().describe('Nach Namen filtern (Teilstring)'),
        contact_person: z.string().optional().describe('Nach Ansprechpartner filtern (Teilstring)')
      }
    },
    async ({ include_archived, name, contact_person }) => {
      try {
        const clients = withDb((db, privacy) =>
          listClients(db, privacy, {
            includeArchived: include_archived,
            name,
            contactPerson: contact_person
          })
        )
        return jsonResult({ count: clients.length, clients })
      } catch (e) {
        return errorResult(e)
      }
    }
  )

  server.registerTool(
    'list_projects',
    {
      title: 'Projekte auflisten',
      description:
        'Projekte inkl. Status, Budget, verbrauchten Minuten und Eintragszahl. ' +
        'Optional nach Kunde gefiltert (client_id, oder null für Projekte ohne Kunde). ' +
        'Für gezielte Lookups nach name oder external_project_number filtern ' +
        '(Teilstring, Groß-/Kleinschreibung egal).',
      inputSchema: {
        client_id: z
          .number()
          .int()
          .nullable()
          .optional()
          .describe('Nach Kunde filtern; null = Projekte ohne Kunde'),
        include_archived: z.boolean().optional().describe('Auch archivierte Projekte einschließen'),
        name: z.string().optional().describe('Nach Projektnamen filtern (Teilstring)'),
        external_project_number: z
          .string()
          .optional()
          .describe('Nach externer Projektnummer filtern (Teilstring)')
      }
    },
    async ({ client_id, include_archived, name, external_project_number }) => {
      try {
        const projects = withDb((db, privacy) =>
          listProjects(db, privacy, {
            clientId: client_id === undefined ? undefined : client_id,
            includeArchived: include_archived,
            name,
            externalProjectNumber: external_project_number
          })
        )
        return jsonResult({ count: projects.length, projects })
      } catch (e) {
        return errorResult(e)
      }
    }
  )

  server.registerTool(
    'list_entries',
    {
      title: 'Zeiteinträge auflisten',
      description:
        'Zeiteinträge in einem Zeitraum — entweder per year+month oder per from/to ' +
        '(ISO-Zeitstempel, from inklusive, to exklusiv). Zusätzliche Filter: client_id, ' +
        'project_id, tag. count und total_seconds decken immer ALLE Treffer ab, auch wenn ' +
        'entries durch limit gekürzt ist; summary_only=true liefert nur count + total_seconds. ' +
        'total_seconds ist die UNGERUNDETE Ist-Summe (laufende Einträge bis jetzt) — für ' +
        'gerundete Abrechnungszahlen (PDF-Logik) get_analytics verwenden.',
      inputSchema: {
        year: z.number().int().optional().describe('Jahr (mit month kombinieren)'),
        month: z.number().int().min(1).max(12).optional().describe('Monat 1–12 (mit year)'),
        from: z.string().optional().describe('Start ISO-Zeitstempel (inklusive)'),
        to: z.string().optional().describe('Ende ISO-Zeitstempel (exklusiv)'),
        client_id: z.number().int().optional().describe('Nach Kunde filtern'),
        project_id: z.number().int().optional().describe('Nach Projekt filtern'),
        tag: z.string().optional().describe('Nach exaktem Tag filtern'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(10000)
          .optional()
          .describe('Max. Anzahl zurückgegebener entries (Default 1000)'),
        summary_only: z.boolean().optional().describe('Nur count + total_seconds, keine entries')
      }
    },
    async (args) => {
      try {
        const result = withDb((db, privacy) =>
          listEntries(
            db,
            privacy,
            {
              year: args.year,
              month: args.month,
              from: args.from,
              to: args.to,
              clientId: args.client_id,
              projectId: args.project_id,
              tag: args.tag,
              limit: args.limit,
              summaryOnly: args.summary_only
            },
            Date.now()
          )
        )
        return jsonResult(result)
      } catch (e) {
        return errorResult(e)
      }
    }
  )

  server.registerTool(
    'get_running_timer',
    {
      title: 'Laufenden Timer abfragen',
      description: 'Gibt den aktuell laufenden Eintrag zurück, oder null wenn kein Timer läuft.',
      inputSchema: {}
    },
    async () => {
      try {
        const entry = withDb((db, privacy) => getRunningTimer(db, privacy, Date.now()))
        return jsonResult({ running: entry !== null, entry })
      } catch (e) {
        return errorResult(e)
      }
    }
  )

  server.registerTool(
    'get_dashboard',
    {
      title: 'Dashboard-Übersicht',
      description:
        'Heutige und wöchentliche Gesamtdauer (Sekunden), die letzten 5 Einträge und die ' +
        'Top-Kunden der letzten 30 Tage — analog zur Heute-Ansicht der App.',
      inputSchema: {}
    },
    async () => {
      try {
        const dash = withDb((db, privacy) => getDashboard(db, privacy, Date.now()))
        return jsonResult(dash)
      } catch (e) {
        return errorResult(e)
      }
    }
  )

  server.registerTool(
    'get_analytics',
    {
      title: 'Monatsauswertung',
      description:
        'Monatliche Auswertung: Gesamt-/abrechenbare Sekunden, distinct_client_count sowie ' +
        'Aufschlüsselung by_client und by_project (je mit client_id, sortiert nach seconds ' +
        'absteigend). Sekundenwerte sind pro Eintrag auf das App-Rundungsintervall gerundet ' +
        '(Response-Feld rounding_minutes, 0 = ungerundet) und damit die KANONISCHEN Zahlen für ' +
        'Abrechnung/PDF — sie können von der ungerundeten Summe aus list_entries abweichen. ' +
        'Umsätze nur, wenn Stundensätze freigeschaltet sind.',
      inputSchema: {
        year: z.number().int().describe('Jahr, z. B. 2026'),
        month: z.number().int().min(1).max(12).describe('Monat 1–12')
      }
    },
    async ({ year, month }) => {
      try {
        const analytics = withDb((db, privacy) => getAnalytics(db, privacy, year, month))
        return jsonResult(analytics)
      } catch (e) {
        return errorResult(e)
      }
    }
  )

  // ── Write tools (v1.14 #127) ────────────────────────────────────────────
  // These forward to the running TimeTrack app over a local socket; they do
  // NOT touch the DB directly. They require the write bridge to be enabled in
  // the app (Einstellungen → Integrationen) and may trigger an in-app
  // confirmation. Every tool supports `preview: true` to see the planned
  // change without committing.
  const WRITE_HINT =
    'Erfordert aktivierten Schreibzugriff (Einstellungen → Integrationen); je nach Einstellung ' +
    'erscheint eine Bestätigung in TimeTrack. preview:true zeigt die geplante Änderung ohne Commit.'

  async function runWrite(
    op: string,
    args: Record<string, unknown>,
    preview: boolean | undefined
  ): Promise<ReturnType<typeof jsonResult>> {
    const r = await sendWrite(op, args, preview === true)
    return r.ok ? jsonResult(r.data ?? { ok: true }) : errorResult(r.error ?? 'Unbekannter Fehler')
  }

  server.registerTool(
    'create_manual_entry',
    {
      title: 'Eintrag nachtragen',
      description: `Legt einen abgeschlossenen Zeiteintrag an (Start + Ende). ${WRITE_HINT}`,
      inputSchema: {
        client_id: z.number().int().describe('Kunden-ID'),
        description: z.string().describe('Tätigkeitsbeschreibung. Max. 500 Zeichen.'),
        started_at: z.string().describe('Startzeit als ISO-Zeitstempel'),
        stopped_at: z
          .string()
          .describe('Endzeit als ISO-Zeitstempel. Max. 24 Stunden nach der Startzeit.'),
        tags: z.string().optional().describe("Serialisierte Tags, z. B. ',bug,ux,'"),
        reference: z.string().optional().describe('Ticket/Referenz. Max. 200 Zeichen.'),
        billable: z.boolean().optional().describe('Abrechenbar (Default true)'),
        private_note: z
          .string()
          .optional()
          .describe('Interne Notiz (nie exportiert). Max. 1000 Zeichen.'),
        project_id: z.number().int().nullable().optional().describe('Projekt-ID oder null'),
        preview: z.boolean().optional().describe('Nur Vorschau, kein Commit')
      }
    },
    async (a) =>
      runWrite(
        'create_manual_entry',
        {
          client_id: a.client_id,
          description: a.description,
          started_at: a.started_at,
          stopped_at: a.stopped_at,
          tags: a.tags,
          reference: a.reference,
          billable: a.billable,
          private_note: a.private_note,
          project_id: a.project_id
        },
        a.preview
      )
  )

  server.registerTool(
    'update_entry_fields',
    {
      title: 'Eintrag bearbeiten',
      description: `Ändert Felder eines bestehenden Eintrags (nur angegebene Felder). Laufende Timer sind ausgenommen. ${WRITE_HINT}`,
      inputSchema: {
        id: z.number().int().describe('ID des Eintrags'),
        client_id: z.number().int().optional().describe('Neuer Kunde'),
        description: z.string().optional().describe('Neue Beschreibung. Max. 500 Zeichen.'),
        started_at: z.string().optional().describe('Neue Startzeit (ISO)'),
        stopped_at: z
          .string()
          .optional()
          .describe('Neue Endzeit (ISO). Max. 24 Stunden nach der Startzeit.'),
        tags: z.string().optional().describe("Neue Tags, z. B. ',bug,'"),
        reference: z.string().optional().describe('Neue Referenz. Max. 200 Zeichen.'),
        billable: z.boolean().optional().describe('Abrechenbar'),
        private_note: z.string().optional().describe('Interne Notiz. Max. 1000 Zeichen.'),
        project_id: z.number().int().nullable().optional().describe('Projekt-ID oder null'),
        preview: z.boolean().optional().describe('Nur Vorschau, kein Commit')
      }
    },
    async (a) =>
      runWrite(
        'update_entry_fields',
        {
          id: a.id,
          client_id: a.client_id,
          description: a.description,
          started_at: a.started_at,
          stopped_at: a.stopped_at,
          tags: a.tags,
          reference: a.reference,
          billable: a.billable,
          private_note: a.private_note,
          project_id: a.project_id
        },
        a.preview
      )
  )

  server.registerTool(
    'start_timer',
    {
      title: 'Timer starten',
      description: `Startet einen laufenden Timer für einen Kunden (stoppt einen ggf. laufenden). ${WRITE_HINT}`,
      inputSchema: {
        client_id: z.number().int().describe('Kunden-ID'),
        description: z.string().optional().describe('Beschreibung'),
        started_at: z.string().optional().describe('Startzeit (ISO); Default jetzt'),
        project_id: z.number().int().nullable().optional().describe('Projekt-ID oder null'),
        preview: z.boolean().optional().describe('Nur Vorschau, kein Commit')
      }
    },
    async (a) =>
      runWrite(
        'start_timer',
        {
          client_id: a.client_id,
          description: a.description,
          started_at: a.started_at,
          project_id: a.project_id
        },
        a.preview
      )
  )

  server.registerTool(
    'stop_running_timer',
    {
      title: 'Laufenden Timer stoppen',
      description: `Stoppt den aktuell laufenden Timer (falls einer läuft). ${WRITE_HINT}`,
      inputSchema: {
        preview: z.boolean().optional().describe('Nur Vorschau, kein Commit')
      }
    },
    async (a) => runWrite('stop_running_timer', {}, a.preview)
  )

  return server
}

/**
 * Register as a holder of the app binary and exit cleanly when the app asks
 * (#198). This process runs the *installed* binary in Node mode, so as long as
 * it lives the Windows installer cannot replace `TimeTrack.exe` — and the app
 * cannot simply close us, because our lifecycle belongs to the MCP client.
 * See src/mcp/holders.ts for why this is a file handshake and not the bridge.
 */
function joinUpdateHandshake(server: McpServer): void {
  let dir: string
  try {
    dir = userDataDir()
  } catch {
    return // no resolvable userData — nothing to coordinate with
  }
  // #201 — a request already on disk was aimed at servers that existed before
  // us; its nonce is our baseline and we exit only when the nonce CHANGES.
  // This replaces the old wall-clock gate (requestedAt >= startedAt), which
  // depended on the machine clock not stepping between server start and update.
  const baselineNonce = pendingShutdownRequest(dir)?.nonce ?? null
  // #209 — clear out predecessors that were killed rather than asked to exit
  // before adding ourselves. A server start is the moment those are most
  // likely to be present (an AI client restarting its servers is exactly how
  // they are produced), and it happens far more often than an update, which
  // used to be the only thing that pruned.
  pruneDeadHolders(dir)
  registerHolder(dir, {
    pid: process.pid,
    exe: process.execPath,
    entry: process.argv[1] ?? '',
    startedAt: Date.now()
  })

  const stopWatch = watchForShutdown(dir, baselineNonce, () => {
    process.stderr.write('[timetrack-mcp] TimeTrack installiert ein Update — Server wird beendet\n')
    // If close() never settles (wedged transport), exit anyway — the update
    // is waiting on this process, and staying alive means blocking it.
    const forceExit = setTimeout(() => {
      unregisterHolder(dir, process.pid)
      process.exit(0)
    }, 2000)
    forceExit.unref?.()
    void Promise.resolve(server.close())
      .catch(() => undefined)
      .finally(() => {
        unregisterHolder(dir, process.pid)
        process.exit(0)
      })
  })

  // Synchronous on purpose: 'exit' handlers cannot await.
  process.on('exit', () => {
    stopWatch()
    unregisterHolder(dir, process.pid)
  })
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => process.exit(0))
  }
}

async function main(): Promise<void> {
  // Fail fast with a clear message if the DB is missing, before wiring stdio.
  const dbPath = resolveDbPath()
  const server = buildServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  joinUpdateHandshake(server)
  // stderr is safe for logs; stdout is the MCP protocol channel.
  process.stderr.write(`[timetrack-mcp] read-only server bereit (DB: ${dbPath})\n`)
}

// Run only when executed directly (not when imported by tests).
const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] !== undefined &&
  /mcp[/\\]server(\.[cm]?[jt]s)?$/.test(process.argv[1])

if (isMain) {
  main().catch((e) => {
    process.stderr.write(`[timetrack-mcp] Fatal: ${String(e)}\n`)
    process.exit(1)
  })
}
