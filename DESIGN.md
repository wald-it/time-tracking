# TimeTrack — Design Document

**Date:** 22 April 2026 (design system updated: 23 October 2026)  
**Mode:** Builder (personal use, possibly shared later)  
**Phase:** Messinstrument design system implemented (supersedes v1.8 Glass)  
**Reference:** `design/messinstrument/HANDOFF.md`, `design/messinstrument/reference.html`

---

## Design System (Messinstrument)

Supersedes the v1.8 Glass design system (#76); the Glass reference `design/issue-76-glass-reference.html` is kept for history only. The full specification with mockups lives in `design/messinstrument/` (`HANDOFF.md`, `reference.html`, `screens/*.png`, `source/*.dc.html`); this section is the short version a contributor needs.

### Idea

TimeTrack is a measuring instrument, not a dashboard: a solid chassis, a dark readout window, hard keys, scales with ticks. Everything is flat and solid — **no blur, no translucency, no glow, no gradient backgrounds, no drop shadows** (the only "shadow" is the 2 px keycap edge). Hatching (`repeating-linear-gradient`) is the one allowed pattern: it marks *running* time and *non-billable* time. Colour carries meaning, not decoration: client colours identify, `--sig` means *now / running / today*, everything else is ink on paper.

### Themes and tokens

Two themes, **Papier** (`:root`) and **Graphit** (`.dark`), plus "System". All colours come from tokens in `src/renderer/src/assets/base.css`; components never hard-code colours or Tailwind palette classes. Three exceptions are deliberate: the mini widget's `var(--token, #hex)` fallbacks (its window can paint before the tokens apply), the client/project colour presets (`components/clientColors.ts` — data the user picks, not UI colour), and the PDF accent colour (a user setting, default `#4f46e5`, used only in the PDF).

| Token | Use |
|---|---|
| `--bg` | Chassis / page. Solid, never a gradient. |
| `--key` | Raised key, inputs, hovered row, selected cell. |
| `--key-edge` | Key border and the 2 px keycap bottom edge. |
| `--line` | Hairlines between rows and cells. |
| `--tick` | Scale ticks, graticule, non-billable hatch. |
| `--ink` / `--ink2` / `--ink3` | Primary text and 2 px section rules / secondary text and legends / hints and metadata — `--ink3` is the lightest text colour allowed on `--bg`. |
| `--disp`, `--disp-ink`, `--disp-dim`, `--disp-line` | The readout window (timer display, cursor readout, toasts). |
| `--inv`, `--inv-ink`, `--inv-dim` | Inverted keys (STOPP, active segment). |
| `--sig`, `--sig-ink` | Signal: running, now, today, focus. **Never small text on `--bg`.** Text on `--sig` uses `--sig-ink`. |
| `--danger` | Destructive actions and errors. |
| `--focus` | Focus ring (= `--sig`). |
| `--r-key` 4 px, `--r-disp` 6 px, `--r-fine` 2 px | Radii of keys, windows/dialogs, small marks. |
| `--edge-key`, `--edge-bigkey` | Keycap edges. |

Contrast was checked per theme (table in `design/messinstrument/tokens.css`).

### Typography

- **Archivo Variable** (`--font-ui`) for all text; legends in caps, 11 px / 600, letter-spacing ≈ 0.14 em, `font-stretch` ≈ 118 %.
- **IBM Plex Mono** (`--font-num`, class `font-num`) for every number: durations, amounts, axes, readouts. Large readouts light (300).
- Both fonts are bundled (`@fontsource-variable/archivo`, `@fontsource/ibm-plex-mono`) and imported in `main.tsx` and `mini.tsx`.

### Layout and shape

- **Section pattern:** a 2 px `--ink` rule on top, legend (and meta on the right), content. Used for every block instead of cards.
- Content column `mi-column` (max. 1440 px, 24 px gutters below 840 px); the window is at least 760 × 600, so every screen must work at 760 px without horizontal page scroll. A flex column's basis is at least the minimum width of its content (HANDOFF §2.3).
- Rows: label left, value or control right, 1 px `--line` hairline between rows. Hit targets of keys ≥ 44 px.
- Keys: `--key` with `--key-edge` border, `--edge-key`, radius `--r-key`; pressed = `translate-y-px`. Icon keys 44 × 44 with an `aria-label`.
- Dialogs: `--bg` panel, 1 px `--line` border, radius `--r-disp`, backdrop `rgb(0 0 0 / .35)`, title row with a 2 px `--ink` rule; one dialog shell (`Dialog.tsx`) with focus trap, Escape and focus return.

### States and motion

- Focus: 2 px `--focus` outline (`focus-visible`), never removed.
- Hover (HANDOFF §2.4): keys get a 1 px `--ink3` outline at 2 px offset (`.key-hover`), not a colour change; rows and icon buttons take the `--key` background; selected cells add `inset 0 0 0 1px var(--ink)`.
- Running: a blinking `--sig` square (`tt-blink`), hatched bars, a `--sig` needle at *now*. `prefers-reduced-motion` stops the blink, the 180 ms view fade (`.view-enter`) and the hold-to-open fill; a test checks that every CSS animation in `base.css` and `main.css` has such a stop.
- No transitions on layout; motion only where it carries state (blink, hold-to-open fill).

### Components (where they live)

| Component | File | Spec |
|---|---|---|
| App header with stages for narrow windows | `components/heute/AppHeader.tsx` | §3.1 |
| Display (timer readout), BigKey (START/STOPP), Readout, WeekMeter | `components/heute/*` | §3.2–§3.7 |
| DayScale (Tagesverlauf), MiniDayScale (calendar cell) | `components/heute/DayScale.tsx`, `components/kalender/MiniDayScale.tsx` | §3.8, §3.9 |
| EntryTable | `components/heute/EntryTable.tsx` | §3.10 |
| QuickStart — preset keys + project list | `components/heute/QuickStart.tsx` | §3.11 |
| Calendar grid, day panel / drawer, client breakdown | `views/CalendarView.tsx`, `components/kalender/*`, `components/CalendarDrawer.tsx` | §3.12–§3.14 |
| KPI readouts, Stunden nach Kunde, Wochentag-Schnitt, two-band trend, segmented control | `components/auswertung/*` | §3.5, §3.6, §3.15 |
| Dialog shell (focus trap, Escape, focus return, `Z_MODAL` / `Z_TOAST`) | `components/Dialog.tsx` | §5 |
| Toggle (`role="switch"`, named by its settings row) | `components/Toggle.tsx` | §5, §8 |
| Shared class strings for keys, inputs, readouts, legends, sections | `components/instrumentClasses.ts` | §2.3, §3.4 |

### Numbers

One rounding rule (HANDOFF §2.2): large numbers are **worked time**, to the second. A rounded figure, where shown ("gerundet … h"), is rounded **per entry like the invoice** and then summed — never a rounded sum. Revenue is always computed like the invoice (`shared/currency.ts`).

### Behaviour changes and their switches (HANDOFF §6)

Each approved behaviour change has one named switch in the code that brings back the old behaviour:

| | Change | Switch |
|---|---|---|
| B1 | Quick start while a timer runs switches instead of being locked; project list instead of the radial fan | `QUICKSTART_SWITCH_WHILE_RUNNING` (`components/heute/QuickStart.tsx`) |
| B2 | Current month compared with the same days of the previous month | `SAME_PERIOD_COMPARISON` (`main/analyticsHandlers.ts`) |
| B3 | Trend as two bands on one x-axis instead of a dual axis | `TREND_TWO_BANDS` (`views/AuswertungView.tsx`) |
| B4 | Calendar day panel at wide widths, day scales in cells | `DAY_PANEL_MEDIA_QUERY` (`views/CalendarView.tsx`) — the drawer stays as the narrow-width layout for good |

The switches and the code behind them stay until the owner decides to remove them, once the design has run for a while. The calendar drawer is not part of that: it is the layout for narrow windows.

---

## The problem

A freelancer (single user) wants to track project time and produce clean
timesheets for clients from it. Toggl Track is too much (cloud account,
subscription, team features). Excel is too slow. It should feel like
a small, professional Windows tool that you simply let run on the side.

---

## Vision

A two-part Windows tool:

1. **Mini mode** — timer widget, always in front, one click to start.
2. **Calendar mode** — month view, add entries after the fact, export a timesheet.

The primary artifact: a PDF timesheet that looks like "page 2" of your own invoice.

---

## Premises (confirmed)

| #   | Premise                                                                                   |
| --- | ----------------------------------------------------------------------------------------- |
| 1   | Solo-freelancer tool. No team, no cloud, everything local.                                |
| 2   | Mini mode is the daily workflow. Calendar is for adding entries & month-end close.        |
| 3   | Primary artifact: PDF timesheet. No invoicing, no accounting export.                      |
| 4   | Electron + React as the base. Outlook integration (Graph API) comes in phase 2.           |

---

## Tech stack

| Layer          | Technology                                    | Rationale                                                                          |
| -------------- | --------------------------------------------- | --------------------------------------------------------------------------------- |
| Shell          | **Electron**                                  | Native Windows window, system tray, no browser needed                             |
| UI             | **React** + Tailwind CSS                      | User knows the web stack, fast iteration                                          |
| Database       | **SQLite** (via `better-sqlite3`)             | Local, zero-config, no server                                                     |
| PDF            | **Electron `webContents.printToPDF()`**       | Uses the Chromium that Electron already ships — no Puppeteer (+300MB) needed      |
| Build          | **electron-builder**                          | `.exe` installer for Windows, auto-update prepared                                |
| Package manager | **npm** / **pnpm**                           | Standard for Electron projects                                                    |
| IPC security   | **Context Bridge** (`contextIsolation: true`) | HTML templates are rendered — nodeIntegration stays off                           |
| Data path      | **`app.getPath('userData')`**                 | `%AppData%\TimeTrack\` — updates never overwrite data                             |

> **Why not Tauri?** The Rust learning curve would slow down phase 1. Tauri stays
> an option for phase 3, when executable size becomes important.

> **Why not a web app?** System tray, always-on-top window, and a real Windows feel
> are decisive for mini mode. A web app cannot do that.

---

## Feature scope

### Phase 1 — the core product

#### Mini mode (timer widget)

- **Always-on-top**, small window (~300×150px)
- **Start / Pause / Stop** buttons with keyboard shortcut (`F5` / `F6`)
- **Global hotkey** (`F5`/`F6`) — works even when the window is in the background (`globalShortcut`)
- **Client dropdown** (quickly switchable)
- **Activity description** (free-text field, required before stop)
- **Running duration** (HH:MM:SS, live)
- **Rounding-mode** indicator (shows the rounded time)
- Click on the title → switches to calendar mode
- **Tray icon:** green = timer running, gray = stopped (via `nativeImage` + Electron Tray API)

#### Calendar mode

- **Month view** (calendar grid, one block per entry)
- **Color coding** by client
- **Create/edit/delete entry** (manual, for retroactive entries)
- **Total hours per month** by client (sidebar summary)
- **Export PDF** button (opens the export dialog)
- **List view** as an alternative to the calendar view

#### Client management

- Name, color, short label (for the PDF header)
- Hourly rate (optional, for later calculations)
- Archive (not delete)

#### Settings

- **Rounding mode:** 5 / 10 / 15 / 30 minutes; ceil / floor / round
- **Branding:** logo (PNG/SVG), company name, address, VAT no. (for the PDF footer)
- **Default activities:** predefined texts as quick-select
- **Startup behavior:** autostart with Windows (optional)
- **Mini mode always in front:** on/off
- **Auto-backup:** configurable target folder (e.g. OneDrive); the SQLite DB is copied daily

#### PDF export

- Choose the **time range** (month picker or custom)
- Choose the **client**
- **HTML template** (customizable, lives in the app data folder)
- **Default layout:**
  - Header: logo on the left, client info on the right, time range
  - Table: date | from | to | activity | duration (rounded)
  - Footer: total hours, signature line, page number
- The PDF is saved and opened in Explorer

---

### Phase 2 — Outlook integration

- **Microsoft Graph API** (OAuth2, one-time sign-in)
- Office E1 subscription is supported (delegated permissions: `Calendars.Read`)
- Import calendar events → map to a client + activity
- Duplicate detection (do not import the same event twice)
- Sync button in calendar mode

---

### Phase 3 — nice-to-have (no commitment)

- Tauri rewrite for a smaller executable size
- ~~Dark mode~~ **✅ implemented in v1.8**
- Multi-monitor support for mini mode
- CSV export (for accounting)
- Statistics view (hours per week/month over time)

---

## Data model

```sql
-- Kunden
CREATE TABLE clients (
  id        INTEGER PRIMARY KEY,
  name      TEXT NOT NULL,
  short     TEXT,           -- Kurzname für PDF-Header
  color     TEXT,           -- Hex-Farbe
  rate      REAL,           -- Stundensatz (optional)
  archived  INTEGER DEFAULT 0,
  created   TEXT
);

-- Zeiteinträge
CREATE TABLE entries (
  id              INTEGER PRIMARY KEY,
  client_id       INTEGER REFERENCES clients(id),
  started_at      TEXT NOT NULL,  -- ISO 8601
  stopped_at      TEXT,           -- NULL = läuft noch (Zombie-Check beim Start!)
  heartbeat_at    TEXT,           -- Alle 30s aktualisiert → Crash-Recovery
  description     TEXT,
  duration_s      INTEGER,        -- berechnete Dauer in Sekunden
  rounded_s       INTEGER,        -- gerundete Dauer (nach Rundungsmodus)
  source          TEXT DEFAULT 'manual',  -- 'manual' | 'outlook'
  outlook_id      TEXT,           -- Graph-Event-ID (für Duplikat-Check)
  created         TEXT
);

-- Index für Monatsabfragen (schnell bei vielen Einträgen)
CREATE INDEX idx_entries_client_started ON entries(client_id, started_at);

-- Einstellungen (Key-Value)
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
```

---

## UI sketches

### Mini mode

```
┌─────────────────────────────┐
│ ▶ Kunde GmbH          00:47 │
│ [Implementierung Feature X  ]│
│ [▶ Start] [⏸] [⏹ Stop]      │
└─────────────────────────────┘
```

### Calendar mode (header)

```
┌──────────────────────────────────────────────────┐
│ ← April 2026 →          [+ Eintrag] [📄 Export]  │
│                                    Summe: 87,5 h │
├────────────────────────────────────────────────  │
│  Mo  Di  Mi  Do  Fr  Sa  So                      │
│  [█ Kunde A, 3h] [  ] [█ Kunde B, 2h] ...        │
└──────────────────────────────────────────────────┘
```

---

## App directory structure

```
time-tracking/
├── src/
│   ├── main/              # Electron main process
│   │   ├── index.ts       # App init, IPC handler, Tray
│   │   ├── db.ts          # SQLite setup & queries
│   │   ├── pdf.ts         # Puppeteer PDF-Erzeugung
│   │   └── updater.ts     # (Phase 2) Auto-Update
│   ├── renderer/          # React App
│   │   ├── App.tsx
│   │   ├── views/
│   │   │   ├── MiniTimer.tsx
│   │   │   ├── Calendar.tsx
│   │   │   ├── Settings.tsx
│   │   │   └── Clients.tsx
│   │   ├── components/    # Wiederverwendbare UI-Teile
│   │   └── store/         # Zustand (Zustand.js o.ä.)
│   └── shared/            # Typen, Konstanten
├── templates/
│   └── report.html        # Bearbeitbares PDF-Template
├── DESIGN.md
└── package.json
```

---

## Fastest path to phase 1 (build order)

1. Set up **Electron boilerplate** (`electron-vite` + React + TypeScript, `contextIsolation: true`)
2. Define the **Context Bridge** (IPC API between main + renderer)
3. Wire up **SQLite**, create the schema (`userData` path), set the index
4. **Mini mode** — timer widget, start/stop, client selector
   - Heartbeat writer (setInterval 30s → `heartbeat_at` in the DB)
   - Crash recovery on app start (open entry? → auto-stop)
5. **Global hotkey** (`globalShortcut` F5/F6)
6. **Tray icon** — green/gray, tooltip with the current duration
7. **Client management** (CRUD in Settings)
8. **Calendar mode** — month view, show entries
9. **Manual entry** — dialog for retroactive entries
10. **Settings** — rounding mode, branding, auto-backup path
11. **Auto-backup** — copy the SQLite file to the backup folder daily
12. **PDF export** — HTML template + `webContents.printToPDF()`
13. **Installer** — electron-builder `.exe`
14. **Phase 2:** Outlook integration (Graph API)

---

## Open decisions

| Question            | Recommendation                                            | Alternative          |
| ------------------- | --------------------------------------------------------- | -------------------- |
| State management    | Zustand (minimal, no Redux overhead)                      | Jotai                |
| Date library        | `date-fns` (tree-shakeable)                               | `dayjs`              |
| Calendar component  | Custom-built (simple grid)                                | `react-big-calendar` |
| PDF preview         | Browser preview window (BrowserWindow with `printToPDF`)  | save directly        |
| Update mechanism    | electron-updater (GitHub Releases)                        | manual               |

## Architecture decisions (from reviews)

| Decision       | Chosen                     | Rationale                                                     |
| -------------- | -------------------------- | ------------------------------------------------------------- |
| IPC security   | Context Bridge             | HTML templates are rendered, nodeIntegration off              |
| PDF engine     | `webContents.printToPDF()` | Electron already has Chromium — no Puppeteer                  |
| Data path      | `app.getPath('userData')`  | Update-safe, no data loss                                     |
| Crash recovery | Heartbeat + auto-stop      | `heartbeat_at` every 30s, close open entries on start         |

## Mandatory tests (from eng review)

| Test                                             | Type        | Priority  |
| ------------------------------------------------ | ----------- | --------- |
| Rounding mode (all 3 modes × all intervals)      | Unit        | P1        |
| Crash recovery: app start with an open entry     | Integration | P1        |
| PDF export: correct time range, correct hours    | Integration | P1        |
| Auto-backup: target folder does not exist        | Unit        | P2        |
| Zombie detection: heartbeat > 5 min old          | Unit        | P1        |

---

## Deferred (after the first release)

- Quick-start via tray context menu (start last client, stop)
- Monthly statistics (bar chart of hours per client)

---

## What we deliberately do NOT build (phase 1)

- No cloud sync, no account, no login
- No invoicing
- No team features
- No mobile client
- No time tracking via screenshot/activity tracking (no spy tool)

---

_Design status: REVIEWED — CEO + eng review completed. Messinstrument design system implemented (supersedes Glass v1.8, #76)._

**Reviews:** /office-hours ✓ | /plan-ceo-review ✓ (SELECTIVE EXPANSION) | /plan-eng-review ✓

---

## v1.2 Visual Tokens (stub) — historical

> Superseded, first by the v1.8 Glass system and now by the Messinstrument design
> system above. Kept for history; none of these values are current.

Minimal token sheet introduced with v1.2 (#26 Calendar, #30 Today, #28 Edit/Delete).
Full state-matrix and component catalogue follow in v1.3.

### Color tokens

**Surfaces (Tailwind slate scale)**

- `slate-900` `#0f172a` — page background
- `slate-800` `#1e293b` — card background
- `slate-700` `#334155` — raised surface, drawer body
- `slate-600` `#475569` — focused/expanded row
- `slate-400` `#94a3b8` — secondary text
- `slate-300` `#cbd5e1` — body text
- `slate-100` `#f1f5f9` — primary text / numerics

**Accent**

- `indigo-500` `#6366f1` — primary action, today-highlight border, active links
- `indigo-400` `#818cf8` — hover

**Semantic**

- `emerald-500` `#10b981` — success / save flash
- `amber-500` `#f59e0b` — warning (cross-midnight banner)
- `red-500` `#ef4444` — destructive / delete confirm

**Client palette (10 presets, locked in v1.1)**
`#6366f1` `#8b5cf6` `#ec4899` `#f59e0b` `#10b981`
`#3b82f6` `#ef4444` `#f97316` `#14b8a6` `#84cc16`

### Typography scale

- Display (timer numerics): 56px / 64px (mono, e.g. `font-mono text-7xl`)
- h1: 24px / 32px, semibold
- h2: 20px / 28px, semibold
- body: 14px / 20px, regular
- small: 12px / 16px, regular (KW column, tagessumme)

### Spacing tokens

4 / 8 / 12 / 16 / 24 / 32 px (`gap-1 / gap-2 / gap-3 / gap-4 / gap-6 / gap-8`).

### Calendar mini-bars (locked v1.2)

- Bar height: **3 px**, gap **2 px**
- Max **5 visible** per cell; overflow as clickable `+N` (opens Drawer)
- Bar color = `client.color`; running entry has 1px white border

### Drawer (locked v1.2)

- Position: `fixed right-0 top-0 w-96 h-screen`
- Sticky header (date + total, close X)
- Sticky footer ("+ Eintrag für [Date] hinzufügen")
- Inline-edit row expands to ~200 px max with `scrollIntoView({block:'center'})`

### Known limitations (deferred)

| #   | Limitation                                                                  | Defer-to  | Reason                                                       |
| --- | --------------------------------------------------------------------------- | --------- | ------------------------------------------------------------ |
| L1  | Tray-tooltip is German-only (ignores `settings.language`)                   | v1.4      | Full i18n pass scoped together                               |
| L2  | Client color palette not colorblind-safe (Indigo/Violet, Blue/Teal cluster) | v1.4      | Palette change requires migration of saved per-client colors |
| L3  | No mobile/tablet layout (<1024 px); Calendar grid breaks below that width   | v1.4      | App is Windows-desktop-first; web build not on roadmap       |
| L4  | No light mode                                                               | post-v1.5 | Single user, dark-only tested                                |
| L5  | Cross-midnight entries blocked (warning banner shown in EntryEditForm)      | v1.3      | Needs entry-splitting logic + PDF impact                     |
| L6  | Full ARIA / screen-reader pass                                              | v1.3      | Keyboard nav for Calendar already in v1.2                    |
