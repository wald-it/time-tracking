# TimeTrack Roadmap

> Goal: the best local solo-freelancer time-tracking tool for Windows. No cloud,
> no account, no subscriptions. Created on 23.04.2026, post-v1.0.0.

## North Star

A tool you **fully trust** when writing invoices. Never forgotten,
never lost, never cumbersome. From the hotkey to the PDF timesheet in one
closed loop. No tabs, no browsers, no second program needed.

---

## v1.1 — Daily Trust (solving pain points) ✅ shipped v1.1.0–v1.1.2 (2026-04-24)

**Theme:** What costs the freelancer money when the app does not do it.

- ✅ **Idle Detection** — PC idle >5 min? Modal "Keep the timer running, stop at XY:XX,
  or mark as break?". Prevents the biggest data-loss spot:
  forgetting the lunch break.
- ✅ **Tray Quick-Start** — active clients directly in the tray context menu as buttons. 1 click
  → timer runs. Today it takes: tray → show window → choose client → start. 4 clicks.
- ✅ **Settings view** — change the hotkey, show + open the DB path, set the idle threshold,
  language (DE/EN — i18n strings follow in v1.2), "Start automatically on Windows startup" toggle.
- ✅ **Auto-backup** — rolling 7-day SQLite snapshots in `%AppData%\TimeTrack\backups\`.
  Restore via Settings.
- ✅ **DB migrations** — a `migrations/` folder with TypeScript migration modules, run
  on app start by schema version. Mandatory before v1.2 adds new columns.
- ✅ **Bonus:** Vitest setup with the first tests + an automated Windows release workflow.

**Ship criterion:** You can trust the tool over a full workday without babysitting. ✅

---

## v1.2 — Calendar & Edit ✅ shipped v1.2.0 (2026-04-24)

📂 [Issues with label `v1.2`](https://github.com/wald-it/time-tracking/labels/v1.2)

**Theme:** What happened, when did it happen, and can I correct it?

- ✅ **Calendar mode** — 7×N monthly grid, calendar-week column, daily total, up to 5 mini-bars
  per day (with `+N` overflow), keyboard navigation, today's cell highlighted.
- ✅ **Edit entry** — start/stop, description, client changeable after the fact.
  Rounding per entry optional (5/10/15/30 minutes).
- ✅ **Delete entry** — soft-delete with a 5 s undo toast (`deleted_at` column).
- ✅ **Manual entry** — "Add entry" dialog with server-side validation.
- ✅ **Today overview** — default tab: active timer as a pill, daily/weekly total,
  top-3 client quick-start, last 5 entries.
- ✅ **Tray tooltip extension** — `● Mustermann · 02:14 · Heute 06:42`.

**Ship criterion:** You can visually review a week of data and correct errors without SQL. ✅

---

## v1.3 — PDF Export & Reporting ✅ shipped v1.3.0 (2026-04-25)

📂 [Issues with label `v1.3`](https://github.com/wald-it/time-tracking/labels/v1.3)

**Theme:** Data → a finished invoice attachment in 30 seconds.

- ✅ **PDF timesheet** — choose client + time range → A4 PDF (date / from / to /
  activity / duration, optionally fee). Hidden `BrowserWindow` + `printToPDF` instead of
  puppeteer (no additional renderer entry).
- ✅ **Full JSON export** — clients + entries (incl. soft-deleted and linked
  halves) + settings as a readable JSON file. A trust artifact.
- ✅ **Configurable PDF template** — logo, sender address, tax number,
  accent color, footer, optional hour rounding in Settings → PDF Template.
- ✅ **Hourly rate per client** — integer cents in `clients.rate_cent`, renders as a
  €-column in the PDF.
- ✅ **Quick-filter in the calendar** — four pills + hero button "📄 Last month as PDF".
- ✅ **Cross-Midnight Auto-Split** — entries spanning midnight are automatically split in the IPC
  into two linked halves (migration 005, `entries.link_id`).
- ✅ **App + tray icons** — glass style from `timetrack_icon_glass_desktop.svg`,
  manual sync workflow via `scripts/sync-icon.mjs` + `prebuild` hook.
- ✅ **CI PDF smoke test** — the release workflow renders a mini PDF from the packaged
  `.exe` and checks `pdfBytes >= 1000` before the release is published.

**Ship criterion:** You create invoice attachments faster than ever and without Excel. ✅

---

## v1.4 — Flow & Less Friction ✅ shipped v1.4.0–v1.4.1 (2026-04-25)

📂 [Issues with label `v1.4`](https://github.com/wald-it/time-tracking/labels/v1.4)
📋 [Plan & Multi-Angle Review](.github/plan-v1.4.md)

**Theme:** The app should disappear into the workflow, not disturb it. Plus the CI homework
(Node 20 → 24) before it becomes blocking.

- ✅ **CI Node 24 bump** (#41) — `pnpm/action-setup@v4` → `@v5` in both workflows.
  Before the June deadline for the Node-20 action deprecation.
- ✅ **Mini widget** (#22) — always-on-top, **200×40px horizontal** (Toggl style),
  shows time + client + stop button side by side. Toggle via hotkey `Alt+Shift+M`.
  Hero feature of v1.4.
- ✅ **Tags per entry** (#24) — `#feature`, `#bugfix`, `#meeting` etc. Hash-based
  chip colors from an 8-color palette. Groupable in the PDF.
