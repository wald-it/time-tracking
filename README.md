# TimeTrack

A personal Windows desktop time-tracking app for freelancers. Lightweight Toggl alternative with a local SQLite database, calendar view, and PDF timesheet export.

## Features

- **Today View** — Default tab with the active timer as a pill, daily/weekly total, top-3 client quick-start, and last 5 entries.
- **Timer** — Start/stop with client selection and description. Crash-safe via heartbeat.
- **Calendar Mode** — 7×N monthly grid with calendar-week column, daily total, color-coded mini-bars per client, and day-drawer with inline edit.
- **Quick-Filter + 1-Click PDF** — "This week / Last week / This month / Last month" plus hero button "📄 Last month as PDF".
- **PDF Timesheet** — Printable A4 PDF with date / from / to / activity / duration (optionally with fee). Configurable in **Settings → PDF Template**: logo, sender address, tax number, accent color, footer, hour rounding, optional signature fields.
- **PDF Merge — Attach to Invoice** — Attach the timesheet directly to an existing Lexware / sevDesk / Billomat invoice PDF. Enable the checkbox in the export modal, pick your invoice, done. No Smallpdf, no Acrobat. Output: `<invoice-name>_inkl_Stundennachweis.pdf` next to the original file. The original is never modified.
- **Hourly Rate per Client** — Optional fee field, renders as a €-column in the PDF.
- **Full JSON Export** — Clients + entries + settings as a readable JSON file (data portability).
- **Cross-Midnight Auto-Split** — Entries spanning midnight are automatically split into two linked half-day entries — DST-safe.
- **Client & Project Management** — Create, edit, archive, and delete clients (color code + hourly rate). Each client can have any number of **projects** with their own color and an optional hourly-rate override. Timer, Today View, Calendar, and entry editing all show the project name; export (PDF + CSV) can be filtered by project.
- **Global Hotkey** — `Alt+Shift+S` (configurable) starts/stops the timer from any tab.
- **Tray Icon + Quick-Start** — Right-click the tray to open active clients as direct buttons. Tray glyph changes with timer state.
- **Mini Widget** — Always-on-top 200×40 overlay (hotkey `Alt+Shift+M`, configurable). Shows running timer + client + stop/start buttons — no main window needed. Draggable, visible over fullscreen apps.
- **Tags per Entry** — Color chips per time block. Filter in the calendar drawer by tag click. PDF export groupable by tag.
- **Quick Note after Stop** — Description field left empty? A 30 s "What was that?" modal appears after stopping. Enter saves, Escape skips.
- **Idle Detection** — PC idle beyond the threshold? A modal asks: keep, stop, or mark as break.
- **Auto-Backup** — Rolling 7-day SQLite snapshots under `%AppData%\TimeTrack\backups\`. Manual backup + restore from Settings.
- **DB Migrations** — Versioned schema with pre-migration backup, so updates never lose data.
- **Auto-Update** — `electron-updater` checks for new GitHub releases on startup. UpdateBanner appears when updates are available; manual check + install button in Settings → Updates.
- **Crash Logging** — `electron-log` writes rotating logs to `%AppData%\TimeTrack\logs\`. Catch-all for main- and renderer-process errors. Log file can be opened directly from Settings → Diagnostics.
- **Onboarding Wizard** — 3-step assistant on first start: choose language → create first client → hotkey hint. Shown once; existing users keep the flag automatically.
- **CSV Export** — Unified ExportModal with client/date-range filter. Output: flat CSV file with all entries (DATEV-compatible format).
- **i18n DE/EN** — Full translation via type-safe locale files. Language switchable in Settings → General (applies live, no restart needed).
- **License Notices** — About dialog under Settings → About. Shows the MIT license of TimeTrack + an expandable list of all 95 bundled third-party packages with SPDX identifier and license text.
- **Auto-Update Releases** — Pushing a `v*` tag builds the Windows installer and publishes a GitHub Release automatically (with a packaged smoke test against the DB **and** the PDF pipeline).
- **Local SQLite** — All data stays on your machine under `%AppData%\TimeTrack\`.

### Coming soon

- **Outlook Integration** (v2.0) — Read-only import via Microsoft Graph
  (Device Code Flow, no server, Office E1 + personal accounts).
- Pomodoro mode (#23) — conditionally deferred to v1.8 based on user demand.

Full roadmap: [ROADMAP.md](ROADMAP.md) · Issues: [github.com/wald-it/time-tracking/issues](https://github.com/wald-it/time-tracking/issues)

## Tech Stack

| Layer    | Library                 |
| -------- | ----------------------- |
| Shell    | Electron 39             |
| Build    | electron-vite 5         |
| UI       | React 19 + TypeScript 5 |
| Styling  | Tailwind CSS 4          |
| State    | Zustand 5               |
| Database | better-sqlite3 12       |
| Dates    | date-fns 4              |

## Development

**Requirements:** Node.js 18+, pnpm 10+

```bash
# Install dependencies (also compiles native SQLite module)
pnpm install

# Start dev server with hot reload
pnpm dev

# Type check
pnpm typecheck

# Run tests
pnpm test

