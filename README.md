# TimeTrack

A desktop time tracker for freelancers and consultants — Windows and macOS, a
local SQLite database, invoices-ready PDF timesheets, and integrations for
Microsoft 365 calendars, AI clients (MCP), webhooks and hardware keys. No
account, no server, no telemetry.

The interface is built like a measuring instrument: a dark readout window for
the running timer, hard keys, scales with ticks, in two themes (**Papier**,
**Graphit**) plus "System". The design rules are in [DESIGN.md](DESIGN.md).

## Platforms

| Platform | Build | Notes |
| -------- | ----- | ----- |
| Windows 10/11 (x64) | NSIS installer | not code-signed — SmartScreen warns on first run |
| macOS (Apple silicon) | DMG / ZIP (arm64) | signed ad hoc, not notarized — macOS 15 and later: System Settings → Privacy & Security → Open Anyway; older versions: right-click → Open; Intel Macs: no build yet ([#168](https://github.com/wald-it/time-tracking/issues/168)) |

Every release lists SHA-256 checksums and carries a build provenance
attestation; see [SECURITY.md](SECURITY.md#release-integrity) for how to check a
download. Download: [latest release](https://github.com/wald-it/time-tracking/releases/latest).

## Features

**Tracking**
- **Heute** — the running timer in a readout window, a day scale with a needle at *now*, today's entries, worked time today and this week (the rounded time as a sub-line).
- **Preset keys** — up to three keys under the timer for the clients you used most in the last 30 days. A click starts the client's last project; while a timer runs, it **switches**: the running entry stops at exactly the moment the new one starts. A long press, right-click or the ▾ segment opens the client's project list.
- **Quick note after stop** — an entry stopped without a description asks for one (30 s), keeping all of the entry's other fields.
- **Global hotkey** (`Alt+Shift+S`, configurable), **tray menu** with active clients, **mini widget** (always-on-top overlay, `Alt+Shift+M`).
- **Idle detection** — after the idle threshold: keep, stop at the idle moment, or mark as break.
- **Cross-midnight split** — entries over midnight become two linked halves, correct on the days the clocks change.

**Calendar, analysis, export**
- **Kalender** — month grid with day scales, week and month sums and each day's billable revenue; a day panel beside the month on wide windows (a drawer on narrow ones) with inline edit, backfill and delete with undo.
- **Auswertung** — worked hours per month, client and weekday, revenue, and a two-band trend; the running month is compared with the same days of the previous month.
- **PDF timesheet** (A4, logo, sender, accent colour, rounding step, optional fee and signature lines), **PDF merge** onto an existing invoice PDF, **CSV** (DE/US format), **iCal** export and a **JSON** export of your data (without stored secrets — for reading and checking, not for restoring).
- **Clients and projects** with colours, hourly rates (project rate overrides the client rate), budgets, contact data and archive; **tags** with a central tag manager.

**Integrations** (all off until you set them up)
- **Microsoft 365 calendar import** — take appointments over as entries; the client is suggested from the attendees' e-mail domains.
- **MCP server** for AI clients such as Claude — read your entries, and (opt-in) create or edit them with a confirmation dialog in the app. See [MCP Integration](#mcp-integration).
- **Webhooks** — HTTP calls on timer start/stop and entry changes, signed (HMAC) when the target has a secret.
- **iCal feed** — a local `webcal://` feed of the last 90 days for your calendar app.
- **Stream Deck plugin** — one key per client/project, live timer state on the key; see [streamdeck-plugin/README.md](streamdeck-plugin/README.md).

**Safety of your data**
- Local SQLite database, daily backups (7 kept), a backup before every database update, manual backup and restore under **Settings → Data**.
- Versioned migrations; the app does not continue on a partially migrated database.
- Crash-safe timer (heartbeat), German and English UI, switchable live.

What is planned lives in [ROADMAP.md](ROADMAP.md), what was deferred with a reason in [TODOS.md](TODOS.md); open issues: [github.com/wald-it/time-tracking/issues](https://github.com/wald-it/time-tracking/issues).

## Tech Stack

| Layer    | Library                 |
| -------- | ----------------------- |
| Shell    | Electron 39 (move to 44 planned) |
| Build    | electron-vite 5         |
| UI       | React 19 + TypeScript 5 |
| Styling  | Tailwind CSS 4          |
| State    | Zustand 5               |
| Database | better-sqlite3 12       |
| Dates    | date-fns 4              |

## Development

**Requirements:** Node.js 22, pnpm 10 (the versions CI uses). Details: [CONTRIBUTING.md](CONTRIBUTING.md).

```bash
# Install dependencies
pnpm install

# Start dev server with hot reload
pnpm dev

# Type check
pnpm typecheck

# Run tests
pnpm test

# Build the Windows installer (macOS: pnpm build:mac)
pnpm build:win
```

> **Why `pnpm test` and not `vitest`:** the tests run in the runtime the app
> ships. `pnpm test` starts Vitest via `scripts/run-vitest.mjs` on the Electron
> binary in Node mode (`ELECTRON_RUN_AS_NODE=1`), so the suite runs on
> Electron's own Node, not on whichever Node is installed — the same launch
> path as the MCP server, see below.
>
> Calling `pnpm exec vitest run` **directly** fails on purpose, with a hint
> pointing to `pnpm test` (`vitest.config.ts` refuses to load outside Electron).
> `better-sqlite3` is an N-API module with prebuilt binaries since
> [#269](https://github.com/wald-it/time-tracking/issues/269), so there is no
> native rebuild step anywhere — neither on install nor before the tests.

## MCP Integration

TimeTrack ships an **[MCP](https://modelcontextprotocol.io) server** so that
tools like **Claude Code** can use your local time tracking — e.g. "sum up my
hours for client X in June by project" or "log the meeting I forgot".

**Read tools** (the server opens the SQLite DB **strictly read-only**): `list_clients`
(filter by name/contact person), `list_projects` (filter by client, name, external
project number), `list_entries` (month or date range, filter by client/project/tag,
summary-only mode), `get_running_timer`, `get_dashboard`, `get_analytics` (monthly
worked time to the second, plus `rounded_seconds` / `billable_rounded_seconds`
rounded per entry like the invoice; revenue optional).

**Write tools** (opt-in, see below): `create_manual_entry`, `update_entry_fields`,
`start_timer`, `stop_running_timer` — each with `preview: true` for a preview without a commit.

**Times in write tools need a zone.** `started_at` and `stopped_at` must be an ISO
timestamp with date, time of day and zone — an offset or `Z`, e.g.
`2026-10-22T09:00:00+02:00` or `2026-10-22T07:00:00Z`. A value without a zone, a bare
date or an impossible date (`2026-02-30`) is refused, in preview mode as well; the error
names the field and gives an example in the computer's current offset. Without a zone
the moment would be ambiguous: the app reads such a value as local time, `list_entries`
reads its `from`/`to` as UTC. Accepted times are stored in UTC.
The tool descriptions name the computer's time zone; the offset has to fit the date
(summer or winter time). A preview returns the times in UTC and as `started_local` /
`stopped_local`, and an offset that does not match the local time on that day is accepted
with a note (`zeit_hinweise`) — in the preview and in the confirmation dialog.

**The server is included in the installed app** — no checkout, no build, and no
separately installed Node required.

**Register in Claude Code:** Copy the ready-made block under **Settings → Integrations**
(the paths are already filled in for your installation) and add it to the project's
`.mcp.json` or to `~/.claude.json`. It looks like this:

```json
{
  "mcpServers": {
    "timetrack": {
      "command": "C:/Program Files/TimeTrack/TimeTrack.exe",
      "args": ["C:/Program Files/TimeTrack/resources/app.asar/out/mcp/mcp/server.js"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

> **Why the app starts itself:** the server is a Node program, and TimeTrack
> does not assume a Node installation on your machine. `ELECTRON_RUN_AS_NODE=1`
> runs the app's own Electron binary as plain Node, which loads the bundled
> `better-sqlite3` from the installation.

> **Updates while MCP servers are running (#198):** Because each server runs the
> installed binary, it holds `TimeTrack.exe` open — which would block the Windows
> installer. Servers therefore register under `<userData>/mcp-holders/` and exit
> on their own when an update is about to install; the AI client sees a clean
> shutdown, not a crash, and simply restarts the server afterwards. If a server
> does not react, the **in-app updater** refuses to install and names the
> blocking processes — close the AI client and retry. A **manually started
> installer** writes the same shutdown request and waits briefly for the servers
> to exit, then falls back to the standard app-running check.

**From the checkout (development):**

```bash
pnpm build:mcp   # compiles to out/mcp/mcp/server.js
pnpm mcp         # starts the server via the Electron binary in Node mode
```

`pnpm build` pulls in `build:mcp` automatically, so the server lands in every package build.
To register a dev checkout, use the same setup with
`node_modules/electron/dist/electron.exe` as `command` — which is exactly what
**Settings → Integrations** shows when the app runs from the checkout.

The DB path is resolved cross-platform (Windows `%APPDATA%\time-tracking\`,
macOS `~/Library/Application Support/time-tracking/`, Linux `~/.config/time-tracking/`) and
can be overridden via `TIMETRACK_DB_PATH`. The directory is called `time-tracking`
(package.json → `name`), not `TimeTrack` — the `productName` from `electron-builder.yml`
only names the installed app, not `app.getPath('userData')`.

**Privacy:** Hourly rates/revenue and internal notes (`private_note`) are **hidden by
default**. Enable them either in the app under **Settings → Integrations** (the toggles
are read fresh from the DB on every request) or via an environment variable as an override:

- `TIMETRACK_MCP_EXPOSE_RATES=1` — show hourly rates and revenue
- `TIMETRACK_MCP_EXPOSE_PRIVATE_NOTES=1` — show internal notes

The **Settings → Integrations** submenu also shows the DB path and the copyable
`.mcp.json` registration.

**Write access (opt-in, off by default).** Enable under **Settings →
Integrations → Write access**. Security model:

- The MCP server **never** writes to the DB directly. Write tools send over a local
  **named pipe / Unix socket** to the **running app**, which performs the change through its own
  validated logic (overlap check, cross-midnight split, etc.). If the app is closed, or
  writing is off, the tools respond with a clear error message.
- **Token:** On enabling, the app generates a random token (`<userData>/mcp-write.token`,
  mode `0600`) that rotates per app start; every write request must carry it.
- **Confirmation** per write action is selectable: ask on every change (default), once per
  session, or never ask. The dialog names every field a write changes, before → after
  (client, project, billable, tags, reference, internal note, description; times in
  local time); `start_timer` names the running entry it ends.
- **Pre-write backup** once per session before the first change; every executed action lands
  in the append-only **audit log** `mcp-writes.log` (token/internal notes are never logged).

Recommendation: call write tools with `preview: true` first, then commit.

> **Note on `TIMETRACK_DB_PATH`:** Socket and token live **next to the DB** of the
> running app. `TIMETRACK_DB_PATH` (the read override) must therefore point to the **real DB
> of the running app** — otherwise the server reads from one DB while the write
> bridge addresses the app at its own location. Without an override, the default path
> applies on both sides; only in dev mode (a differing `userData`) is the
> override needed.

## Releases

Releases are built by `.github/workflows/release.yml` from a `v*` tag (or a manual
run started from that tag). The workflow builds exactly the tagged commit, runs the
tests, packages the Windows installer, the macOS DMG/ZIP (arm64) and the Stream Deck
plugin, checks the package contents, smoke-tests the packaged app against its
database and PDF pipeline, attests build provenance and publishes the GitHub Release
with SHA-256 checksums in the notes. Releases are not code-signed (see
[SECURITY.md](SECURITY.md#release-integrity)).

- Download: [github.com/wald-it/time-tracking/releases/latest](https://github.com/wald-it/time-tracking/releases/latest)
- Planning: [ROADMAP.md](ROADMAP.md) and the [open issues](https://github.com/wald-it/time-tracking/issues). Issues carry a type label (`bug`, `enhancement`) and no version label — see [CONTRIBUTING.md](CONTRIBUTING.md#how-issues-are-tracked).

The release steps for maintainers are in [CONTRIBUTING.md](CONTRIBUTING.md#release-process-maintainers-only).

## Project Structure

```
src/
  main/          # Electron main process
    index.ts     # App entry, tray (with Quick-Start), global hotkey, smoke-test mode
    db.ts        # SQLite open + WAL setup
    ipc.ts       # All IPC handlers (clients, projects, entries, settings, dashboard, exports)
    idle.ts      # powerMonitor-based idle watcher
    backup.ts    # Daily/manual/pre-migration backups + restore
    pdf.ts       # PDF payload builder + HTML template (Stundennachweis)
    pdfWindow.ts # Hidden BrowserWindow renderer (printToPDF pipeline)
    pdfMerge.ts  # PDF merge logic (mergePdfs via pdf-lib)
    jsonExport.ts# JSON export of your data (without stored secrets; for reading, not restoring)
    logo.ts      # Logo file -> base64 data URL for PDF embedding
    updater.ts   # electron-updater bridge + IPC handlers (auto-update)
    csvExport.ts # CSV export builder
    migrations/  # Versioned schema migrations + runner (001..027)
  mcp/           # Bundled MCP server (started by the AI client, see "MCP Integration")
    server.ts    # Entry point: tool definitions, stdio transport, update handshake
    holders.ts   # Holder registry + cooperative shutdown before updates (#198)
    queries.ts   # Pure read-only query layer behind the read tools
    privacy.ts   # Privacy gates (rates / private notes hidden by default)
    writeClient.ts # Sends write tools over the local bridge to the running app
    db.ts        # Read-only SQLite open; dbPath.ts / socketPath.ts resolve shared paths
  preload/
    index.ts     # Context Bridge (window.api)
    index.d.ts   # TypeScript types for renderer
  renderer/src/
    views/       # TodayView, CalendarView, AuswertungView, ClientsView, ExportView, SettingsView, TagManagementView
    components/  # Dialog, IdleModal, CalendarDrawer, EntryEditForm, Toast,
                 # ConfirmDialog, ProjectFormModal, PdfMergeModal, UpdateBanner, OnboardingWizard, AboutDialog, ExportModal
    contexts/    # I18nContext (DE/EN translations, useT hook)
    hooks/       # useTimer logic hook
    store/       # Zustand stores (timer, entries, projects, clients, toast, updateStore)
  shared/
    types.ts     # Shared TypeScript interfaces
    duration.ts  # Time-formatting helpers
    currency.ts  # Cent-based money + minute rounding (ceil)
    date.ts      # Local-day helpers
    dateRanges.ts# Quick-filter range calculation (DST-safe)
    midnightSplit.ts # Cross-midnight entry split logic
    rate.ts      # German decimal <-> integer cent parsing
    locales/     # de.ts + en.ts locale files (type-safe via TranslationKey)
scripts/
  generate-icons.mjs    # SVG -> tray PNGs (running/stopped, @1x/@2x)
  sync-icon.mjs         # resources/icon.png -> build/icon.png + multi-res .ico (prebuild hook)
  generate-licenses.mjs # Scans production deps, writes resources/licenses.json (prebuild hook)
resources/
  licenses.json  # Generated license list (updated on pnpm build)
templates/
```

## Data Storage

All data lives in the app data folder `time-tracking` — `%APPDATA%\time-tracking\` on
Windows, `~/Library/Application Support/time-tracking/` on macOS: the database
`timetrack.sqlite`, `backups\` and (Windows) `logs\`. The folder is named after
`package.json`, not after the product name. The schema is versioned (27 migrations as
of 1.22); main tables:

- `clients` — name, colour, active flag, hourly rate, billing and contact data
- `projects` — client, name, colour, status, rate override, budget, external number
- `entries` — client, project, description, start, stop, heartbeat, tags, reference, billable flag, internal note, soft delete, cross-midnight link
- `settings` — key/value store

On start the app stops entries whose heartbeat is older than five minutes (crash recovery).

## Security

- Renderer with `contextIsolation`, no Node integration, a strict Content Security Policy; all database access in the main process.
- Links leave the app only as `http(s)` links; app windows never navigate away from the app.
- Local interfaces (MCP write bridge, hardware keys, iCal feed) are off by default and protected by random tokens.
- Releases are not code-signed; checksums and build provenance are published. The current Electron line (39) is out of support; the move to 44 follows after 1.22.
- Reporting a vulnerability and the full scope: [SECURITY.md](SECURITY.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for dev setup, branch naming, and PR guidelines.

## Privacy

All data stays local. In basic operation the only network request is the update
check against GitHub, which you can turn off under Settings → About → Updates;
the integrations (Microsoft 365, MCP, webhooks, iCal feed, Stream Deck) send
data only when you switch them on. No telemetry, no account.
Details: [PRIVACY.md](PRIVACY.md).

## License

[MIT](LICENSE) © 2026 Robin Wald

The bundled third-party packages keep their own licenses; the full list is
generated by `scripts/generate-licenses.mjs` into `resources/licenses.json`
and shown in **Settings → About → Licenses**.
