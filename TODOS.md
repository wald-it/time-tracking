# TODOS

Deferred items from plan reviews. Items here have explicit decisions — they are NOT forgotten, they are scheduled.

## Delivered (this section was headed "Open Issues")

*State checked 2026-08-31: **#87, #93 and #94 are all `CLOSED/COMPLETED`** — the heading claimed otherwise. The items are kept rather than deleted because the scope paragraphs below are now the only surviving record of what was decided: the `~/.gstack/projects/time-tracking/…` CEO- and test-plan files they cite were removed together with the gstack suite on 2026-08-28 and are gone. What those plans held beyond these paragraphs is **not reconstructible**; what actually shipped is in [CHANGELOG.md](./CHANGELOG.md) under v1.10 and v1.11. Recorded rather than quietly dropped, because this file opens by promising that its items carry explicit decisions.*

- **#87 — UI centering across views** (Optional polish) — Basiszentrierung implementiert in v1.8.1 (`max-w-4xl mx-auto` auf SettingsView-Wrapper). Optional: pixelgenaue Werte via `max-w-[740px]` / `max-w-[600px]` statt Tailwind-Tokens für Today/Timer/Calendar/Clients. → v2.0 candidate.

- **#93 — Auswertungs-Tab (Analytics Dashboard)** — Implementierung in `feat/v1.10-analytics` geplant. Scope definiert via /plan-ceo-review + /plan-eng-review (2026-05-11). CEO-Plan: `~/.gstack/projects/time-tracking/ceo-plans/2026-05-11-v1.10-analytics.md`. **In v1.10 Scope:** Neuer Auswertungs-Tab, Monatsnavigation, Stat-Cards (Stunden/Umsatz/Billable%), DeltaPills, TrendChart (Wochen+Monate-Toggle), ClientBars, WeekdayBars, EmptyState. **Deferred aus v1.10:** Tags-Panel (#93-follow-up), Hochrechnung/Forecast-KPI (#93-follow-up), PaceBlock (benötigt Settings-Schema-Change → v1.11 candidate).

- **#94 — Stammdaten-Erweiterung Kunden + Projekte** — **In v1.11 Scope.** CEO-Plan: `~/.gstack/projects/time-tracking/ceo-plans/2026-04-30-v1.11-stammdaten.md`. Test-Plan: `~/.gstack/projects/time-tracking/robin-main-eng-review-test-plan-20260430-165752.md`. **Phase 1 — Stammdaten-Core:** Migration 013, Client-Felder (Adresse 1-4, VAT, Kontakt, E-Mail), Projekt-Felder (ext. Nr, Datum, Budget-Minuten, Status active/paused/archived), ClientFormModal + ProjectFormModal, PDF Empfängerblock (konditionell), Budget-Mini-Bar in QuickStart, Status-Badge auf Projekt-Card, Budget-Warn-Toast beim Timer-Start. **Phase 2 (eigener PR):** Analytics Burndown + billing_type-Migration (#93-follow-up). PR-Sequenz: PR1/3 DB+Types+IPC, PR2/3 UI+PDF, PR3/3 Budget-UX.

### Deferred from #79 /autoplan Final Gate (v1.9.5)

*#96 below is `CLOSED/COMPLETED` as well (checked 2026-08-31); only **T1** has no issue and no recorded state.*

- **T1 — UNC-Pfad-Support für Backup-Pfad** (Medium effort) — Wenn `backup_path` ein UNC-Pfad (z.B. `\\nas01\backups`) ist, soll eine explizite Fehlermeldung erscheinen wenn der Pfad nicht erreichbar ist, statt silent fail. `mkdirSync` auf UNC unter Windows benötigt gesondertes Handling. → v1.10

- **#96 — Quick Start 2.0: Last-Used Combo + Press-and-Hold Project Fan** — Pill zeigt letztes genutztes Projekt als Subtitle; Tap = sofort starten, Press & Hold (~300ms) = radialer Fächer öffnet sich mit allen Projekten des Kunden. Mini-Widget: nur Tap (kein Fächer). Keine neue DB-Tabelle nötig (letztes Projekt aus entries-History). → v1.10

### Deferred from #75 /autoplan Phase 1 (CEO Cherry-Picks)

~~- **E1 — Auto-color-shift für Projekte**~~ → Resolved in v1.9.6