- ✅ **Quick note after stop** (#25) — when the description was empty, a toast "What was that?"
  with a 30s input window + progress bar.
- **Window size & layout density** — minimum size, persist the last position/size,
  container-width audit (let TodayView/CalendarView breathe).

**Ship criterion:** Use it daily for weeks without it being annoying. Nobody opens the
main window to see "is my timer running?". ✅

---

## v1.5 — Trust at Scale & Data Portability ✅ shipped v1.5.0–v1.5.2 (2026-04-25)

📂 [Issues with label `v1.5`](https://github.com/wald-it/time-tracking/labels/v1.5)
📋 [Plan & Multi-Angle Review](.github/plan-v1.5.md)

**Theme:** When someone other than you uses the tool, it should not be embarrassing.

- ✅ **Crash logging** (#34) — `electron-log` writes errors to `%AppData%\TimeTrack\logs\`.
  A Settings button "Open log file" for debugging. Foundation for all other v1.5 PRs.
- ✅ **Auto-update** (#33) — `electron-updater` against GitHub Releases. An update banner instead of
  silent failure. The update is applied on the next restart.
- ✅ **CSV export** (#18) — for tax advisors or external tools (DATEV-compatible).
  Moved out of v1.4, since the full JSON export already covers data portability
  and v1.4 focused on friction removal.
- ✅ **i18n foundation** — a small custom implementation (no i18next heavyweight).
  DE as source of truth, an EN stub for migrated areas. Non-migrated strings
  remain hardcoded; the full app translation comes in v1.6.
- ✅ **Onboarding wizard** (#32) — on first start: 3 steps (welcome+language →
  create first client → hotkey hint). Shown once. Existing users get the
  flag set automatically.
- ✅ **License notices** (#35) — About dialog with the MIT license and automatically generated
  third-party licenses.
- ✅ **Security patches (v1.5.2)** — supply-chain hardening (action SHA pinning),
  backup-restore path-traversal fix, URL links via `shell.openExternal` instead of
  `openPath`, CI permissions restricted to least privilege.

> **Cut from v1.5:** Pomodoro mode (#23). The maintainer does not use it himself;
> daily trust is already covered by the mini widget + quick note.
>
> **Deliberately not in v1.5:** Code signing. The SmartScreen warning on installation
> is accepted. It breaks no functionality, just a one-time "Run anyway" click.

**Ship criterion:** You can give the app to a second freelancer without instructions. ✅

---

# Phase 2 — Open Source Release (v1.6 → v2.0)

> **Strategy shift post-v1.5.2:** The tool is solo-capable "done". North Star
> phase 1 reached. Phase 2 deliberately opens the repo to the freelancer community
> (MIT license, voluntary use, best-effort support via GitHub Issues / Discussions).
> Directives remain: no cloud, no server, no SaaS subscription, solo maintainer.
>
> **Approach B ("distribution + PDF merge as the hero, Outlook later")** — see the
> office-hours design doc for the alternatives discussion (A/B/C). The rationale
> for the choice in one sentence: PDF merge is the only one-sentence OSS pitch that
> immediately grabs every DE freelancer with Lexware/sevDesk/Billomat — and is
> at the same time the maintainer's real pain.

## Pre-roadmap block (license hygiene) ✅ shipped (2026-04-26)

Before the first v1.6 PR the repo was legally **not** open source, even though the
About dialog showed "MIT". Repaired in one commit + history rewrite:

- ✅ **`LICENSE` file** with the canonical MIT text, copyright Robin Wald.
- ✅ **`"license": "MIT"`** in `package.json` + `repository`/`bugs` fields.
- ✅ **README license section** rewritten ("Private — not for distribution"
  → MIT + reference to bundled third-party licenses).
- ✅ **Git history purged** via `git filter-repo`: three PII files (an invoice with
  IBAN/tax number, a logo, one Lingua-Masters timesheet) removed retroactively from every
  commit. Backup mirror under `..\time-tracking-backup-*.git`.
- ✅ **13 obsolete stage branches** deleted on origin (all squash-merged into main,
  contained the original commit `5c78d91` with the PII blobs). The remote now only shows `main`.

---

## v1.6 — OSS Readiness ✅ shipped v1.6.0–v1.6.1 (2026-04-26)

**Theme:** Turn "my repo happens to be on GitHub" into "a repo that another
freelancer can clone, understand, and contribute to".

- **`CONTRIBUTING.md`** — concise: PR format (small PRs, one topic), `pnpm install` /
  `pnpm dev` / `pnpm test` / `pnpm typecheck` workflow, branch naming, commit style
  (`feat:`/`fix:`/`chore:` as already lived in the CHANGELOG). Code-of-conduct link
  (Contributor Covenant 2.1, one more file).
- **Bilingual README** — English section on top (brief, "what + why"), DE
  in detail below. Or as a second file `README.en.md` with a cross-link.
  Decision: two files, because DE already has 158 lines and an inline mix
  becomes unreadable.
- **GitHub issue templates** under `.github/ISSUE_TEMPLATE/` — bug report,
  feature request, question. With repro steps + OS/version fields.
- **Enable GitHub Discussions** (a manual UI step in the repo settings).
  Categories: Q&A, Ideas, Show & Tell, General.
- **macOS build in the release workflow** — `pnpm build:mac` already exists in
  package.json, add it as a second job in `.github/workflows/release.yml`.
  electron-builder produces a `.dmg`. No Apple code signing (analogous to the Windows
  SmartScreen directive: the user clicks "Open anyway" once). Notarization
  deliberately out of scope.
- **Privacy statement** as `PRIVACY.md` (1-pager): all data local in
  `%AppData%\TimeTrack\`. The only outbound call = auto-update against
  `api.github.com/repos/wald-it/time-tracking/releases`. No telemetry,
  no analytics, no crash reporter to third parties. Logs stay local.
- **`SECURITY.md`** — how security issues are reported (private GitHub
  Security Advisory preferred, email as fallback).

**Ship criterion:** A stranger freelancer finds the repo on GitHub, understands
in 60 seconds whether it suits them, downloads the installer, and starts the app
without help.

**Deliberately NOT in v1.6:** Code signing (the ROADMAP directive stays), a marketing
push (HN/Reddit posts), an English CHANGELOG translation, Crowdin integration.

---

## v1.7 — PDF Merge (hero feature) ✅ shipped (2026-04-26)

📂 [Plan](.github/plan-v1.7.md)

**Theme:** The one OSS pitch sentence the app has to carry: "TimeTrack
creates your timesheet and attaches it to your Lexware/sevDesk/
Billomat invoice — in one click."

- ✅ **`pdf-lib` dependency** (~150 KB, pure JS, MIT) — no Puppeteer, no native modules, no rebuild step.
- ✅ **Checkbox "Attach to invoice"** always visible in the export modal (no settings toggle — as directly discoverable as the signature-fields checkbox).
- ✅ **File picker** for the invoice PDF via a native `<input type="file">` + Electron `File.path`.
- ✅ **`pdf:merge-export` IPC handler** with path-traversal guard, 50-MB cap, EBUSY/EPERM handling, EPERM fallback to the save dialog.
- ✅ **Output:** `<Rechnungsname>_inkl_Stundennachweis.pdf` next to the original file. The original is never modified.
- ✅ **18 new tests** (pdfMerge.test.ts + ipc.test.ts). No schema change.

**Ship criterion:** The maintainer has checked off his manual Smallpdf workflow for good.
A test freelancer with a Lexware PDF can reproduce it in under 30 s.

---

## v1.8 — Daily-Use Polish ✅ shipped v1.8.0–v1.8.1 (2026-04-27)

**Theme:** What hurts after 4–6 weeks of self-use + the first OSS feedback.
The exact order is determined by issues — this list is the
starting point, not dogma.

📂 [Milestone v1.8](https://github.com/wald-it/time-tracking/milestone/2)

- ✅ **Full i18n DE/EN** — all views, components, and the mini widget migrated. `scripts/find-untranslated.mjs` shows 0 hits. From v1.8 on: every new user-visible string must be entered in `de.ts` **and** `en.ts` — a review blocker if not satisfied.
- **PDF: merge overlapping entries of the same client** — configurable tolerance window (default 5 min), only with rounding enabled, purely PDF output (the calendar stays granular).
- **Group CSV export by tags** (#68) — export configuration: option "Grouping: by tags". A feature request.
- **Ticket number / reference field** (#70) — an optional free-text field per entry for a Jira ticket, GitHub issue, etc. Flows into CSV/PDF.
- **Non-billable flag** (#71) — mark entries as "non-billable"; filtered out in invoice exports.
- **Private note on an entry** (#72) — an internal note field, not visible in the export.
- **Collapsible archived clients** (#73) — collapsed by default, expandable by click.
- **Settings navigation / submenus** (#74) — logical sub-areas (General, Export, Backup, About).
- **Light mode / theming** (#76) — Tailwind `dark:` class strategy. Light / Dark / System-follow. The largest item (~2–3 weeks).
- ✅ **Fresh-install test** — carried out at a colleague's without problems. No critical findings.

**Deliberately cut:** Pomodoro (#23) — no personal need, no OSS user has explicitly asked for it. Moves to the backlog.

**Ship criterion:** Fully EN-translated, all user feature requests evaluated and either built or justifiably deferred. No open "annoys me daily" items in the maintainer's diary.

---

## v1.9 — Projects & Data Portability ✅ shipped v1.9.0 (2026-04-29)

**Theme:** The two biggest architecture decisions before v2.0: a real project hierarchy
and clean machine migration.

📂 [Milestone v1.9](https://github.com/wald-it/time-tracking/milestone/3)

- **Projects per client** (#75) — a real hierarchy `Client → Project → Entries`.
  A project = its own DB entity with its own hourly rate, optional runtime.
  Timer, calendar, export know projects. Existing entries get
  `project_id = NULL` (backward-compatible). **Eng review before implementation.**
- **JSON import for machine migration** (#78) — import of the existing JSON export.
  Schema validation, dry-run preview, automatic backup before import,
  configurable merge strategy (overwrite vs. new entries only).
- **Configurable backup path** (#79) — target folder selectable in the settings
  (OneDrive, Dropbox, NAS). A simple path picker, no cloud API.
- **Migration 010: `entries.source` column** (`'manual' | 'timer' | 'outlook'`).
  Foundation for v2.0 Outlook imports.
- **Settings → Integrations** — a stub card "Outlook (coming in v2.0)".
  Makes the roadmap plan visible to users.

**Ship criterion:** You can move your entire data history to a new machine
without data loss. Projects per client are bookable.

---

## v1.10 — Reporting & Quick Start 2.0 ✅ shipped v1.10.0 (2026-04-30)

**Theme:** More insight into your own data, faster timer start at project level + an architecture sketch for v2.0.

- **Quick Start 2.0** (#96) — the pill remembers the last [client+project] combination as a subtitle.
  **Tap** = start immediately. **Press & hold (~300ms)** = a radial fan opens with all
  projects of the client; releasing on a project = select. Mini widget: tap only, no fan.
  No schema change (the last project via `MAX(started_at)` from existing entries).
- **Weekly and monthly charts** in TodayView — a sparkline widget, SVG hand-drawn
  (no external chart lib). Hours per day as a bar chart, top 3 clients as a donut.
  Reuse: `entriesStore` + `dateRanges.ts`, no schema change.
- **"Top 5 activities this month"** — GROUP BY on `description`, a mini view.
- **Comparison "this month vs. last month"** — hours, top client, top activity.
- **Conflict-resolution UX sketch** as Markdown in the repo (no code) — a template
  for the Outlook import dialog, duplicate and overlap handling.

**Ship criterion:** You open the app and see at a glance how this week
compared to last month — without an Excel export.

---

## v1.11 — Master-Data Extension ✅ shipped (2026-04-30)

📂 [Plan](.github/plan-v1.12.md) (CEO plan: `~/.gstack/projects/time-tracking/ceo-plans/2026-04-30-v1.11-stammdaten.md`)

**Theme:** Complete client and project management — billing address, budget,
status, and contact person. The missing link between time tracking and
professional invoicing.

- ✅ **Migration 013** — `clients` +7 fields (address, VAT ID, contact person,
  email), `projects` +5 fields (ext. no., date, budget, status).
- ✅ **ClientFormModal + ProjectFormModal** — complete master-data forms.
- ✅ **PDF recipient block** — address lines, VAT ID, contact person conditional.
- ✅ **Budget mini-bar** — a color-coded progress bar on every project card.
- ✅ **Status badge** — a "Paused" badge on paused projects.
- ✅ **Budget warning banner** — a warning in the timer-start modal at ≥ 80 % budget usage.
- ✅ **Analytics tab** — Analytics dashboard with stat cards, DeltaPills, TrendChart,
  ClientBars, WeekdayBars (#93).

**Ship criterion:** You can store a billing address, VAT ID, and contact person per
client and the PDF shows a complete recipient block.

---

## v1.12 — Consistency Release ✅ shipped v1.12.0–v1.12.5 (2026-05-04)

📂 [Plan](.github/plan-v1.12.md)

**Theme:** Three friction points that show up in every invoicing run:
(1) the app shows different values than the PDF, (2) no project-specific contact person,
(3) tags grow uncontrolled. v1.12 solves all three without new concepts.

- **Project-specific contact person** (#105) — `projects.contact_person`,
  fallback to the client contact. The PDF recipient block uses the project contact when set.
  Migration 015. (S)
- **Rounding in the UI** (#106) — when rounding is active: calendar, TodayView, and
  analytics show rounded values (like the PDF). The DB data stays exact —
  a pure presentation layer. Optional: timer preview "1:23 → 1:30". (M)
- **Central tag management** (#107) — a new Settings submenu: create, rename,
  merge, delete tags. Usage count per tag. A closed
  tag system: free-text entry on the entry replaced by a dropdown. (L)

**Deliberately NOT in v1.12:** Widget overhaul (#108, → v1.13), bulk tagging,
rounding on the running timer, the widget with rounded values.

**Ship criterion:** You export an invoice. Calendar and PDF show
the same rounded values. The project-specific contact person appears in the
address block. In two minutes you clean up five outdated tags.

---

## v1.13 — Export Flexibility ✅ shipped v1.13.0 (2026-05-29)

📂 [Issues](https://github.com/wald-it/time-tracking/issues?q=is%3Aissue+milestone%3Av1.13)

**Theme:** Four friction points that appear when invoicing with multiple clients
or projects — export options, multi-timesheet merge,
fee consistency, and tag hygiene.

- ✅ **PDF export options** (#118) — selectable grouping (none / tag / project
  / reference), fee column hideable, project name per line in a
  client-wide analysis. The last settings are remembered.
- ✅ **PDF merge with multiple timesheets** (#119) — merge any number of
  timesheet PDFs in one go with an invoice (e.g. several
  projects of one client). Per-slot page count, order in the result:
  invoice → timesheet #1 → timesheet #2 → … Embedded files / XMP / OutputIntents of
  the invoice are preserved (factur-X / ZUGFeRD valid).
- ✅ **PDF export: billable + project hourly rate** (#120) — non-billable
  entries no longer produce a fee; the project-specific hourly rate is
  applied consistently everywhere (project → client → global).
- ✅ **Tag whitespace** (#121) — tags are trimmed before saving,
  the duplicate check now works correctly. Migration 017 normalizes existing
  tags retroactively.

**Ship criterion:** You have a client with three projects, export a timesheet per
project, and merge everything into one invoice — in
one dialog, without fee inconsistencies, without duplicate tags. ✅

---

## v2.0 — Outlook Integration 🎯 the real story stage

**Theme:** The one feature that turns TimeTrack from a "local Toggl clone" into a
"my calendar is the source of truth" tool.

- **Microsoft Graph API + MSAL Node** — Device Code Flow for the auth, because
  no server is needed with it (compatible with the ROADMAP directive "no cloud").
  One-time sign-in per Microsoft account, token in Electron `safeStorage` (DPAPI
  on Windows, Keychain on macOS).
- **Scope:** only `Calendars.Read` (delegated). No write, no mail, nothing
  writing. Office E1 / personal Microsoft account both supported.
- **Import flow:** Settings → Integrations → "Connect with Outlook" → auth browser
  tab → back to the app. Then: "Import Outlook" button opens a modal:
  choose range → preview list of the events → mapping columns (subject → client,
  body → description) → confirm → import.
- **Mapping rules** persisted: "Subject matched `^ACME` → client ACME".
  Settings → Integrations → manage mapping rules. The first rule can be created
  during import via a "Save this rule" checkbox.
- **Duplicate detection** via the Graph event `id` (in a new column `entries.outlook_event_id`,
  migration 011). Re-importing the same range recognizes already-imported events.
- **Recurring events:** each instance as its own entry. Canceled instances
  are soft-deleted on re-sync (`deleted_at` set).
- **Token refresh** automatically in the background. On an auth error: a banner "Outlook
  connection expired — sign in again", the import function disabled until then.
- **Offline-tolerant:** no internet → a clear error message, the app's main function
  unaffected.

**Ship criterion:** The maintainer imports a full month from Outlook,
maps it to his clients, exports the resulting PDF, and the hours
match Outlook. An OSS tester repeats this with their own
account.

**Deliberately NOT in v2.0:** Google Calendar (a separate API, a separate v2.x),
iCal import (differently structured, possibly v2.1), bidirectional sync (complex,
risk of overwriting data — read-only for now), multi-account (only
when someone asks for it).

**Effort estimate:** L–XL (~6–8 weeks, probably 3 PRs: auth → read-only import → mapping/recurring/refresh).

---

## Backlog (unscheduled)

Smaller edge cases / polish ideas without a concrete version. PDF entry merge (merge overlapping
entries) is in v1.8. PDF merge in the sense of "attach to an invoice PDF"
is the v1.7 hero — do not confuse them.

- **Pomodoro mode** (#23) — 25/5 opt-in. No personal need, no OSS user has explicitly asked for it. Stays here until someone really needs it.

- **Google Calendar import** — analogous to Outlook, its own API. Only after v2.0,
  when the Outlook flow is stable and the mapping UX has been validated.
- **iCal import** (`.ics` file) — for Apple Calendar, Thunderbird, others.
  Simpler than OAuth flows, possibly v2.1.
- **Code signing** for Windows — stays deliberately out (directive from v1.5).
  If an OSS user offers sponsoring (~250€/year EV cert), it will be re-evaluated.
- **Plugin architecture** — explicitly REJECTED. A complexity jump that breaks the
  solo-maintenance directive. Whoever needs a custom feature forks.

---

# Multi-Angle Review

## CEO view (strategy & focus)

**Premise check:** The user is you yourself (skoedr). Job-to-be-done: reliably record hours for
invoices. The biggest current pain: forgetting the hotkey → no entry, or
forgetting the lunch break → wrong entry. Hence idle detection as the v1.1 top priority,
not only v1.4. ✅ The roadmap is right.

**6-month regret test:** What would annoy you the most in 6 months for not having
done it?

1. If idle detection is missing → you do not trust your own data → return to Excel
2. If DB migrations are missing → the v1.2 update breaks v1.0 installs → data loss
3. If auto-backup is missing → one disk crash wipes out months of work

All three are covered in v1.1. ✅

**What is NOT in the roadmap (deliberately):**

- Cloud sync, multi-device → user directive: stay lean
- Multi-user / team features → not the use case
- Mobile app → no added value for the desktop workflow
- Stripe / payment → no monetization planned
- Collaboration / sharing → a solo tool

**What is missing but should be in?**

- ⚠️ **Data export / data portability** as an explicit feature. Currently: copying the SQLite
  file works, but there is no documented "Export all data as JSON" button.
  Trust-building when you want to switch later. Suggestion: add to v1.3.

## Design view (UX & hierarchy)

**Information hierarchy:** Correctly ordered. Tray quick-start (the most frequent use case) comes
in v1.1, mini widget (the second most frequent) in v1.4. Idle detection (the most critical) in v1.1.
Calendar (rarely used but important when) in v1.2. ✅

**Missing UI states in the roadmap:**

- Calendar without data: an empty month, what does the user see?
- Settings: without backups there is no "Restore" option yet
- Update available: banner position, dismiss behavior?
- Pomodoro break modal: what if the user ignores the break?

→ define all of them at the respective stage, not only when implementing.

**Mini-widget format:** The roadmap says 200×40. Alternative: 80×80 square (fits better
in a screen corner). **Taste decision — see below.**

**Onboarding in v1.5 is too late.** If you show someone v1.1 today, there is already nothing.
**Recommendation:** Move the onboarding wizard up to v1.2, when the app first feels "rounded".

## Eng view (architecture & risks)

**Architecture risks:**

1. **DB migrations are a v1.1 must, not "nice to have".** As soon as v1.2 extends the
   `entries` table (e.g. a `tags` column or a new `type` column for
   Pomodoro breaks), it breaks v1.0 installs. Recommendation: the migration mechanism
   is the first story in v1.1.

2. **Auto-update server choice.** electron-updater supports:
   - GitHub Releases — free, your PAT as the token, latest.yml is already there
   - Generic HTTP — your own server needed, you do not want one
   - S3 — free in the free tier, but AWS account hassle
     → GitHub Releases is the only sensible choice. Already prepared, since
     `dist/latest.yml` is already in the release.

3. **PDF library choice.**
   - `pdfkit` — pure JS, ~5MB, programmatic, good tables, boring default layout
   - `pdf-lib` — pure JS, ~2MB, low-level, you build everything yourself
   - `puppeteer` — Chrome-headless via HTML/CSS, nice layouts, +200MB installer
     **Taste decision — see below.**

4. **Idle-detection library.**
   - `desktop-idle` — a native N-API module, gives seconds since the last input. Small, simple.
   - Electron's own `powerMonitor.getSystemIdleTime()` — already built in. ✅ No extra dep.
     → use powerMonitor. Auto-decided (P4 DRY: already in the stack).

5. **Tags schema.**
   - a JSON column `tags TEXT` with `["a","b"]` — simple, no joins
   - separate `tags` + `entry_tags` tables — normalized, slower queries for solo use
     → JSON column. Auto-decided (P5 explicit: 5 lines vs 50, solo scale).

6. **Code signing for Windows.** Without signing, Windows SmartScreen shows "Unknown
   publisher" on the installer. Costs:
   - **OV certificate:** ~70€/year (e.g. Sectigo via SSLs.com)
   - **EV certificate:** ~250€/year, but instant SmartScreen reputation
   - **Without signing:** a warning on every installation, the user must "Run anyway"
     **Taste decision — see below.**

**Test gaps in the roadmap:**

- Currently: 0 automated tests in the repo. At v1.2 (edit logic with date parsing)
  and v1.3 (PDF generation) this becomes painful. **Recommendation:** introduce Vitest in v1.1,
  primarily for `src/main/db.ts` (migrations, IPC handlers) and date utils.

**Failure-modes registry:**

| Where          | What breaks                            | When                   | Mitigation                               |
| -------------- | -------------------------------------- | ---------------------- | ---------------------------------------- |
| Auto-update    | GitHub API down                        | on every update check  | Silent fail + log, retry next day        |
| Idle detection | User clicks "Pause", app crashes before | rare                  | Auto-backup (v1.1) covers it             |
| PDF export     | Path not writable                      | OneDrive sync conflict | Fallback to `Documents`, toast           |
| Migration      | SQL error in a migration               | Schema bug             | Backup before migration, rollback on fail |
| Tray           | Icon not loadable                      | User deletes resources/ | Fallback without tray, console warning   |

## DX view

Skipped — no developer-facing scope (a solo tool, no API/CLI/SDK for other devs).

---

# Decision Audit Trail

| #   | Phase  | Decision                              | Classification | Principle | Rationale                                                               |
| --- | ------ | ------------------------------------- | -------------- | --------- | ------------------------------------------------------------------------ |
| 1   | CEO    | Cloud/multi-user out of the roadmap   | Mechanical     | P6        | User directive "stay lean"                                              |
| 2   | CEO    | Idle detection in v1.1 (not later)    | Mechanical     | P1        | The biggest trust pain point, boil the lake                            |
| 3   | CEO    | Add a data-export button in v1.3      | Mechanical     | P1        | Data portability = trust                                               |
| 4   | Eng    | DB migrations a v1.1 must             | Mechanical     | P2        | Prevents v1.0→v1.2 data loss                                           |
| 5   | Eng    | Auto-update via GitHub Releases       | Mechanical     | P3        | The only sensible choice, already prepared                            |
| 6   | Eng    | Idle detection via powerMonitor       | Mechanical     | P4        | DRY, already in the electron stack                                    |
| 7   | Eng    | Tags as a JSON column                 | Mechanical     | P5        | Solo scale, 5 lines instead of 50                                     |
| 8   | Eng    | Introduce Vitest in v1.1              | Mechanical     | P1        | Critical before v1.2 edit logic                                       |
| 9   | Design | Move onboarding up to v1.2            | Mechanical     | P5        | v1.5 too late                                                         |
| 10  | Design | PDF library: **puppeteer**            | User taste     | —         | Nicer layout more important than installer size. Result: ~290MB instead of 96MB |
| 11  | Design | Mini widget: **200×40 horizontal**    | User taste     | —         | Toggl style, fits in screen edges                                     |
| 12  | Eng    | Code signing: **never**               | User taste     | —         | The SmartScreen warning is accepted, money saved                      |