# Build Windows installer
pnpm build:win
```

> **Why `pnpm test` and not `vitest`:** `better-sqlite3` is built against the
> **Electron** ABI (`postinstall` → `electron-builder install-app-deps`), because
> the app needs it at runtime. A system Node cannot load this binary.
> `pnpm test` therefore starts Vitest via `scripts/run-vitest.mjs` on the
> Electron binary in Node mode (`ELECTRON_RUN_AS_NODE=1`) — the same answer as
> the MCP server, see below. This way local and CI runs execute the same tests,
> without a second binary copy and without the rebuild back-and-forth that would
> break `pnpm dev`.
>
> Calling `pnpm exec vitest run` **directly** fails accordingly — with a hint
> pointing to `pnpm test`. This is intentional: previously the DB tests would
> silently skip themselves in that case and a third of the coverage disappeared
> behind a green summary ([#151](https://github.com/skoedr/time-tracking/issues/151)).

## MCP Integration

TimeTrack ships an **[MCP](https://modelcontextprotocol.io) server** so that
tools like **Claude Code** can use your local time tracking — e.g. "sum up my
hours for client X in June by project" or "log the meeting I forgot".

**Read tools** (the server opens the SQLite DB **strictly read-only**): `list_clients`
(filter by name/contact person), `list_projects` (filter by client, name, external
project number), `list_entries` (month or date range, filter by client/project/tag,
summary-only mode), `get_running_timer`, `get_dashboard`, `get_analytics` (monthly
hours rounded like the PDF export, optionally revenue).

**Write tools** (opt-in, see below): `create_manual_entry`, `update_entry_fields`,
`start_timer`, `stop_running_timer` — each with `preview: true` for a preview without a commit.

**Times in write tools need a zone.** `started_at` and `stopped_at` must be an ISO
timestamp with date, time of day and zone — an offset or `Z`, e.g.
`2026-10-22T09:00:00+02:00` or `2026-10-22T07:00:00Z`. A value without a zone, a bare
date or an impossible date (`2026-02-30`) is refused, in preview mode as well; the error
names the field and gives an example in the computer's current offset. Without a zone
the moment would be ambiguous: the app reads such a value as local time, `list_entries`
reads its `from`/`to` as UTC. Accepted times are stored in UTC.

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

> **Why the app starts itself:** `better-sqlite3` is built against the **Electron** ABI
> (`electron-builder install-app-deps`); a system Node cannot load the module.
> `ELECTRON_RUN_AS_NODE=1` runs the Electron binary as plain Node — same ABI
> as the bundled module, without a second binary copy in the installer.

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
  session, or never ask.
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

Releases are built automatically by `.github/workflows/release.yml` when a `v*` tag
is pushed to `main`. The workflow rebuilds `better-sqlite3` against the Electron
ABI via `@electron/rebuild`, packages an NSIS installer, and publishes a GitHub
Release with the `.exe`, `.blockmap`, and `latest.yml` attached.

- Download the latest installer:
  [github.com/wald-it/time-tracking/releases/latest](https://github.com/wald-it/time-tracking/releases/latest)
- Roadmap and per-version planning: see [ROADMAP.md](ROADMAP.md) and the
  [open issues](https://github.com/wald-it/time-tracking/issues) grouped by `v1.x` labels.

To cut a new release locally:

```bash
# 1. Bump version in package.json + add CHANGELOG entry
# 2. Commit, tag, and push
git add package.json CHANGELOG.md
git commit -m "chore(release): bump version to 1.x.y"
git tag v1.x.y
git push origin main v1.x.y
# 3. The Release workflow does the rest — runs tests, builds the NSIS installer,
#    and publishes the GitHub Release automatically.
```

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
    jsonExport.ts# Full JSON export (clients + entries + settings)
    logo.ts      # Logo file -> base64 data URL for PDF embedding
    updater.ts   # electron-updater bridge + IPC handlers (auto-update)
    csvExport.ts # CSV export builder
    migrations/  # Versioned schema migrations + runner (001..013)
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
    views/       # TimerView, TodayView, CalendarView, ClientsView, SettingsView
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
  licenses.json  # Generated license list (95 packages, updated on pnpm build)
templates/
```

## Data Storage

The SQLite database lives at `%AppData%\TimeTrack\timetrack.db`. Schema (as of v1.11.1, schema_version 13):

- `clients` — name, color, active flag, `rate_cent` (optional hourly rate)
- `projects` — client_id (FK), name, color, active flag, `rate_cent` (optional hourly-rate override)
- `entries` — client_id, description, started_at, stopped_at, heartbeat_at, `deleted_at` (soft-delete), `link_id` (cross-midnight pair UUID), `project_id` (nullable FK → projects)
- `settings` — key/value store (incl. PDF template settings: logo path, sender, tax id, accent color, footer, round minutes)

On startup the app auto-stops any entries where the heartbeat is older than 5 minutes (crash recovery).

## Security

- `contextIsolation: true`, `nodeIntegration: false`
- All database access runs in the main process only
- Renderer communicates exclusively via the typed Context Bridge (`window.api`)
- Vulnerability reporting: see [SECURITY.md](SECURITY.md)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for dev setup, branch naming, and PR guidelines.

## Privacy

All data stays local. Only outbound call: auto-update check against `api.github.com`. No telemetry. See [PRIVACY.md](PRIVACY.md).

## License

[MIT](LICENSE) © 2026 Robin Wald

The bundled third-party packages keep their own licenses; the full list is
generated by `scripts/generate-licenses.mjs` into `resources/licenses.json`
and shown in **Settings → About → Licenses**.