~~- **E5 — Project-Quick-Stats in ClientsView**~~ → Resolved in v1.9.6

### Design-Gespräche ausstehend

~~- **Merge modal Nav-Trigger**~~ → Entschieden und umgesetzt in v1.16.0 ([#153](https://github.com/wald-it/time-tracking/issues/153)). Nicht als „zweiter Einstiegspunkt": beide Modals hingen an der Kalenderansicht, ohne kalenderspezifisch zu sein, also ist die ganze Toolbar in einen eigenen `Export`-Tab gezogen. Der Kalender ist jetzt nur noch Kalender.

- **Competitive positioning** — README + App-Beschreibung auf LocalFirst / Datenschutz / Kein-Abo schärfen. Kein Code, nur Text. Gespräch ausstehend.

### v1.13.2 Follow-ups (aus /ship-Review 2026-07-17)

- **SettingsContext Split-Context-Refactor** — `SettingsContext` in Read-/Write-Context aufteilen und Provider-Value memoizen, damit `setSetting`-Writes nicht alle `useSettings`-Konsumenten re-rendern (Perf-Finding aus v1.13.2-Review, Confidence 8/10). **Vereinbart:** eigener PR #2 in v1.13.2, Merge nach dem Persistenz-Fix-PR, Release erst danach.

~~- **Smoke-Test nutzt Live-DB** (Red-Team-Finding, pre-existing seit v1.2) — `--smoke-test` öffnet die produktive `userData`-DB, migriert sie ggf. und löscht via `DELETE FROM clients WHERE id = 9999` — ein echter Kunde mit id 9999 würde Daten verlieren (Seed nutzt `INSERT OR IGNORE`). Fix: `app.setPath('userData', tmpdir)` vor `getDb()` im Smoke-Pfad, oder Seed in einer immer zurückgerollten Transaktion. → Housekeeping-PR.~~ → Erledigt (2026-10-22, `fix/smoke-test-temp-userdata`): Am Stand v1.20.0 noch zutreffend verifiziert — `getDb()` las `app.getPath('userData')` ohne Override, und weil der Smoke-Modus die Single-Instance-Sperre bewusst überspringt, lief er sogar neben einer laufenden App auf derselben DB. Jetzt setzt `src/main/index.ts` beim Modul-Laden, vor `ready`, `userData` auf ein frisches `mkdtemp`-Verzeichnis (`timetrack-smoke-*` im OS-Temp); unmittelbar vor `getDb()` bricht ein Guard den Lauf mit `ok:false` ab, wenn `userData` gleich dem oder unterhalb des Standard-`userData` liegt (geprüft gegen den Wert vor dem Override und gegen `appData/<app-name>`). Aufräumen: DB schließen, Verzeichnis löschen; unter Windows hält Chromium sein Profil bis Prozessende offen, deshalb übernimmt dann ein abgekoppelter Aufräumer (App-Binary im Node-Modus, wie `mcpLaunch.ts`) das Löschen nach dem Exit. Logik und Tests in `src/main/smokeUserData.ts`.

### Nächster Hotfix (technisches Housekeeping) → eigene PR vor v1.12

- **Handler extraction: pdf:merge-export** — `pdf:merge-export` in `ipc.ts` noch im alten Inline-Stil; in `pdfMergeHandlers.ts`-Muster überführen für testbarere Struktur. Kein User-Value, aber sauberer.

- **DB-Cleanup: tote Rounding-Settings** — `rounding_mode` und `rounding_minutes` wurden aus UI + Types entfernt (v1.11, 2026-04-30), stehen aber noch als Rows in der `settings`-Tabelle (gesät von Migration 001). Migration 014 ergänzt `DELETE FROM settings WHERE key IN ('rounding_mode', 'rounding_minutes')` als Cleanup-Statement.

### Kleinkram (aus /ship-Review v1.14.2, 2026-07-25)

~~- **Redundante `@electron/rebuild`-devDependency**~~ → Erledigt (2026-07-26, `chore/release-pipeline-v115`): Verifiziert, dass `pnpm exec electron-rebuild -f -w better-sqlite3` ohne die devDependency weiter auflöst — `@electron/rebuild@4.0.4` kommt transitiv über electron-builder (`app-builder-lib`) und wird dank `node-linker=hoisted` nach `node_modules/.bin` gehoistet. Danach aus `package.json` entfernt.

~~- **RunAsNode-Fuse-Abhängigkeit dokumentieren**~~ → Erledigt (2026-07-26, `chore/release-pipeline-v115`): Kommentar an der Fuse-Aktivierungsstelle in `electron-builder.yml` plus Querverweis im Kopfkommentar von `src/main/mcpLaunch.ts`.

### v1.12 Issues (aktiv geplant)

~~- **#105 — Projektspezifischer Ansprechpartner**~~ → Abgeschlossen (v1.12.0, 2026-05-04)
~~- **#106 — Rundung in der UI**~~ → Abgeschlossen (v1.12.0, 2026-05-04)
~~- **#107 — Zentrales Tag-Management**~~ → Abgeschlossen (v1.12.0, 2026-05-04)

### v1.13 Kandidaten (deferred aus v1.12)

- **#108 — Widget-Overhaul** (XL) — Arc Quick-Start Design für Mini-Widget adaptieren.
- **Rundung am laufenden Timer** — gerundeter Wert in Echtzeit sichtbar neben exaktem.
- **Bulk-Tag-Operationen** — mehrere Einträge gleichzeitig taggen.
- **Tag-Aufschlüsselung in Analytics** — Top-5-Tags-Breakdown in Auswertungs-View. Deferred: erst wenn Tags im Live-Einsatz sind, lohnt sich der Analytics-Ausbau. (plan-ceo-review 2026-05-04, D7)
- **Widget zeigt gerundete Werte** — nach Widget-Overhaul.
- **Stammdaten-Import aus CSV** — für Großkunden mit vielen Projekten.
- **Tag Force-Delete** — Tag löschen auch wenn Einträge vorhanden (mit Warnung).
- **Tag-Filter** — Klick auf Anzahl → gefilterte Eintrags-Liste.

## Resolved in v1.9.0

- ~~**#75 — Projekte pro Kunde**~~ — Abgeschlossen (v1.9.0, 2026-05-02): Migration 012, `projects`-Tabelle, vollständige CRUD-UI in ClientsView, projektbewusste Timer/Today/Calendar/EntryEditForm, projektgefilterter PDF- + CSV-Export. **Completed:** v1.9.0

## Blocking v1.7 — RESOLVED

- ~~**Workflow-Gap: Stundennachweis vor Rechnung**~~ — Implementiert (2026-04-27): `pdfMergeValidation.ts`, `pdfMergeHandlers.ts`, `PdfMergeModal.tsx`, CalendarView trigger. 201 Tests grün, 0 TS-Fehler.
- ~~**Test-Isolation: gespiegelte Validierungslogik**~~ — Behoben: Extraktion nach `pdfMergeValidation.ts`, Umbennung `validateInvoicePath` → `validatePdfPath`, ipc.test.ts importiert nun aus shared module.

## Deferred from v1.7 (/autoplan 2026-04-26)

- ~~**Auto-detect watched folder for invoices**~~ — Zurückgestellt indefinitely. Kein fixer Lexware/sevDesk-Standardpfad; Nutzen noch nicht validiert.
- **Multi-invoice support** (Low priority) — Attach multiple Stundennachweise to a single invoice, or vice versa. Surfaces when agencies/multi-project freelancers use the feature. → Post-v1.8 based on user feedback.
- ~~**Preview before merge**~~ — Included in v1.7 via `pdf:pdf-info` handler + page count row in `PdfMergeModal`. Removed from backlog.
- ~~**Full i18n DE/EN pass**~~ — Shipped in v1.8.0. All views, components and mini-widget migrated.
- ~~**Competitive positioning**~~ → Kein Issue, Gespräch ausstehend (siehe oben).
- ~~**Merge modal: Nav sidebar trigger**~~ → Erledigt in v1.16.0 über den eigenen `Export`-Reiter ([#153](https://github.com/wald-it/time-tracking/issues/153), siehe oben).
- **Handler extraction: pdf:merge-export** → Verschoben in »Nächster Hotfix« (siehe oben).
- **Type guard hygiene: `filePath` input in PDF handlers** (Low) — `pdfInfoHandler` und `mergeOnlyHandler` casten `r.filePath as string` ohne expliziten `typeof`-Check. Beide fallen sicher. → v1.9 candidate.
