# Changelog

All notable changes to TimeTrack are documented here.

> **Language note:** Entries up to v1.15.1 are in German (historical record);
> from v1.16.0 onward, entries are written in English.

## [Unreleased]

### Changed

- **MCP write tools name the field limits they enforce** — The write bridge rejects a `description` over 500 characters and a `private_note` over 1000, but nothing said so before the call. The limits live in `validateManualEntry`, which the tool schemas never mentioned, so a consumer met them as an error after composing the text — and an AI client had no way to trim beforehand. `create_manual_entry` and `update_entry_fields` now carry both numbers in their parameter descriptions.

  `start_timer` deliberately says nothing, although it also takes a `description`: its path does not run that validation, so no limit is enforced there. A documented limit nobody applies would be a promise the server does not keep — worse than saying nothing, because someone would rely on it.

  The same validation enforces two more limits, now named as well (#226): `reference` at 200 characters in both write tools, and the 24-hour cap on an entry's span, stated on `stopped_at` because it constrains the distance to the start rather than either timestamp alone. A new test pins every stated figure to the constant that is actually enforced, so the literals in the schema can no longer drift unnoticed.

## [1.19.0] — 2026-08-27

### Changed

- **MCP tool outputs: consistent totals and targeted lookups (#205)** — An eval run of the MCP server surfaced places where a consumer works incorrectly or awkwardly without anything crashing. The core trap: `list_entries.total_seconds` is the unrounded wall-clock sum, while `get_analytics.total_seconds` rounds each entry like the PDF export — two different answers to "how much time?", with nothing saying which one is canonical. Both tool descriptions now spell out the difference and point billing questions to `get_analytics`; the `get_analytics` description also names the response field as it actually appears (`rounding_minutes`, not the internal setting name `pdf_round_minutes`).

  Three more gaps closed: `by_project` rows now carry the project's `client_id`, so same-named projects across clients no longer have to be told apart by name. `list_clients` and `list_projects` accept substring filters (`name`, `contact_person`, `external_project_number`) instead of forcing a full list scan for every lookup. And `list_entries` now reports `count` and `total_seconds` over **all** matches even when the `entries` array is capped by `limit` — previously a capped list silently shrank the totals with it — plus a `summary_only` mode that skips the entries entirely when only the totals are wanted. `get_analytics` additionally reports `distinct_client_count`, and its breakdowns are guaranteed sorted by `seconds` descending.

### Fixed

- **Updates no longer stall on TimeTrack's own MCP server (#198)** — With the MCP integration set up, installing an update could fail with _"TimeTrack cannot be closed. Please close it manually and click Retry"_ — an instruction nobody could follow, because the app **was** closed. The blocker was a windowless child process: an MCP server runs the installed binary in Node mode (that is how it shares the app's native SQLite ABI), so it holds `TimeTrack.exe` open. It belongs to an AI client, has no window and no tray icon, and carries the app's own executable name under a foreign parent process — from the outside there is nothing to see and nothing to close.

  Both update paths now ask before anyone kills anything. Every MCP server registers itself under `<userData>/mcp-holders` and watches for a shutdown request; on one it closes its transport and exits by itself, which its client sees as a clean end rather than a crash. The in-app updater writes that request before handing over to the installer and **refuses to hand over at all** while anything is still holding on — naming the surviving processes instead of walking into an install that must fail. The Windows installer writes the same request before its own app-running check, so a manually started update gets the same cooperative path.

  Two things this uncovered are worth recording. The in-app update path had **no** app-running check to begin with: electron-builder's NSIS skips it entirely when the installer's parent process is the app itself, which is exactly what `quitAndInstall` makes it — the app is trusted to have exited, and its MCP children were never covered by that assumption. And killing would not have been a fix anyway: whoever kills a process whose lifecycle belongs to a client is racing that client's restart. In a measured run the race was decided by 22 milliseconds.

  Not fixed here: why electron-builder's own check failed in the original report. Its process detection has two branches, and the probe that chooses between them reports "PowerShell unavailable" on a machine where PowerShell demonstrably works, which drops it onto a fallback whose first attempt is a window message that a windowless process cannot receive. Tracked as #199. The handshake deliberately does not depend on that probe.

- **The MCP update handshake no longer trusts the wall clock or a pid alone (#201)** — Follow-up to #198, addressing the weakness cluster its pre-landing adversarial review identified. The shutdown request now carries a **nonce**, and a server exits when the nonce it saw at startup _changes_ — instead of comparing the request timestamp against its own start time. A backward clock step between server start and update no longer makes running servers ignore the request (which blocked the update while the message blamed the AI client), and a stale forward-dated request file is no longer a standing kill switch that needed a skew clamp: under nonce gating it is simply the baseline. `requestedAt` is still written for servers of v1.18 and earlier, which gate on it.

  Liveness of a pid is no longer identity. Before the updater counts a registration as a blocker, it compares the live process's image path against the registered binary — one WMI query on Windows, which also answers for elevated processes, exactly the case where the liveness probe degrades to "alive" and a reused pid used to become a permanent holder. A registration whose pid was reused by an unrelated process after a hard kill is pruned instead of blocking every future update.

  Smaller holes closed along the way: when an AI client respawns its server mid-update, the app re-issues the request with a fresh nonce so the newcomer is asked too, and the refusal message now says when a survivor was started during the update instead of blaming it for ignoring a request it never received. The installer hands the holder path to PowerShell through the environment instead of splicing it into a quoted literal (a profile path containing `'` broke the parse), and the server polls the request file asynchronously, so a userData directory on a dead network share no longer wedges its event loop. The updater status tests now exercise the real transition function instead of a hand-maintained mirror of it.

- **An update can no longer offer to move the installation somewhere else (#200)** — Running the v1.18.0 setup over an existing v1.18.0 install could show a directory page, as though nothing were installed. It looks like an ordinary first-time install, but choosing a different directory there runs the old uninstaller first — so typing something else silently orders the removal of an installation nobody meant to touch. It happened once, on 2026-08-03, during a routine update. (User data under `%APPDATA%\time-tracking` was never at risk; the damage was limited to the program directory.)

  The installer decides upgrade-or-fresh from a single registry value recording where TimeTrack lives. Why that value went missing is not recoverable — the state was overwritten twice before anyone looked — so instead of guessing at the cause, the app now checks that value on every start and repairs it when it is missing or points at the wrong place. That closes the trap whatever emptied it, and it self-corrects machines already in the broken state.

  It repairs only what it can be sure of. If a per-machine record exists and disagrees, or the app runs from a per-machine location with no such record, it writes nothing and logs why: only an elevated process may correct those, and a fabricated record is worse than a missing one — the installer acts on what it finds. The question of what emptied the value in the first place stays open in #200.
- **Links and the privacy statement point at the new repository home (#210)** — The move to the `wald-it` organisation (#203) repointed the update feed and most links, but six live references stayed on the old owner: the About dialog's GitHub link, the in-app button to the releases page, the Stream Deck plugin's install instructions, the security-advisory address, the Discussions link — and `PRIVACY.md`, which mattered most. It does not link to the update endpoint, it *names* it, and since the transfer it named a URL that new builds no longer call. A privacy statement is the one document where “the redirect handles it” is not an answer, so it now states the endpoint the app actually queries.

  Historical references in the changelog, the roadmap and old issue links deliberately stay as they are — they record what was true then, and the redirect covers them. The MIT copyright holder is a name rather than a link and is untouched.
- **Dead MCP registrations no longer pile up, and the installer's own guard works again (#209)** — Every bundled MCP server registers itself in a directory the updater reads. A server that is *asked* to exit withdraws its registration; one that is killed instead — an AI client restarting, a hard kill, a crash — left its file behind. The registry did have pruning, but only the update path ever reached it, and updates are rare next to server starts. Measured before the fix on the maintainer machine: 65 registrations, 56 of them belonging to processes that had exited, the oldest three weeks old.

  The visible cost was carried by the Windows installer. It decides whether to run the shutdown handshake at all by counting those files, and it runs before the app, so it has no way to check whether any of them are alive. Once a machine had ever run a server that count was permanently non-zero — so the guard built to skip the handshake on installs with no MCP integration never fired again, and the wait that follows it polled for a count of zero it could never reach, spending its full eight-second deadline on every single install.

  Servers now clear out their dead predecessors when they register, and the app does the same on start. The pruning logic itself is unchanged — this is about calling it somewhere that happens often.
- **Two tests no longer depend on what time of day they run (#213)** — Internal only, but it cost a release triage a false alarm: the suite was green all day locally and red in CI whenever a run started early in the UTC morning. Both tests built their fixture backwards from `now` and then asserted a fixed number, which quietly assumed the clock was past a certain hour — an entry “6h24m ago” lands on *yesterday* before 06:24 and drops out of today's window entirely. Freezing the clock would not have helped: a running entry is measured with SQLite's own `now`, which `vi.setSystemTime()` does not move. The assertions are now phrased in terms of what the current hour actually permits, and the closed-entry fixture is built forwards from local midnight. No production behaviour changed.

## [1.18.0] — 2026-08-02

### Added

- **The timer dial for Stream Deck + (#186)** — One dial reaches every timer target, with nothing to configure. Idle, it shows the two numbers from the app's _Heute_ page — hours today and this week — plus the entry a press would start, so a press is never blind. Turning walks the projects and the clients that have none; a short press starts that target, or stops it if it is the one running. A long press starts the same **client without a project**, which is why clients that have projects never appear on their own: the list stays as short as the things you actually book on. While a timer runs, the strip shows client, project and elapsed time with the minute ring and the pulse from the key faces.

  The numbers come from the same function the app's page uses, including its rounding — an earlier version rendered the raw seconds and read 6:24 against the app's 6:30.

- **The Stream Deck plugin now ships with the release (#192)** — Hardware keys have existed since v1.17, but only as source: using them meant cloning the repo and building the plugin yourself. Every release now carries **`com.timetrack.streamdeck.streamDeckPlugin`** — download, double-click, done. **Settings → Integrations → Hardware keys** links to it. It stays out of the app installer on purpose: the Stream Deck app manages its own plugin directory.

  Why it took this long is worth recording: Elgato's `validate` rejects manifest icons that are not PNG, and the plugin's were SVG. It could never be packed — and nothing said so, because nobody had run `validate`. The icons are now generated from the SVG sources, and both validating and packing run on every pull request instead of first at release time.

### Changed

- **The week starts on Monday, and is now a setting (#188)** — TimeTrack disagreed with itself: the week total counted from Sunday, while the export quick filters, the calendar grid and the KW chart already counted from Monday. **Settings → General → Week starts on** now decides for the week total (page, tray, Stream Deck, MCP), the quick filters and the calendar grid, and it defaults to Monday for every installation.

  **Your week total will therefore change once.** Set it back to Sunday if you prefer the old count. The KW axis in Auswertung stays Monday-based whichever you pick — ISO 8601 defines the calendar week that way, so a Sunday-anchored `KW32` would be a wrong number rather than a preference.

### Fixed

- **The week total counted eight days on Sundays** — The window was computed as "advance to the coming Sunday, then step back seven days", which is right on six days out of seven. On the boundary day itself the first step does nothing, so the second lands a full week early. Every Sunday, the week total silently included the Sunday before it as well.

## [1.17.0] — 2026-07-29

### Added

- **Hardware keys: a Stream Deck plugin (#133)** — One key = one timer target. Each key is configured with a client (and optionally one of its projects) and toggles the timer for exactly that target; the key face shows the live state. The plugin (in `streamdeck-plugin/`, TypeScript on the official Elgato SDK v2) talks to the app through the local bridge with its **own token scope**: key presses skip the confirmation dialog — the physical press _is_ the confirmation — which is exactly why the MCP token cannot call the new controller operations and vice versa. Everything else from the guarded write path stays: opt-in in **Settings → Integrations → Hardware keys**, audit log, backups, webhooks. No Stream Deck needed to try it: the plugin works with Stream Deck Mobile's free tier.

  The key faces carry the app's glass look (from a high-fidelity design handoff): elapsed time as `h:mm`, a minute ring that sweeps like a clock hand, and the client color normalized in OKLab so white text stays readable on any color you picked. Hardware taught us its rules along the way — the deck rasterizes static frames (no SVG animation, no `pathLength`), so the ring and pulse are animated frame-by-frame within the SDK's documented budget.

  Platform decision, recorded on the issue: the endpoint is platform-neutral and every console is just an adapter. A Logi Actions adapter (MX Creative Console / Loupedeck) is tracked as #179; the Razer Stream Controller is out of scope — its platform is being sunset.

- **Teams presence mirroring (#132)** — While a timer runs, Teams shows you as **Busy (red)** with a status message ("🔴 Fokus" — or, opt-in, with client and project name); both disappear when the timer stops. Opt-in under **Settings → Integrations** inside the Microsoft-account block, work/school accounts only (Microsoft's presence APIs do not support personal accounts). A manually set Teams status always wins, and the feature only ever clears messages it set itself. Presence failures never affect the timer — they are logged and retried on the next state change. The additional permission (`Presence.ReadWrite`) is only requested once you enable the feature: reconnect once, done.

- **Subscribable calendar feed (#169)** — Stage 2 of the iCal story: a local `webcal://` feed serves the last 90 days of completed entries for calendar clients to poll — token-protected, `127.0.0.1` only, running only while the app runs. Enable it under **Settings → Integrations → Calendar feed**, copy the URL, subscribe. The token is persistent (calendar clients store the URL); regenerating it invalidates every existing subscription, and the settings say so before you do it.

  **Known limitation, stated next to the toggle:** the new Outlook and Outlook on the web fetch subscriptions through the Microsoft cloud and cannot reach a local feed — use classic Outlook, Thunderbird, or Apple Calendar. The M365-native path (writing entries into the calendar via Graph) is tracked as #181.

### Fixed

- **External timer changes now show up in the app immediately** — The bridge has broadcast a change signal since the MCP write mode (#127), but nothing ever listened: a timer started from outside was invisible in the app and could not be stopped there. The renderer now resyncs on every external write, which keeps the app, tray, mini-widget and idle watcher consistent — for MCP writes and hardware keys alike.
- **Projects are validated against their client on every write path** — `start_timer` via MCP accepted any `project_id` unvalidated; a project belonging to another client could be attached to an entry. The project↔client check is now enforced centrally (manual entries, updates, timer starts, hardware-key toggles).

## [1.16.1] — 2026-07-29

### Added

- **Calendar import: domains can map to a client AND a project (#176)** — Found in a hands-on test right after v1.16.0: a meeting with an end customer's domain may be billed via a consulting client but belong to that client's **project** for the end customer. Domain → client alone could not express that, and the import dialog had no project selection at all — the project had to be set by hand on every imported entry.

  The dialog now shows a project dropdown per row (only when the chosen client has active projects, same as the timer modal), pre-filled from the learned mapping, and the learn checkbox couples the currently selected **combination** to the domain. The project follows the same principle as the client: it is only pre-selected when all of a meeting's mapped domains agree on it — never guessed. A project from another client is rejected on both the learning and the import path, because it would book time onto the wrong customer.

  Checkbox behavior, decided on #176: a **new** domain still defaults to ON (the #130 decision), but deviating from an **already-learned** mapping shows the checkbox default OFF — a one-off exception must not silently re-learn the rule. While the selection matches what is stored, no checkbox appears at all. Deleting a project keeps the client half of its mappings (`ON DELETE SET NULL`); deleting a client still removes them entirely.

## [1.16.0] — 2026-07-29

### Added

- **Connect a Microsoft account (#130, part 1 of 3)** — Under **Settings → Integrations** you can connect a Microsoft account: click "Connect Microsoft account", sign in in the browser, consent, done. This is the foundation for the calendar import; **nothing is imported yet** — this part only sets up the connection. A "Check connection" button asks Microsoft whether the permission really still holds, instead of just claiming that something is stored.

  TimeTrack requests **read**-only rights to the calendar (`Calendars.Read`) and never writes to it. The sign-in runs directly between the app and Microsoft — there is no server in between, and no credentials leave the machine. Works with work and school accounts as well as with personal Microsoft accounts.

  **Privacy:** The refresh token is stored encrypted via the operating system's secure storage (DPAPI on Windows, Keychain on macOS) in its own file next to the database — deliberately **not** in the database itself, so that it does not travel into every backup and end up on other people's machines on restore. If no secure storage is available (on Linux typically a missing keyring), TimeTrack refuses to save with an explanation, instead of silently storing it in plaintext.

  **Known limitation, not a bug:** As long as wald-it is not a Microsoft-verified publisher, users in **other** company tenants cannot consent to the app themselves — there "Approval by an administrator required" appears. This is an Entra policy for multi-tenant apps that request more than the basic sign-in. Anyone who wants to use their own app registration can enter their own application ID under **Advanced**.

- **Import appointments (#130, part 3 of 3)** — The Calendar view has a new button: **"Import appointments"**. Pick a date range, load, and the Outlook events of that range appear as draft entries — subject, times, and the client detected from the attendees' mail domains. Nothing is imported automatically: every event is confirmed individually, and events whose client could not be detected say why (unknown domain, no external attendees, or attendees from several known clients) and wait for you to pick one.

  When you assign a client to an event with a not-yet-known domain, a checkbox **"Assign this domain to this client from now on"** appears — checked by default, so the common case costs no extra click, but always visible: mappings are never created silently, because a single wrong silent mapping would quietly misassign every future meeting with that counterpart. Learned mappings make the next import pre-select the client on its own.

  Each event is committed on its own: if one of five selected meetings overlaps an existing entry, you get four new entries and one explained failure instead of five failures. Already-imported and filtered events (all-day, declined, marked as free) are listed collapsed with their reason — they explain, they don't nag. Deleting an imported entry frees its event again for a later import.

### Changed

- **Export is now its own tab (#153)** — The export window was reachable exclusively via the time-range buttons in the **Calendar** view, and merging PDFs via another button next to them. Nowhere in the navigation did "Export" appear: whoever looked for it found nothing, and an automated pass of v1.15.0 found nothing either. With the iCal export (#135) this weighed more heavily than before, because its whole purpose is a permanent second calendar layer — you look for it under "Export", not under "This month". There is now an **Export** tab between _Analytics_ and _Settings_ that houses both paths: timesheet/CSV/iCal on top, merge PDFs below. The buttons themselves are unchanged — same labels, same time ranges, "Last month" still highlighted in color, because that is the most frequent invoicing path.

  Deliberately **no second entry point next to the old one**, which both the issue and the `TODOS` item on the PdfMergeModal literally proposed: both windows hung off the calendar view without being calendar-specific — the time-range buttons never filtered the calendar, they only pre-filled a time range and opened a window. Four entry points across two views would have doubled the surface without touching the cause. The toolbar therefore moved entirely; the **calendar is only a calendar again**. Anyone who previously started the export from within the calendar now clicks one tab further left — from the default _Today_ view it is still two clicks.

  A side effect that stood out and was fixed along the way: the month grid now aligns to the window width. Previously the width of the export toolbar determined how wide the calendar view became — a byproduct, not a decision; without it the grid would have shrunk to its own width.

  The `TODOS` item "Merge modal Nav-Trigger" is thereby done, and the design conversation called for there and in #153 has been held.

### Internal

- **Calendar fetch and event-to-draft rules (#130, part 2 of 3)** — The machinery behind the import, still without UI: `calendarView` fetches the events of a chosen range (deliberately not `events` — that endpoint returns one series head for a recurring meeting, where the import needs the individual occurrences), pages through the full result, and asks for times in UTC so a mailbox in another time zone cannot shift every entry. Only the fields that are needed are requested at all — **not** the event body, which regularly contains dial-in data, PINs and whole mail threads that must never end up in a timesheet. An event's description is the subject line, nothing else.

  The rules that turn an event into a draft are pure functions with 40 tests: all-day events, own declines and slots marked "free" are filtered by default; "not responded" is deliberately **not** a decline — otherwise every meeting you attended without clicking "accept" would vanish. Client detection runs over the attendees' mail domains, with the own domain stripped first; if one meeting contains attendees from **two** known clients, nothing is guessed — assigning the wrong one silently would be worse than asking. Dedupe hangs off `entries.graph_event_id` (a partial unique index): an event whose entry still exists is not offered again, but deleting the entry frees the event again — deleting meant "not this one", not "never again". Domain→client mappings live in a new `client_domains` table with a real foreign key, so a deleted client takes its mappings with it.

  **Verified against the real calendar, not only against fixtures:** the fixtures were built from the Graph documentation, and an invented shape tests the filters blindly. The preview was therefore driven end-to-end over CDP against the live calendar (4 real events, own domain stripped, times correct in UTC) and cross-checked against the same range through an independent Graph client — same events, same times, same attendee domains.

- **Auth without a new dependency (#130)** — Authorization Code + PKCE implemented ourselves instead of `@azure/msal-node`. Via `jsonwebtoken` the library also pulls in `jws`, `semver`, `ms` and seven individual `lodash.*` packages — with twelve runtime dependencies roughly a doubling. The part that would justify it is unused here: as a public client nothing is signed and no token is read for a security decision. What remains are two form POSTs, one URL, and one rotation rule, via `fetch` + `AbortSignal.timeout` as already with the webhooks. Split as there: `shared/graphAuth.ts` is pure arithmetic and renderer-capable, the I/O lives in `main/`.

- **The hand test found three bugs that 763 green tests did not see (#130)** — The content of the new section stuck to the card edge, because `Section` provides no padding (that sits in `Row`); jsdom computes no layout, and the suite is fundamentally blind to this class of bug. Two path bugs weighed more heavily: the token landed in the **production** `userData` directory, because the store took the path from `mcp/socketPath.ts`, which reconstructs `%APPDATA%` Electron-free and cannot know an overridden `userData`. The obvious fix — a lazy `require('./db')` — was worse than the bug: electron-vite builds the main process into a single file in which no module `./db` exists at runtime, so the feature reported "secure storage not available" in **every** build. Both stayed invisible, because all of the store's tests inject the directory and the default path was never executed. That is why there is no default anymore: the directory is a required field, and the compiler shows every spot that previously would have guessed silently.

- **Renewal proven against real Entra (#130)** — Refresh-token rotation is the spot where self-built OAuth tends to rot: Entra can issue a new refresh token on every renewal, and whoever discards it locks the user out hours later. Besides tests against fakes, this was measured for real once — forced with a temporarily raised expiry tolerance, renewal performed, confirmed by the Graph call, the rotated token demonstrably written to disk; the counter-check with normal tolerance does not renew, as expected.

- **Characterization test for the export entry points (#153)** — `exportEntryPoints.test.tsx` locks in eight behaviors (which button pre-fills which time range, which window opens, that a second open replaces the time range) and was written green against the old code in `CalendarView` before the move; afterward the same file points unchanged at the new `ExportView`. That is the proof that the move lost nothing, and not merely a description of the new code.

  Case 6 is remarkable. The obvious test — "a second open shows the new time range" — does **not** guard the load-bearing spot: the window is rebuilt via `key` on every open, but it also receives the time range through an effect, so this case stayed green even with the `key` deleted (measured, not assumed). What is load-bearing is the `key` for the stored export settings, which are read exactly once per build — without a rebuild the state from the first mount would remain, and at app start that is the state _before_ the settings are loaded. Case 6 therefore checks that a second open reads the settings changed in the meantime; it falls over with the `key` deleted and is thus the only case that truly distinguishes the condition instead of confirming it.

- **`localDateKey` now lives in `shared/dateRanges.ts`** — The function sat locally in `CalendarView` but was needed in both views for passing the time range. It is moved rather than copied and got five tests of its own (zero-padding, midnight, year change) — it must not be replaced by `toISOString()`, which east of Greenwich reports the previous day before the UTC offset.

- **Removed dead export code (#164, #165)** — `PdfExportModal.tsx` (325 lines), replaced by `ExportModal` since v1.5, no longer had an importer; it is deleted together with the dead alias export `export { ExportModal as PdfExportModal }`. In addition, the never-passed prop `prefilledClientId` was dropped from `ExportModal` — no caller set it, its effect never fired. No behavior change: the pre-selection with exactly one client stays, it never hung on the prop.

## [1.15.1] — 2026-07-27

### Fixed

- **Tag-Auswahl per Pfeiltaste ging verloren (#158)** — Im Tag-Feld eines Eintrags einen Vorschlag mit den Pfeiltasten wählen und **Enter** drücken, ohne vorher etwas zu tippen: Der Tag wurde nicht gesetzt, der Eintrag aber gespeichert und das Fenster geschlossen. Von außen sah das aus wie „schließt ohne zu speichern" — real wurde gespeichert und die Auswahl still verworfen, ohne jeden Hinweis. Ursache war eine Bedingung, die den ganzen Übernahme-Zweig hinter „es steht Text im Feld" versteckte; das Enter lief deshalb weiter an das Formular, das brav den unveränderten Stand sicherte. Eine markierte Zeile wird jetzt übernommen, egal ob daneben getippt wurde. Ohne Markierung **und** ohne Text bleibt Enter weiterhin das Absenden des Formulars und Tab weiterhin der Fokuswechsel.

- **Escape schloss das ganze Eintragsfenster statt nur der Vorschlagsliste (#158)** — Wer die Autovervollständigung mit Escape wegdrücken wollte, verlor damit das komplette Fenster samt aller ungespeicherten Änderungen. Escape schließt jetzt zuerst die Liste; erst die zweite Taste schließt das Fenster. Betraf sowohl den Dialog auf _Heute_ als auch den Kalender-Drawer.

- **Vorschlagsliste öffnete nach einer Auswahl nicht wieder (#158)** — Nach dem Übernehmen eines Tags musste man das Feld verlassen und neu anklicken, um weitere Vorschläge zu sehen; ein Klick bei stehendem Cursor tat nichts. Jetzt öffnet jeder Klick ins Feld die Liste.

### Internal

- **Entscheidung gegen den React Compiler — vorerst (#157)** — Er wurde probeweise aktiviert und vermessen, statt die Frage weiter offen zu tragen. Ergebnis: Er würde problemlos laufen — `react-compiler-healthcheck` übersetzt **61 von 61 Komponenten**, kein Bailout, keine inkompatible Bibliothek, und die tickende Timer-Anzeige (die klassische Stelle, an der Memoisierung eine Uhr einfriert) läuft unter aktivem Compiler unverändert weiter. Die Kosten sind für eine lokale Desktop-App gutartig: Bauzeit 2,7 s → 7,0 s, Renderer-Bundle +14 %, Testsuite unverändert grün. Trotzdem **nein**, und zwar aus dem Grund, aus dem #142 zurückgestellt hatte: Es gibt kein Performance-Problem, das er lösen würde. Er brächte drei Umbauten auf ungetestetem Code — einer davon an den globalen Hotkeys — und eine dauerhafte Pflicht, zwei Build-Konfigurationen synchron zu halten (die Testsuite läuft heute ohne Babel und würde sonst anderen Code prüfen als den ausgelieferten). Entscheidend für das „vorerst": 61 von 61 heißt, es wächst keine Migrationsschuld. Taucht später ein echtes Performance-Problem auf, ist die Aktivierung ein Nachmittag, und die Messungen liegen am Issue bereit. Die fünf zuvor vertagten Ausnahmen sind damit als dauerhaft dokumentiert.

- **React-Hooks-Regeln im Renderer abgeschlossen (#142)** — Von den 26 stummgeschalteten Fundstellen sind drei tatsächlich repariert: die beiden `useCallback`-Abhängigkeiten in `CalendarView` (`onToday`, `onQuickRange` — die Setter sind identitätsstabil, die Ergänzung ist textuell folgenlos) und die Vorschlagsliste in `TagInput`, die jetzt als `useMemo` aus Eingabe, Tag-Registry und gewählten Tags abgeleitet wird statt in einem Effekt nachgeführt zu werden. Das spart nebenbei einen Render pro Tastenanschlag. Die übrigen 23 bleiben, aber nicht mehr als namenlose Restschuld: 18 sind als dauerhafte Ausnahme mit Grund dokumentiert (Datenabruf beim Mount ohne dedizierten Store, unerreichbare Codepfade, Stellen an denen der „saubere" Fix eine Falschanzeige erzeugen würde), die restlichen fünf waren an #157 vertagt und sind dort inzwischen entschieden (siehe den #157-Eintrag oben).

- **Erster Charakterisierungstest im Renderer (#142)** — `TagInput.test.tsx` sichert neun Verhaltensweisen der Vorschlagsliste ab (Präfix-Filter, Erstellen-Eintrag, 8er-Deckel, Pfeiltasten, Enter-Übernahme, Escape) und wurde vor dem Umbau gegen den alten Code grün geschrieben. Das war kein Selbstzweck: Der Effekt setzte neben der Vorschlagsliste auch die Tastatur-Markierung zurück, und dieser Teil ist keine Ableitung — er wäre beim Umbau lautlos verschwunden. Der Test hat genau das gefangen (drei rote Fälle), bevor der Reset an seine echten Auslöser wanderte. Damit steigt die Renderer-Abdeckung von vier auf fünf Testdateien; die Suite steht bei 605 statt 596. **Nachtrag:** Einer der Auslöser fehlte trotzdem — nach dem Übernehmen eines Tags blieb die Markierung stehen, sodass beim nächsten Öffnen eine Zeile vorgewählt war, die niemand gewählt hatte. Der Test öffnete die Liste nach einer Übernahme nie wieder und konnte es deshalb nicht sehen. Aufgefallen beim Handtest, korrigiert in #158, nie in einem Release gewesen. `setInputValue('')` und der Reset liegen jetzt zusammen in einem `clearInput()`, damit sie nicht erneut auseinanderlaufen.

- **`pnpm test` überspringt keine Tests mehr still (#151)** — `better-sqlite3` wird gegen die Electron-ABI gebaut, Vitest lief unter System-Node: die zwölf DB-gestützten Testdateien haben sich daraufhin selbst übersprungen. Lokal stand dann `334 passed | 201 skipped` — eine unauffällige Zahl neben einer großen grünen, die niemand als „ein Drittel deiner Abdeckung existiert gerade nicht" liest. Beim v1.15.0-Release sind genau dadurch zwei Fehler erst in der CI aufgeschlagen. Vitest läuft jetzt auf der Electron-Binary im Node-Modus (`ELECTRON_RUN_AS_NODE=1`), also auf derselben Antwort, die der MCP-Server seit v1.14.2 nutzt: gleiche ABI, keine zweite Binärkopie, kein Rebuild-Hin-und-Her — `pnpm dev` und die Paketbuilds bleiben unangetastet funktionsfähig. Kann das Modul wider Erwarten doch nicht laden, **scheitert** der Lauf jetzt mit einer Anleitung, statt sich stillschweigend zu überspringen. In der CI ersetzt ein einzelner erzwungener Rebuild direkt nach dem Install das bisherige Hin-und-Zurück um den Testlauf.

- **CI verlässt sich nicht mehr auf electron-builders ABI-Marker (#151)** — `install-app-deps` entscheidet anhand von `build/Release/.forge-meta`, ob es neu bauen muss, und dieser Marker kann von der Binary daneben abweichen: pnpm hebt native Build-Ergebnisse in seinem Store über Läufe hinweg auf, sodass eine Node-ABI-Binary mit einem „Electron"-Marker in spätere Jobs überlebt — `install-app-deps` no-opt darauf in etwa einer Millisekunde. Genau das steckte im CI-Cache, hinterlassen vom alten `pnpm rebuild better-sqlite3`-Schritt. Alle drei Jobs erzwingen die richtige ABI jetzt direkt nach dem Install (`electron-rebuild -f`), statt dem Marker zu glauben. Das schützt auch das Paket: ein veralteter Marker hätte einen Build mit falscher Binary ausliefern können.

- **Ein Regressionstest lief nie — in keiner Umgebung (#151)** — `dashboard:summary — duration precision` sichert einen echten Bug ab (SQLites `julianday()` rechnet in Fließkomma und liefert für eine Stunde 3599,999… → Anzeige „00:59"). Der Test hing an `it.skipIf(!DatabaseImpl)`; `skipIf` wird aber beim Einsammeln der Tests ausgewertet, also **bevor** das `beforeAll` läuft, das `DatabaseImpl` setzt. Die Bedingung war damit immer wahr, der Test dauerhaft übersprungen — auch in der CI. Er läuft jetzt und ist grün.

- **Gemeinsamer Test-Helfer für die DB-Suites (#151)** — Die Probe auf das native Modul und die Migrations-Schleife lagen in zwölf Dateien in drei verschiedenen Varianten dupliziert. Beides liegt jetzt in `src/test/sqlite.ts`; die testspezifischen Fixture-Daten bleiben, wo sie sind.

## [1.15.0] — 2026-07-26

### Added

- **Outbound-Webhooks (#134)** — TimeTrack schickt bei vier Ereignissen eine HTTP-Nachricht an frei konfigurierbare Ziele: `timer.started`, `timer.stopped`, `entry.created`, `entry.updated`, pro Ziel einzeln abhakbar. Damit hängt sich die Zeiterfassung an n8n, Make, Zapier, Home Assistant oder alles andere, was eine URL entgegennimmt — ohne dass TimeTrack für jedes Zielsystem eine eigene Integration braucht. Einzurichten unter **Einstellungen → Integrationen**. Ist ein Secret gesetzt, wird jede Nachricht per HMAC-SHA256 signiert (`X-TimeTrack-Signature`), sodass der Empfänger die Echtheit prüfen kann. Die Zustellung läuft im Hintergrund mit Timeout und drei Versuchen; ein nicht erreichbares Ziel kann den Timer weder blockieren noch scheitern lassen. **Privacy:** Stundensätze und interne Notizen bleiben draußen, solange sie nicht ausdrücklich freigegeben sind — dieselben Schalter wie beim MCP-Server. Jede Zustellung wird in `webhooks.log` protokolliert, ohne Secret und ohne Signatur.

- **iCal-Export der erfassten Zeit (#135)** — Das Export-Fenster hat einen dritten Tab **iCal — Kalender**: erfasste Einträge eines Zeitraums lassen sich als `.ics`-Datei speichern und in jeden Kalender (Outlook, Apple Kalender, Google Kalender) importieren — so liegen die tatsächlich geleisteten Blöcke als zweite Ebene neben den geplanten Terminen. Jeder Eintrag wird ein Termin (Titel = Kunde, optional Projekt, plus Beschreibung; Tags als Kategorien). Start- und Endzeiten stehen in UTC (`…Z`), damit der Import über Sommer-/Winterzeit hinweg korrekt bleibt; über Mitternacht laufende Einträge erscheinen wie in CSV/PDF als zwei Termine. **Privacy:** Honorare und interne Notizen tauchen nie in der Datei auf. Ein Schalter im Export-Fenster stellt wahlweise den Kundennamen oder nur ein generisches „Fokus" in den Titel — im „Fokus"-Modus bleiben auch Beschreibung und Tags außen vor. Der abonnierbare `webcal://`-Feed aus dem Issue ist bewusst noch nicht dabei (Stufe 2, braucht einen lokalen Server).

### Changed

- **Release-Seiten haben wieder einen Text (#137)** — Bisher setzte der Release-Workflow keine Beschreibung, weshalb v1.14.0 mit leerer Release-Seite veröffentlicht wurde. Jetzt zieht er den passenden Abschnitt aus diesem CHANGELOG; findet er keinen, greifen GitHubs automatische Notizen, damit die Seite nie leer bleibt. Der Text von v1.14.0 wurde nachgetragen.

- **Releases lassen sich per Knopfdruck auslösen (#138)** — Der `workflow_dispatch`-Pfad erwartete bisher einen bereits existierenden Tag und brach beim Checkout ab, wenn keiner da war. Jetzt wählt man einen Branch und einen Tag-Namen, und der Workflow legt den Tag selbst an. Vorher prüft er, dass die Tag-Version zur `package.json` passt, und bricht bei Abweichung ab, bevor gebaut wird — statt ein Release zu veröffentlichen, das der Auto-Updater nicht erkennt.

### Fixed

- **Die Lizenzübersicht kann nicht mehr still veralten (#144)** — `resources/licenses.json` listet die Lizenzen aller ausgelieferten Pakete, wurde bisher aber nur aktualisiert, wenn zufällig jemand lokal baute und die Änderung mitcommittete. So ging v1.14.0 mit einer Übersicht raus, in der 87 tatsächlich ausgelieferte Pakete fehlten. Die CI prüft die Datei jetzt bei jedem Pull Request gegen den echten Abhängigkeitsbaum. Nebenbei fiel dabei auf, dass Prettier die generierte Datei mitformatierte und so gegen ihren eigenen Generator arbeitete — sie ist jetzt von der Formatierung ausgenommen.

### Internal

- **Zeilenenden repo-weit auf LF normalisiert (#141)** — `.editorconfig` und Prettier verlangten beide LF, auf der Platte lagen aber durchgehend CRLF: die Blobs im Repo waren längst LF, die CRLF entstanden erst beim Auschecken durch ein lokal gesetztes `core.autocrlf`. Ergebnis waren 28.067 Formatierungswarnungen, eine pro Zeile pro Datei — weshalb Lint in keinem Workflow lief. Eine `.gitattributes` stellt das jetzt für jeden Klon sicher, unabhängig von lokaler Konfiguration.

- **Lint läuft wieder in der CI (#142, #143)** — Die 50 mechanisch behebbaren der 76 Lint-Fehler sind abgebaut und ESLint ist als Schritt im Test-Job verdrahtet. Die verbleibenden 26 Fehler betreffen das Renderverhalten (React-Compiler-Regeln) und sind je Fundstelle mit Verweis auf #142 stummgeschaltet — die Regeln bleiben scharf, sodass neue Verstöße die CI weiterhin scheitern lassen.

## [1.14.2] — 2026-07-25

### Added

- **Der MCP-Server steckt jetzt in der App** — Bisher lieferte der Installer ihn nicht mit: Wer die MCP-Integration nutzen wollte, musste das Repository auschecken, `pnpm build:mcp` ausführen und `better-sqlite3` von Hand gegen eine andere Native-ABI neu bauen. Jetzt ist der Server Teil jedes Paketbuilds. **Einstellungen → Integrationen** zeigt die fertige `.mcp.json`-Registrierung mit den echten Pfaden dieser Installation statt eines Platzhalters — kopieren, einfügen, fertig. Kein Checkout, kein Build, kein separat installiertes Node.

### Changed

- **Kein Native-ABI-Tanz mehr** — Der Server läuft auf der Electron-Binary der App im Node-Modus (`ELECTRON_RUN_AS_NODE=1`) statt auf einem System-Node. Damit passt die Modul-ABI von `better-sqlite3` immer, und `pnpm install` und `pnpm mcp` schließen sich im Checkout nicht mehr gegenseitig aus. `pnpm build` baut den Server automatisch mit, und `pnpm build:mac`/`pnpm build:linux` durchlaufen jetzt dieselbe Pipeline wie `build:win` — vorher fehlten ihnen Typecheck und MCP-Build.

### Fixed

- **Fehlende Lizenzangaben nachgetragen** — Seit v1.14.0 liefert die App `@modelcontextprotocol/sdk` samt Abhängigkeiten aus, die mitgelieferte Lizenzübersicht listete diese 87 Pakete aber nicht. Sie ist jetzt vollständig.

## [1.14.1] — 2026-07-25

### Fixed

- **MCP-Server findet die Datenbank wieder** — Der Server suchte die Zeiterfassung in `%APPDATA%\TimeTrack\` (macOS `~/Library/Application Support/TimeTrack/`, Linux `~/.config/TimeTrack/`), die App legt sie aber in `time-tracking` ab: Electron leitet dieses Verzeichnis aus `package.json` → `name` ab, der `productName` aus dem Installer benennt nur die installierte App. Der gesuchte Ordner existierte damit auf **keiner** Installation — alle Lese-Tools scheiterten mit „Datenbank nicht gefunden", solange man `TIMETRACK_DB_PATH` nicht von Hand setzte. Der Schreibzugriff war genauso betroffen: Token und Socket werden neben der Datenbank gesucht, also antworteten die Schreib-Tools mit „TimeTrack läuft nicht", obwohl die App lief. Wer den Fehler mit einer Kopie der Datenbank im alten Ordner umgangen hat, liest ab jetzt wieder die echte — die Kopie kann weg.

### Changed

- **Dokumentierte Datenpfade korrigiert** — README, PRIVACY.md und CONTRIBUTING.md nannten `%AppData%\TimeTrack\` als Ablageort; tatsächlich ist es `%AppData%\time-tracking\` (macOS `~/Library/Application Support/time-tracking/`). PRIVACY.md nannte zusätzlich einen Dateinamen, den es nie gab (`timetrack.db` statt `timetrack.sqlite`).

## [1.14.0] — 2026-07-24

### Added

- **MCP-Server (Lesen + Schreiben)** — TimeTrack stellt einen [Model-Context-Protocol](https://modelcontextprotocol.io)-Server über stdio bereit, mit dem Werkzeuge wie Claude Code die lokale Zeiterfassung nutzen können. **Lesen** (read-only, direkt auf der DB): `list_clients`, `list_projects`, `list_entries` (Monat oder Datumsspanne, Filter nach Kunde/Projekt/Tag), `get_running_timer`, `get_dashboard`, `get_analytics`. Stundensätze/Umsätze und interne Notizen sind standardmäßig ausgeblendet und lassen sich in der App oder per Umgebungsvariable (`TIMETRACK_MCP_EXPOSE_RATES`, `TIMETRACK_MCP_EXPOSE_PRIVATE_NOTES`) einschalten. Build via `pnpm build:mcp`, Start via `pnpm mcp`; Registrierung und Native-ABI-Hinweise siehe README → „MCP-Integration".

- **MCP-Write-Mode** — Optionaler, standardmäßig deaktivierter Schreibzugriff: Claude kann Einträge nachtragen/ändern und Timer starten/stoppen (`create_manual_entry`, `update_entry_fields`, `start_timer`, `stop_running_timer`). Sicherheit steht im Vordergrund: Schreiben läuft **nie** direkt in die DB, sondern über einen lokalen, tokengesicherten Socket an die **laufende App**, die es durch ihre validierte Logik ausführt (Cross-Midnight-Split, Overlap-Prüfung usw.). Abgesichert durch Opt-in, Token (mode 0600, Rotation je App-Start), Allowlist, Vorschau (`preview`), ein **Pre-Write-Backup** je Sitzung und ein Append-only-**Audit-Log** (`mcp-writes.log`). Bestätigung pro Schreibaktion wählbar (bei jeder Änderung / einmal pro Sitzung / nie).

- **Einstellungen → Integrationen** — Neues Settings-Submenü als Einstiegspunkt für die MCP-Integration: zeigt den Datenbank-Pfad und die kopierbare `.mcp.json`-Registrierung für Claude Code, bietet Schalter für „Stundensätze/Umsätze einblenden" und „Interne Notizen einblenden" sowie den **Schreibzugriff-Schalter** mit **Bestätigungs-Modus-Auswahl** und „Audit-Log öffnen".

## [1.13.2] — 2026-07-17

### Changed

- **Schnellere UI bei Einstellungs-Änderungen** — Einstellungen werden intern nicht mehr über einen React-Context verteilt, sondern über einen Selector-basierten Store: Ändert sich ein einzelner Wert (z. B. eine Export-Option), zeichnet nur noch die betroffene Komponente neu statt der gesamten App-Oberfläche. Nebeneffekt: Die Fehlerklasse „vergessener Settings-Provider", die in v1.13.0 das Mini-Widget crashte, kann nicht mehr auftreten.

### Fixed

- **Export-Einstellungen gehen nicht mehr verloren** — Die im Export-Modal gemerkten Einstellungen (Tab, Gruppierung, Honorarspalte, Unterschriften, CSV-Format) wurden bisher im Browser-Speicher (`localStorage`) abgelegt und gingen sporadisch verloren — etwa wenn versehentlich eine zweite App-Instanz lief oder die App nach einem Backup-Restore hart neu startete. Die Einstellungen liegen jetzt in der SQLite-Datenbank (Key `export_prefs`), überleben damit auch harte App-Beendigungen und wandern automatisch mit in Backups. Vorhandene Einstellungen werden beim ersten Öffnen einmalig übernommen.

- **TimeTrack läuft nur noch einmal** — Startet man die App erneut, während sie bereits läuft (auch minimiert im Tray), öffnet sich jetzt das bestehende Fenster statt einer zweiten Instanz. Zweitinstanzen konnten bisher unbemerkt Einstellungen verlieren und parallel in die Datenbank schreiben.

- **Neustart nach Backup-Restore ist jetzt sauber** — Der automatische Neustart (nach Backup-Wiederherstellung oder Onboarding) beendet die App jetzt geordnet statt hart, sodass noch nicht gespeicherte Browser-Daten vorher auf die Platte geschrieben werden. Die Single-Instance-Sperre wird vor dem Neustart freigegeben, damit die neue Instanz zuverlässig startet.

## [1.13.1] — 2026-05-29

### Fixed

- **Mini-Widget startete nicht mehr** — Beim Öffnen des Mini-Widgets crashte der Renderer mit `useSettings must be used within a SettingsProvider`. Ursache: Seit v1.12 (#106) liest der `I18nProvider` die Sprache aus dem zentralen `SettingsProvider`, der Einstiegspunkt des Mini-Widgets (`mini.tsx`) hatte den `SettingsProvider` aber nie nachgezogen. Mini-Widget ist jetzt wieder benutzbar.

## [1.13.0] — 2026-05-29

### Added

- **PDF-Export: Gruppierung wählbar (Tag / Projekt / Referenz / keine)** — Im Export-Modal kann jetzt die Gruppierung des PDF-Stundennachweises gewählt werden: keine Gruppierung (chronologisch), nach Tag (#hashtag), nach Projekt oder nach Referenz. Die alte Checkbox „Nach Tag gruppieren“ wird intern auf den neuen Modus abgebildet. Beim Filtern auf ein einzelnes Projekt setzt das Modal die Gruppierung automatisch auf „keine“. ([#118](https://github.com/skoedr/time-tracking/issues/118))

- **PDF-Export: Honorarspalte ausblendbar** — Neuer Toggle „Honorarspalte ausblenden“ im Export-Modal. Damit lässt sich ein neutraler Stundennachweis ohne Preisangaben erzeugen, etwa zur internen Weitergabe oder bei Pauschalabrechnungen. ([#118](https://github.com/skoedr/time-tracking/issues/118))

- **PDF-Export: Projektname pro Zeile bei kundenweiter Auswertung** — Wird das PDF ohne Projektfilter (alle Projekte eines Kunden) und ohne Projekt-Gruppierung erzeugt, erscheint pro Eintrag eine zusätzliche kursive Zeile mit dem Projektnamen. So sind kundenweite Auswertungen ohne Gruppierung trotzdem nachvollziehbar. ([#118](https://github.com/skoedr/time-tracking/issues/118))

- **PDF-Export: Letzte Einstellungen merken** — Tab, Gruppierung, Honorarspalte-Ausblendung, Unterschriften-Bereich und CSV-Format werden je Nutzer in `localStorage` gespeichert und beim nächsten Öffnen wiederhergestellt. ([#118](https://github.com/skoedr/time-tracking/issues/118))

- **PDF-Merge: Mehrere Stundennachweise mit einer Rechnung zusammenführen** — Im Zusammenführen-Dialog können jetzt beliebig viele Stundennachweis-PDFs (z. B. mehrere Kunden / Projekte) hinzugefügt und mit einer einzelnen Rechnung zusammengeführt werden. Jeder Slot hat eigene Seitenzahl-Anzeige und lässt sich einzeln entfernen; die Vorschauzeile zeigt die Gesamtseitenzahl an. Reihenfolge im Ergebnis: Rechnung → SN #1 → SN #2 → … ([#119](https://github.com/skoedr/time-tracking/issues/119))

### Fixed

- **Tags: Führende und nachgestellte Whitespaces werden entfernt** — Beim Eingeben eines Tags werden Leerzeichen und Zeilenumbrüche an den Rändern jetzt vor dem Speichern (und vor Duplikat-Prüfungen) entfernt. Damit verschmelzen `urlaub`, ` urlaub` und `urlaub ` korrekt zum gleichen Tag. ([#121](https://github.com/skoedr/time-tracking/issues/121))

- **PDF-Export: Nicht-abrechenbare Einträge erzeugen kein Honorar mehr** — Beim Erzeugen des PDF-Stundennachweises wurden für Einträge mit `billable=false` weiterhin Honorarwerte berechnet (Spalte „Honorar“ und Endsumme). Diese Einträge werden jetzt korrekt mit 0 € in der Honorarspalte und in der Endsumme ausgewiesen — konsistent mit dem CSV-Export und der Auswertung. ([#120](https://github.com/skoedr/time-tracking/issues/120))

- **PDF-Export: Projekt-spezifischer Stundensatz wird berücksichtigt** — Ist auf einem Projekt ein abweichender Stundensatz hinterlegt, wurde dieser im PDF-Export ignoriert und stattdessen der Kunden-Satz verwendet. Die Honorarberechnung folgt jetzt der gleichen Prioritätsregel wie der Rest der App: Projekt-Satz → Kunden-Satz → globaler Satz. ([#120](https://github.com/skoedr/time-tracking/issues/120))

## [1.12.5] — 2026-05-04

### Fixed

- **PDF-Merge: factur-X / ZUGFeRD XML-Anhang geht nicht mehr verloren** — Beim Zusammenführen von Stundennachweis und Rechnung (PDF) gingen bisher die E-Rechnungs-Metadaten des Rechnungs-PDFs verloren: eingebettete XML-Datei (`/EmbeddedFiles`), XMP-Metadaten-Stream (`/Metadata`) und ICC-Farbprofil (`/OutputIntents`). Das zusammengeführte PDF bestand dadurch die factur-X / ZUGFeRD Validierung nicht. Alle drei werden jetzt korrekt in das Zieldokument kopiert — Mustang-Validierung bestätigt `XML:valid`. ([#115](https://github.com/skoedr/time-tracking/issues/115))

## [1.12.0] — 2026-05-04

### Added

- **Zentrales Tag-Management** — Neue Einstellungs-Seite „Tags" zum Verwalten aller Tags: alphabetische Liste mit Eintragszähler, Inline-Umbenennen (Enter / Escape), Zusammenführen zweier Tags (Dropdown + Bestätigungsdialog mit Eintragszahl), Löschen (nur möglich wenn 0 Einträge). Neue `tags`-Mastertabelle (Migration 016) wird beim ersten Start aus bestehenden Einträgen befüllt. Tag-Eingabe wechselt auf geschlossenes System — Autocomplete aus der Masterliste, unbekannter Text erzeugt einen neuen Tag direkt via `+ erstellen`-Option. ([#107](https://github.com/skoedr/time-tracking/issues/107))

- **Ansprechpartner auf Projektkarte** — Ist ein Ansprechpartner für ein Projekt hinterlegt, erscheint er als zweite Zeile unter dem Projektnamen in der Projektliste. ([#105](https://github.com/skoedr/time-tracking/issues/105))

- **Projekt-Ansprechpartner-Feld** — Projekte erhalten ein neues optionales Feld `contact_person` (Migration 015). Das Feld wird im Projekt-Bearbeitungsformular angezeigt und ausgefüllt gespeichert. ([#105](https://github.com/skoedr/time-tracking/issues/105))

- **Rundungs-Einstellung im UI verdrahtet** — Die Einstellung „Stunden runden auf" (PDF-Abschnitt) war bisher nur in der PDF-Generierung aktiv. Sie beeinflusst jetzt auch die angezeigte Dauer in der Heute-Ansicht, der Kalenderansicht und der Auswertung — alle Ansichten sind damit rundungsparitätisch mit dem Export. ([#106](https://github.com/skoedr/time-tracking/issues/106))

## [1.11.1] — 2026-05-04

### Fixed

- **QuickNote-Modal: Auto-Close beim Tippen unterbrochen** — Der 30-Sekunden-Countdown lief bisher ungehindert durch, auch wenn der Nutzer bereits tippt. Das Modal schloss sich und verwarf den eingegebenen Text. Der Countdown wird jetzt bei jeder Texteingabe zurückgesetzt — das Modal schließt sich erst, wenn der Nutzer 30 Sekunden lang inaktiv ist oder explizit speichert/abbricht. ([#109](https://github.com/skoedr/time-tracking/issues/109))

- **Auswertung: Nicht-abrechenbare Stunden im Umsatz** — In der Monatsübersicht und der Kunden-Aufschlüsselung wurde der Umsatz für alle Einträge berechnet, unabhängig vom `billable`-Flag. Nicht-abrechenbare Stunden zählen weiterhin zur Gesamtdauer, fließen aber jetzt korrekt nicht mehr in den Umsatz ein — konsistent mit PDF- und CSV-Export. 2 neue Regressionstests ergänzt. ([#104](https://github.com/skoedr/time-tracking/issues/104))

## [1.11.0] — 2026-04-30

### Added

- **Stammdaten-Erweiterung Kunden + Projekte** — Vollständige Verwaltung erweiterter Kunden- und Projektdaten (#94). Drei aufeinander aufbauende PRs:

  **Datenbank + IPC (PR 1/3):** Migration 013 ergänzt `clients` um 7 neue Felder (Rechnungsadresse 4-zeilig, USt-IdNr., Ansprechpartner, E-Mail) und `projects` um 5 neue Felder (externe Projektnummer, Start-/Enddatum, Budget in Minuten, Status `active`/`paused`/`archived`). Der `status`-Wert löst das binäre `active`-Flag schrittweise ab. Neuer IPC-Handler `projects:getBudgetStatus`. 13 neue Tests.

  **UI-Formulare + PDF-Empfängerblock (PR 2/3):** `ClientFormModal` mit Rechnungsadresse, USt-IdNr., Ansprechpartner und Kontakt-E-Mail. `ProjectFormModal` mit Status-Toggle (Aktiv / Pausiert / Archiviert), externer Projektnummer, Datumsbereich und Budget in Dezimalstunden. PDF-Empfängerblock rendert Adresszeilen, USt-IdNr. (`USt-IdNr.`-Prefix) und Ansprechpartner (`z. Hd.`-Prefix) konditionell.

  **Budget-UX (PR 3/3):** Horizontaler Budget-Mini-Balken auf jeder Projektkarte (Farb-Codierung: Akzent → Amber ab 80 % → Rot bei Überschreitung, numerisches Label `32.0 h / 40.0 h`). Amber-Status-Badge „Pausiert“ neben pausierten Projektnamen. Budget-Warn-Banner im Timer-Start-Modal wenn das gewählte Projekt ≥ 80 % verbraucht hat. ([#94](https://github.com/skoedr/time-tracking/issues/94))

- **Externe Projektnummer im UI** — Optionale externe Projektnummer (z. B. Bestellnummer) wird in eckigen Klammern hinter dem Projektnamen angezeigt — in der laufenden Timer-Pill, in der Heute-Tabelle, im QuickStart-Modal und auf der Projektkarte. Kann in den Einstellungen (Allgemein › „Projektnummer anzeigen“) ein- und ausgeblendet werden. ([#94](https://github.com/skoedr/time-tracking/issues/94))

- **Ansprechpartner + Enddatum auf Kunden-/Projektkarte** — Ist ein Ansprechpartner hinterlegt, erscheint er als zweite Zeile unter dem Kundennamen in der Kundenliste. Ist ein Enddatum gesetzt, wird es als „bis TT.MM.JJJJ“ neben dem Projektsatz angezeigt. ([#94](https://github.com/skoedr/time-tracking/issues/94))

### Fixed

- **Auswertung: Rundungsparitat mit PDF** — Die Auswertung berechnete bisher Rohdauern in Sekunden. Jetzt wird dieselbe Ceil-Rundungslogik wie im PDF angewendet (`pdf_round_minutes`-Setting): Stunden und Umsätze in der Auswertung stimmen nun exakt mit dem generierten PDF überein. ([#94](https://github.com/skoedr/time-tracking/issues/94))

- **Timer-Modal: Vorausgewähltes Projekt beibehalten** — Beim Öffnen des Timer-Start-Modals mit einer Vorauswahl (letztes Projekt) wurde die Auswahl durch den asynchronen Projekt-Ladevorgang zurückgesetzt, bevor sie gerendert werden konnte. Die gültige Vorauswahl bleibt jetzt erhalten; die Budget-Warnung erscheint sofort wenn nötig. ([#94](https://github.com/skoedr/time-tracking/issues/94))

### Changed

- **Heute-Tabelle: 2-zeilige Kunden-/Projektanzeige** — Die Kunden-/Projektspalte zeigt jetzt Kundenname (fett) und Projektname (klein, gedimmt) in zwei Zeilen statt einzeilig. Die Spalte wurde auf `1.5fr` verbreitert. ([#94](https://github.com/skoedr/time-tracking/issues/94))

- **Einstellungen: Timer-Rundungs-Settings entfernt** — Die toten Einstellungen „Intervall“ und „Methode“ im Timer-Abschnitt wurden aus UI und Types entfernt (die DB-Rows bleiben bestehen und werden bei der nächsten Migration bereinigt). Maßgebliche Rundung für PDF und Auswertung ist ausschließlich „Stunden runden auf“ im PDF-Abschnitt. ([#94](https://github.com/skoedr/time-tracking/issues/94))

- **Hint-Text für PDF-Rundung aktualisiert** — Der Hinweistext unter „Stunden runden auf“ macht jetzt deutlich, dass die Einstellung für PDF _und_ Auswertung gilt. ([#94](https://github.com/skoedr/time-tracking/issues/94))

## [1.10.0] — 2026-04-30

### Added

- **Auswertungs-Tab (Analytics Dashboard)** — Neuer „Auswertung"-Tab mit vollständiger Monatsübersicht: drei Stat-Cards (Stunden, Umsatz, Abrechenbar %) mit DeltaPills vs. Vormonat, TrendChart mit Toggle Wochen/Monate (12 Wochen gestapelt nach abrechenbar/nicht-abrechenbar, 12 Monate Stunden + Umsatzlinie), ClientBars (Top 4 Kunden + „Sonstige") und WeekdayBars (Wochentag-Durchschnitt, letzte 90 Tage). Monatsnavigation (← →) mit Anker-basierter Fensterberechnung — historische Monate zeigen korrekte Trailing-Windows. EmptyState wenn noch keine Daten vorhanden. Umsatz-Karte zeigt „Kein Satz konfiguriert" wenn kein Stundensatz hinterlegt. IPC-Handler `analytics:summary` mit 5 SQL-Queries in einer `db.transaction()`, 12 Unit-Tests (COALESCE, Billable-Ratio, Januar/Dezember-Grenze, Schaltjahr, gelöschte Einträge). ([#93](https://github.com/skoedr/time-tracking/issues/93))
- **Timer-Modal statt Timer-Tab** — Der separate Timer-Tab wurde entfernt. Stattdessen öffnet ein ▶-Button in der Navigationsleiste (sichtbar wenn kein Timer läuft) ein leichtes Modal (`StartTimerModal`) mit Kunden-/Projektwahl und Beschreibungsfeld. Läuft ein Timer, zeigt die Navigationsleiste die laufende Pill mit einem ▪-Stopp-Button direkt rechts. Kein Tab-Wechsel mehr nötig — Timer starten und stoppen erfolgt kontextfrei aus jeder Ansicht. ([#98](https://github.com/skoedr/time-tracking/issues/98))
- **Quick-Start-Limit auf 5 erhöht** — Das Zifferblatt zeigt jetzt bis zu 5 Kunden statt 3 (Top-Clients der letzten 30 Tage). ([#98](https://github.com/skoedr/time-tracking/issues/98))

### Fixed

- **QuickStart-Label über Pills** — Das „Schnellstart"-Label stand inline neben den Pills (`flex-wrap`). Jetzt steht es in einer eigenen Zeile darüber (`flex-col`). Pills ohne letztes Projekt hatten außerdem eine kleinere Höhe als Pills mit Projekt-Subtitle — behoben durch ein immer-gerendertes Subtitle-Element (`visibility: hidden` + `&nbsp;`-Platzhalter). ([#100](https://github.com/skoedr/time-tracking/pull/100))

### Changed

- **Quick Start radial fan — Zifferblatt-Layout** — Beim Press-and-Hold öffnet sich jetzt ein Zifferblatt-Ring um die Pill: Projekte verteilen sich symmetrisch auf der oberen Hälfte (12 Uhr für 1 Projekt; 10/2 Uhr für 2; 9/12/3 Uhr für 3; bis ±90° end-inclusive für N≥3, bis zu 11 Projekten). „Kein Projekt" sitzt fix 60 px unter der Pill (6-Uhr-Richtung, gestrichelter Border) — entkoppelt vom Projekt-Radius, damit es nicht in die Recents-Liste rutscht. Konstanter Radius 180 px für alle N (≥1) — gleichmäßiges Spacing unabhängig von der Projektzahl. Items „schießen" aus dem Pill-Zentrum auf ihre Ring-Position (cubic-bezier overshoot, 240 ms), Stagger nach `|angle|` (12 Uhr zuerst, Ränder zuletzt). Ein dünner SVG-Halo-Bogen folgt den äußersten Items (120° für N=2, 180° für N≥3). Modal-Style Backdrop mit `backdrop-filter: blur(6px)` + leichter Abdunklung legt sich beim Öffnen über die Seite. Hover auf einem Item zeigt eine farbige Speiche mit Verlaufs-Gradient (transparent zur Pill, opak zum Item). Die aktive Pill pulsiert dezent (`box-shadow`, 2.4 s). `prefers-reduced-motion` ersetzt alle Bewegungen durch reine Opacity-Fades. ([#96](https://github.com/skoedr/time-tracking/issues/96))

## [1.9.6] — unreleased

### Added

- **Auto-Projektfarbe aus Kundenfarbe (E1)** — Neue Projekte erhalten automatisch eine etwas hellere Variante der Kundenfarbe als Standard-Vorschlag (HSL-Helligkeitsverschiebung +18 %), statt keine Farbe vorzuschlagen. Der Farb-Picker bleibt unverändert — der Nutzer kann die Farbe weiterhin frei wählen oder auf „Kundenfarbe übernehmen" zurücksetzen. ([#75](https://github.com/skoedr/time-tracking/issues/75))
- **Projekt-Quick-Stats in der Kundenliste (E5)** — Unter jedem Projektnamen wird jetzt eine kompakte Statistikzeile angezeigt: Anzahl Zeiteinträge + relativer Zeitstempel des letzten Eintrags (z.B. „12 Einträge · vor 3 Tagen"). Projekte ohne Einträge zeigen keine Statistik. ([#75](https://github.com/skoedr/time-tracking/issues/75))

## [1.9.5] — unreleased

### Added

- **Konfigurierbarer Backup-Pfad** — Neuer Einstellungs-Tab-Bereich „Backup-Pfad" in der Settings-Datei-Tab. Per Dialog wählbarer Ordner (z.B. OneDrive, NAS) wird als `backup_path` in der Settings-Tabelle gespeichert. Alle Backup-Operationen (erstellen, rotieren, auflisten) nutzen den konfigurierten Pfad; `createBackupSync` im Migrations-Runner nutzt weiterhin den Standard-Pfad (Henne-Ei-Problem beim ersten Start). ([#79](https://github.com/skoedr/time-tracking/issues/79))
- **Backup-Restore-UI in Settings** — Dropdown mit allen vorhandenen Backups (Datum + Dateigröße), „Wiederherstellen…"-Button mit Bestätigungs-Dialog (`variant="danger"`) und automatischem App-Neustart nach Wiederherstellung. ([#79](https://github.com/skoedr/time-tracking/issues/79))
- **Offline-Pfad-Warnung** — Gelbes Warn-Banner wenn der konfigurierte Backup-Pfad nicht erreichbar ist (z.B. NAS offline, USB nicht eingesteckt). Backups fallen in diesem Fall nicht automatisch auf den Standard-Pfad zurück — der Nutzer wird informiert. ([#79](https://github.com/skoedr/time-tracking/issues/79))
- **Onboarding Step 4 — Backup-Wiederherstellung** — Wenn beim Erststart vorhandene Backups gefunden werden, erscheint ein optionaler vierter Onboarding-Schritt: Neuestes Backup anzeigen, zweistufige Bestätigung (erster Klick → Bestätigen, zweiter Klick → Wiederherstellen + Neustart), Skip-Option. ([#79](https://github.com/skoedr/time-tracking/issues/79))

### Security

- **`backup:restore` Path-Guard erweitert** — Der Pfad-Sicherheitscheck für `backup:restore` erlaubt jetzt sowohl den Standard-Backup-Ordner als auch den konfigurierten benutzerdefinierten Pfad. Der konfigurierte Pfad stammt aus der Settings-DB (nicht aus dem Request-Payload), sodass die Sicherheits-Invariante erhalten bleibt.

### Changed

- **`getDefaultBackupsDir()` als separate Funktion** — Extrahiert aus `getBackupsDir()` für sichere Verwendung im Migrations-Runner (`createBackupSync`) ohne DB-Zugriff.

## [1.9.0] — 2026-04-29

### Added

- **Projekte pro Kunde — Export projektgefiltert (PR 4/4, schließt #75)** — PDF- und CSV-Export können optional auf ein einzelnes Projekt eines Kunden gefiltert werden. `ExportModal` zeigt nach Kunden-Wahl einen Projekt-Picker (nur aktive Projekte des Kunden; „Alle Projekte" als Standard). `PdfRequest` und `CsvRequest` akzeptieren `projectId?`; der SQL-Filter `AND (? IS NULL OR project_id = ?)` greift nur, wenn ein Projekt gesetzt ist. PDF-Header zeigt „Projekt: …" wenn gefiltert. CSV- und PDF-Dateiname erhält den Projektnamen als Suffix (z.B. `Zeiterfassung-Musterkunde-Webprojekt-2026-04.csv`). i18n-Keys `export.project.label` und `export.project.placeholder` für DE/EN ergänzt. ([#75](https://github.com/skoedr/time-tracking/issues/75))
- **Projekte pro Kunde — Timer/Today/Calendar/EntryEdit projektbewusst (PR 3/4)** — Timer-View zeigt nach Kunden-Auswahl einen kaskadierten Projekt-Picker (gefiltert auf aktive Projekte des Kunden; Auto-Select bei genau einem Projekt; effektiver Stundensatz-Hinweis wenn Projekt-Satz den Kunden-Satz überschreibt). Recent-Liste in TodayView zeigt `Kundenname · Projektname`. CalendarDrawer zeigt Projektname in Entry-Zeilen. EntryEditForm hat neuen Projekt-Picker zwischen Kunde und Beschreibung, lädt Projekte bei Kunden-Wechsel nach. Neues `selectedProjectId` in `timerStore` und `useTimer`. i18n-Keys für DE/EN ergänzt. ([#75](https://github.com/skoedr/time-tracking/issues/75))
- **Projekte pro Kunde — Projektverwaltung in ClientsView (PR 2/4)** — Renderer-seitige Projektverwaltung für Issue #75. Jeder Kunde kann per Chevron aufgeklappt werden und zeigt eine Sub-Liste seiner Projekte. CRUD-Aktionen (Erstellen, Bearbeiten, Archivieren, Löschen) via `ProjectFormModal` inline in `ClientsView`. Farbauswahl mit „Kundenfarbe übernehmen"-Option (`color = ''`), optionaler Stundensatz-Override. Archivierte Projekte in eigener Collapsible-Sektion. Neuer `projectsStore` (Zustand Version-Bump nach Mutationen). Vollständige i18n-Keys für DE/EN. ([#75](https://github.com/skoedr/time-tracking/issues/75))
- **Projekte pro Kunde — DB, Types, IPC (PR 1/4)** — Foundation für Issue #75. Neue `projects`-Tabelle (client-scoped via FK, Soft-Delete via `active = 0`), `project_id`-Spalte auf `entries` (nullable, ON DELETE SET NULL), vollständige IPC-Handler (`projects:getAll`, `projects:create`, `projects:update`, `projects:archive`, `projects:delete`), TypeScript-Typen (`Project`, `CreateProjectInput`, `UpdateProjectInput`, `ProjectWithCount`) und Preload-Exposition (`window.api.projects.*`). ([#75](https://github.com/skoedr/time-tracking/issues/75))

### Fixed

- **ConfirmDialog statt browser-nativem `confirm()`** — Löschen von Einträgen, Projekten und Kunden öffnet jetzt einen AppDialog statt des nativen `window.confirm()`. Visuell konsistent mit dem restlichen App-Design.
- **Projektfarbe in allen Ansichten** — CalendarView, CalendarDrawer, TodayView und TimerView zeigen die Farbe des aktiven Projekts einheitlich als Akzentfarbe; kein Grau-Fallback mehr wenn ein Projekt gesetzt ist.
- **`+`-Button im Kunden-Header** — Die Schaltfläche zum Anlegen eines neuen Projekts fehlte in der Kunden-Kopfzeile zwischen Archivieren- und Bearbeiten-Icon.
- **Doppeltes `+` im Projektbutton-Label** — i18n-Schlüssel für „+ Projekt hinzufügen" enthielt fälschlicherweise zwei Plus-Zeichen; jetzt korrekt ein `+`.
- **Projektzuweisung beim Anlegen/Bearbeiten nicht gespeichert** — Der 11-Spalten-INSERT in `insertEntrySegments` übergab `project_id` nicht; der 4-Spalten-INSERT beim Timer-Start setzte sie implizit auf NULL. Beide Pfade übergeben jetzt korrekt `input.project_id ?? null`.

### Security

- **Gitleaks-Konfiguration** — `.gitleaks.toml` mit `useDefault`-Ruleset verhindert versehentlich committete Credentials. Allowlist für Tailwind-Hexfarben und SHA-gepinnte Actions.
- **CODEOWNERS für Workflows** — `.github/CODEOWNERS` erfordert explizites Review von `@skoedr` bei Änderungen an den GitHub-Actions-Workflows.

### Migration Note

Migration 012 (`v1.9-projects`) fügt einen Index `idx_entries_project_started` auf der `entries`-Tabelle hinzu. Bei sehr großen Datenbanken (50.000+ Einträge) kann der erste App-Start nach dem Update 2–5 Sekunden länger dauern, während der Index aufgebaut wird.

## [1.8.1] — 2026-04-28

### Fixed

- **SettingsView-Zentrierung** — Äußerer Wrapper bekommt `mx-auto max-w-4xl`, sodass die Sidebar-Navigation bei 900 px Fensterbreite mittig ausgerichtet ist. ([#87](https://github.com/skoedr/time-tracking/issues/87))
- **Doppelter CSS-Reset entfernt** — `*, *::before, *::after { box-sizing: border-box; margin: 0 }` stand in `main.css` und `base.css` gleichzeitig; Duplikat aus `main.css` entfernt.

## [1.8.0] — 2026-04-27

### Added

- **Glass Design System (Light & Dark)** — Komplett neues visuelles Fundament. Alle Farben, Schatten und Hintergruende laufen ueber CSS Custom Properties (--page-bg, --card-bg, --shadow, --accent, --green, --danger, …). Ambient-Glow-Blobs geben dem Seitenhintergrund Tiefe. ([#76](https://github.com/skoedr/time-tracking/issues/76))
- **Inter Variable + JetBrains Mono** — Inter Variable als App-Schrift, JetBrains Mono fuer alle Timer- und Zahlenanzeigen. Beide Fonts lokal gebundelt.
- **SVG-Icon-Bibliothek** (Icons.tsx) — Edit, Trash, Archive, Unarchive, Plus, X, ChevronLeft/Right/Down, Play, Stop, Clock, Check, Dot. Ersetzt Text-Pluszeichen in Buttons.
- **Shared Toggle-Komponente** — Pill-Toggle (40x22 px) fuer Billable-Flag, Signatur-Checkbox und CSV-Gruppe-nach-Tag.
- **TodayView Redesign** — Stat-Cards mit 40 px JetBrains-Mono-Zahl, ActiveTimerPill mit Stop-Button, Quick-Start-Zeile mit Play-Icons, Recent-List als CSS-Grid.
- **Vollstaendige i18n DE/EN** — Alle Views, Components und das Mini-Widget zweisprachig. Sprachwechsel live ohne Neustart.
- **Nicht-Abrechenbar-Flag + Private Notiz** — Eintrag als nicht abrechenbar markierbar; optionale interne Notiz wird nicht in Exporte uebernommen. ([#71](https://github.com/skoedr/time-tracking/issues/71), [#72](https://github.com/skoedr/time-tracking/issues/72))
- **Ticket-/Referenzfeld** — Optionales Ticket- oder Issue-Feld pro Eintrag, erscheint im PDF-Stundennachweis. ([#70](https://github.com/skoedr/time-tracking/issues/70))
- **CSV: Gruppe nach Tag mit Zwischensummen** — CSV-Export gruppiert nach Tag und zeigt Zwischen- und Gesamtsumme. ([#68](https://github.com/skoedr/time-tracking/issues/68))
- **Settings: Sidebar-Navigation mit 5 Tabs** — Allgemein, Timer, Datenschutz, Backup, Ueber. ([#74](https://github.com/skoedr/time-tracking/issues/74))
- **Archivierte Kunden eingeklappt** — Archivierte Kunden in ausklappbarer Sektion. ([#73](https://github.com/skoedr/time-tracking/issues/73))

### Fixed

- **Modal-Backdrop-Clipping** — `transform` aus der `fadeIn`-Animation entfernt. Chromium erzeugte durch `transform` + `fill-mode: both` einen neuen Containing Block, wodurch `position: fixed`-Overlays relativ zum View statt zum Viewport positioniert wurden — der sichtbare Rahmen um Modals.
- **TodayView-Zentrierung** — `w-full` auf dem `max-w-3xl`-Wrapper nötig, da flex-col-Kinder sich nicht automatisch strecken.
- **TimerView-Zentrierung** — `flex-1 flex flex-col` auf dem View-Container, `justify-center` in TimerView.
- **Dialog-Overflow** — Tall-Modals scrollen korrekt statt außerhalb des Viewports zu enden.
- **Light-Mode-Farben** — Alle `text-green-400` / `text-slate-*` Klassen durch CSS-Vars ersetzt.
- **font-mono Tailwind ersetzt** — Explizit `fontFamily: "'JetBrains Mono', monospace"` statt `font-mono` (würde auf System-Monospace mappen).
- **Ambient Blobs kein harter Schnitt** — Blobs direkt `position: fixed` ohne `overflow-hidden`-Wrapper, `--accent-bg` / `--green-bg` statt voller Farbe, 80 px Blur.

## [1.7.2] — 2026-04-27

### Fixed

- **Tagesübersicht zeigt 59 Min statt 1 Stunde** — `julianday()`-Arithmetik in SQLite nutzt IEEE-754 Gleitkomma; ein exakt 1-stündiger Eintrag lieferte `3599.9999...` statt `3600`, was nach `Math.floor()` als `00:59` angezeigt wurde. Fix: alle vier Dashboard-SQL-Ausdrücke auf `CAST(strftime('%s', col) AS INTEGER)` umgestellt (Unix-Epoch-Ganzzahlen, kein Gleitkomma). Regressionstest in `ipc.test.ts` hinzugefügt.

## [1.7.1] — 2026-04-27

### Fixed

- **Kunden-Refresh ohne App-Neustart** — Nach dem Anlegen, Archivieren oder Reaktivieren eines Kunden wurde `timerStore.clients` nicht aktualisiert. TodayView und CalendarView zeigten daher veraltete Daten, bis die App neu gestartet wurde. Fix: neuer `clientsStore` (Version-Counter-Pattern, analog `entriesStore`). `useTimer` re-fetcht die Kundenliste bei jeder Version-Erhöhung; `ClientsView` bumpt die Version nach jedem Mutations-IPC-Call. ([#66](https://github.com/skoedr/time-tracking/issues/66))

## [1.7.0] — 2026-04-26

### Added

- **PDF-Merge — An Rechnung anhängen** — Stundennachweis direkt an eine bestehende Rechnungs-PDF anhängen (Lexware, sevDesk, Billomat). Checkbox „An Rechnung anhängen" im Export-Modal aktivieren, Rechnungs-PDF wählen, fertig. Der Stundennachweis wird am Ende der Rechnung angefügt; die Original-Datei bleibt unverändert. Output: `<Rechnungsname>_inkl_Stundennachweis.pdf` im selben Verzeichnis. Bei bereits existierender Ausgabedatei wird ein Zeitstempel-Suffix ergänzt (kein stilles Überschreiben). Bei schreibgeschützten Verzeichnissen öffnet sich automatisch ein Speichern-Dialog.
- **`pdf-lib`** als neue Dependency (~150 KB, pure JS, MIT) — kein natives Modul, kein Rebuild-Schritt.

## [1.6.1] — 2026-04-26

### Fixed

- **Scrollbar-Styling** — Nativer Windows-Scrollbalken durch passenden Dark-Theme-Scrollbar ersetzt (Track: `slate-800`, Thumb: `slate-600`, Hover: `slate-500`, 8 px, border-radius 4 px). Gilt global für alle scrollbaren Bereiche. ([#64](https://github.com/skoedr/time-tracking/pull/64), closes [#63](https://github.com/skoedr/time-tracking/issues/63))

## [1.6.0] — 2026-04-26

### Added

- **CONTRIBUTING.md** — Dev-Setup (`pnpm install/dev/test/typecheck`), Branch-Konvention, Conventional Commits, PR-Regeln, i18n-Hinweis.
- **CODE_OF_CONDUCT.md** — Contributor Covenant 2.1.
- **SECURITY.md** — GitHub Private Security Advisory (bevorzugt) + E-Mail-Fallback, Scope (SQLite, Auto-Update, PDF, IPC).
- **PRIVACY.md** — Datenschutz-1-Pager: Alle Daten lokal, einziger Outbound-Call = Auto-Update gegen `api.github.com`, kein Telemetry.
- **Issue Templates** — `bug_report.yml`, `feature_request.yml`, `config.yml` (Blank Issues deaktiviert, Links zu Discussions + Security Advisory).
- **README.en.md** — Vollständige englische Übersetzung der README.
- **macOS-Build** — `build-macos`-Job in `release.yml`: arm64 DMG + ZIP, Smoke-Test, unsigned. `publish-release` wartet auf beide Plattformen.

### Changed

- `README.md` — Sprachbanner (Link zu README.en.md), neue Abschnitte Contributing, Privacy, Security.
- `electron-builder.yml` — `mac:`-Sektion ergänzt: `hardenedRuntime`, Entitlements, Targets `dmg`+`zip` für `arm64`.
- `package.json` — `"license": "MIT"`, `"repository"`, `"bugs"` ergänzt.

## [1.5.2] — 2026-04-25

### Security

- **Supply-Chain-Härtung** — `pnpm/action-setup` in beiden CI-Workflows auf einen
  festen Commit-SHA gepinnt (`fc06bc1...`), statt auf den mutablen `@v5`-Tag zu
  zeigen. Verhindert, dass ein kompromittierter Tag transparente Code-Ausführung im
  Release-Build-Runner ermöglicht.
- **Backup-Restore Path-Traversal behoben** — `backup:restore`-IPC-Handler prüft
  jetzt per `path.resolve`, dass der übergebene Dateipfad tatsächlich im Backups-
  Verzeichnis liegt. Pfade außerhalb werden mit einem Fehler abgelehnt.
- **URL-Öffner: `shell.openExternal` statt `shell.openPath`** — Links im About-Dialog
  (GitHub-Repository sowie Drittanbieter-Paket-Repositories) nutzen jetzt den dafür
  vorgesehenen `shell.openExternal`-IPC-Handler mit HTTP/HTTPS-Whitelist. Der neue
  Handler lehnt Nicht-HTTP-URLs ab.
- **CI-Permissions auf Least-Privilege** — `permissions: contents: write` aus dem
  Workflow-Scope von `release.yml` entfernt und auf den `publish-release`-Job
  beschränkt. Der `build-windows`-Job läuft nun mit `contents: read`.

## [1.5.1] — 2026-04-25

### Changed

- **Dokumentation** — README und ROADMAP auf v1.5.0-Stand gebracht: alle neuen
  Features (Auto-Update, Crash-Logging, Onboarding, CSV, i18n, Lizenz-Dialog) in
  der Feature-Liste, Project-Structure aktualisiert (schema v8, neue Dateien),
  Release-Anleitung korrigiert. ROADMAP markiert v1.5 als shipped.

## [1.5.0] — 2026-04-25

### Added

- **Lizenz-Hinweise** (#35, PR F) — Unter Einstellungen → Über findet sich ein
  neuer "Lizenzen & Über"-Button, der einen About-Dialog öffnet. Der Dialog zeigt
  App-Version, den MIT-Lizenztext von TimeTrack sowie eine durchsuchbare, aufklapp-
  bare Liste aller 95 gebündelten Drittanbieter-Pakete (Name, Version, SPDX-Bezeichner,
  Repository-Link und Lizenztext). Die Lizenzliste wird zur Build-Zeit automatisch von
  `scripts/generate-licenses.mjs` aus dem Produktions-Abhängigkeitsbaum generiert
  und als `resources/licenses.json` abgelegt. Der `prebuild`-Hook führt das Script
  bei jedem `pnpm build` automatisch aus.
- **Onboarding-Wizard** (#32, PR E) — Neuen Installationen wird beim ersten
  Start automatisch ein 3-stufiger Assistent angezeigt. **Schritt 1** wählt
  die Sprache (DE/EN, Umschalter wirkt live). **Schritt 2** legt optional den
  ersten Kunden an (Name, Stundensatz, Farbe). **Schritt 3** erklärt die
  globalen Hotkeys (Standard-Fenster `Alt+Shift+S`, Mini-Widget `Alt+Shift+M`)
  und bestätigt ggf. den erstellten Kunden. Der Assistent kann per "Überspringen"
  jederzeit abgebrochen werden. Bereits bestehende Installs (Upgrade von v1.4)
  zeigen den Wizard nicht — das Flag `onboarding_completed` wird via
  Migration 008 automatisch auf `1` gesetzt, wenn Einträge vorhanden sind.
  Unter Einstellungen → Allgemein → Onboarding kann der Wizard erneut ausgelöst
  werden (setzt das Flag zurück und zeigt den Wizard beim nächsten Start).
- **i18n-Foundation** (neu, PR D) — Mini-Übersetzungs-Infrastruktur ohne externe
  Abhängigkeiten. Locale-Dateien sind typsichere TypeScript-Objekte
  (`src/shared/locales/de.ts`, `en.ts`); TypeScript stellt sicher, dass EN
  alle DE-Keys enthält. React-Context `I18nProvider` + `useT()`-Hook stellen
  die `t()`-Funktion komponenten-übergreifend bereit. Locale wird in der
  bestehenden `language`-Einstellung persistiert und bei App-Start geladen.
  Migriert in v1.5: **UpdateBanner** (alle Update-Meldungen), **SettingsView**
  (Diagnose-Abschnitt, Updates-Abschnitt, Sprach-Auswahl). Restliche Views
  bleiben hardcoded auf DE und werden im v1.6-Backlog durch
  `scripts/find-untranslated.mjs` erfasst. Sprach-Umschalter unter
  Einstellungen → Sprache; Wechsel wirkt sofort auf migrierte Bereiche.
- **CSV-Export** (#18, PR C) — Das PDF-Export-Dialog ist jetzt ein
  einheitliches "Export"-Modal mit zwei Tabs: **PDF** (Stundennachweis,
  unverändert) und **CSV** (Tabelle für Excel / DATEV). Der CSV-Export enthält
  alle abgeschlossenen Einträge des gewählten Zeitraums mit den Spalten Datum,
  Start, Ende, Dauer, Kunde, Beschreibung, Tags, Stundensatz und Betrag.
  Zwei Formate wählbar: **DE** (Semikolon als Feldtrenner, Komma als
  Dezimalzeichen — passt direkt in Excel DE) und **US** (Komma / Punkt —
  für DATEV-Importe). Datei enthält UTF-8 BOM, damit Excel ohne Encoding-
  Abfrage öffnet. Tags werden `|`-getrennt ausgegeben (kein Konflikt mit
  dem Feldtrenner).
- **Auto-Update** (#28, PR B) — `electron-updater` prüft beim App-Start auf
  GitHub-Releases, lädt neue Versionen automatisch im Hintergrund und zeigt
  ein dezentes Indigo-Banner an, sobald die Installation bereit ist. Der
  User entscheidet, wann neu gestartet wird — kein Force-Restart, kein
  Datenverlust bei laufendem Timer. Settings → "Updates" zeigt aktuelle
  Version, Status und letzte Prüfung; manueller "Jetzt nach Updates suchen"-
  Button für ungeduldige User. Offline-Toleranz: stiller Fallback ohne rote
  Fehlerbanner beim ersten Start ohne Internet. Alle Updater-Events fließen
  in dieselbe Log-Datei wie PR A. Lokales Test-Setup via
  `scripts/test-updater.mjs` + `build/dev-app-update.yml`.
- **Crash-Logging** (#34, PR A) — `electron-log` schreibt App-Ereignisse und
  Fehler nach `%AppData%\TimeTrack\logs\main.log` (Windows; analoge Pfade auf
  macOS/Linux). Renderer-`console.*`-Aufrufe werden via IPC in dieselbe Datei
  gespiegelt, sodass Bug-Reports ein vollständiges Bild liefern. Globale
  Handler für `uncaughtException` und `unhandledRejection` erfassen Crashes,
  die sonst silent verschwinden würden. Log-Datei rotiert automatisch bei 5 MB.
  Settings → "Diagnose" zeigt den Pfad und bietet Buttons "Im Explorer zeigen"
  - "Ordner öffnen" zum schnellen Anhängen an Issue-Reports.

## [1.3.0] — 2026-04-25

### Added

- **Stundensatz pro Kunde** (#20) — Optionales Honorar-Feld in der Kunden­maske,
  gespeichert als Integer-Cents in `clients.rate_cent` (0 = kein Satz hinterlegt).
  Eingabe als deutsche Dezimalzahl (`85,00`); wird in PR C als €-Spalte im PDF
  ausgegeben. Reuse der bereits in v1.2-Migration 003 angelegten Spalte — keine
  zusätzliche Migration nötig.
- **Quick-Filter-Pillen im Kalender** (#21) — Vier Buttons („Diese Woche",
  „Letzte Woche", „Diesen Monat", „Letzter Monat") plus farbiger
  Hero-Button „📄 Letzter Monat als PDF" über dem Kalender. PR A liefert die
  Buttons + DST-sichere Range-Berechnung (`getQuickRange`); das eigentliche
  PDF-Modal landet in PR C.
- **Migration 004** — Seedet Settings-Schlüssel für die kommende
  PDF-Pipeline (`pdf_logo_path`, `pdf_sender_address`, `pdf_tax_id`,
  `pdf_accent_color` mit Default `#4f46e5`, `pdf_footer_text`,
  `pdf_round_minutes` mit Default `0`). Idempotent via `INSERT OR IGNORE`,
  überschreibt also keine vom User gesetzten Werte beim Replay.
- **Cross-Midnight Auto-Split** — Einträge, die lokale Mitternacht überqueren,
  werden im IPC-Layer automatisch in zwei (oder mehr) verlinkte Hälften
  aufgeteilt. Beide Hälften teilen sich eine UUID in der neuen Spalte
  `entries.link_id` (Migration 005, partieller Index `idx_entries_link_id`).
  Tagessummen, KW-Aggregate und PDF-Reports rechnen damit automatisch korrekt
  pro Tag. Der „nicht über Mitternacht möglich"-Hinweis im Eintrag-Dialog
  ist entfernt; DST-sicher (Frühling/Herbst getestet via `date-fns`).
  Löschen kaskadiert optional auf die Geschwister-Hälfte (`cascadeLinked`-Flag
  in `entries:delete`).
- **JSON-Vollexport** (#17) — Neuer Button „Export speichern …" in
  Einstellungen → Daten. Schreibt eine lesbare JSON-Datei mit `meta`
  (Schema-Version, Zeitstempel, App-Version), allen Kunden, allen Einträgen
  (inkl. soft-gelöschter und verlinkter Hälften) und allen Settings.
  Trust-Artefakt: User können ihre Daten byte-genau verifizieren; CSV/PDF
  bauen in PR C/D darauf auf.
- **PDF-Stundennachweis** (#16, #19) — Hero-Path: 1-Klick aus dem Kalender
  („📄 Letzter Monat als PDF" oder eine Quick-Filter-Pille) öffnet ein
  Modal, in dem Kunde + Zeitraum vorbelegt sind, und schreibt nach
  Bestätigung ein druckbares A4-PDF im deutschen Stundennachweis-Layout
  (Datum / Von / Bis / Tätigkeit / Dauer, optional Honorar wenn der Kunde
  einen Stundensatz hat). Logo, Absenderadresse, Steuernummer,
  Akzentfarbe, Footer-Text und optionale Stunden-Rundung
  (5/10/15/30 min) konfigurierbar in **Einstellungen → PDF-Vorlage**.
  Implementierung: Hidden `BrowserWindow` + `printToPDF`; das HTML-Template
  ist eine String-Render-Funktion mit base64-eingebettetem Logo und CSP
  `default-src 'none'; img-src data:; style-src 'unsafe-inline'` —
  kein `webSecurity:false` nötig, kein dritter Vite-Renderer-Entry.
  Honorar-Berechnung integer-cent: `Math.round(min × rateCent / 60)`,
  Ausgabe als deutsches Format `1.234,56 €`. Bei aktiver Rundung werden
  auch die angezeigten Von/Bis-Zeiten an die gerundete Dauer angeglichen
  (Regel: `displayedStart = round(rawStart, step)`,
  `displayedStop = displayedStart + roundedMinutes`), damit die
  PDF-Empfänger:in nie eine Zeile wie „18:54 – 19:18 → 0:30" sieht.
  Die Rundung selbst wird im PDF nicht erwähnt — Datenbank speichert
  weiterhin die echten Start/Stopp-Zeitstempel.
- **Unterschriftsfelder optional im PDF-Export** — Neue Checkbox im
  „Stundennachweis als PDF"-Modal (Default: aus). Wenn aktiviert, werden
  am Ende des Dokuments zwei Linien für Auftragnehmer / Auftraggeber
  gerendert. Pro Export wählbar — kein Setting nötig.
- **App- + Tray-Icons** (#16) — Neue Glass-Style-Icons aus dem
  Master-SVG `timetrack_icon_glass_final.svg`. `build/icon.png` (1024×1024)
  - `build/icon.ico` (16/24/32/48/64/128/256) für electron-builder,
    `resources/tray-running.png` (grün, läuft) und
    `resources/tray-stopped.png` (grau, idle) für die System-Tray. Die Tray
    wechselt das Glyph je nach Timer-State. Generator-Skript:
    `node scripts/generate-icons.mjs` (deps: `sharp`, `png-to-ico`).
- **Manueller Icon-Workflow** — `resources/icon.png` ist jetzt die
  Source-of-Truth für das App-Icon. `scripts/sync-icon.mjs` synchronisiert
  es vor jedem Build automatisch nach `build/icon.png` (1024×1024) und
  `build/icon.ico` (multi-res). Wird über den `prebuild`-npm-Hook
  ausgelöst, sodass `pnpm build:win` immer das aktuelle Icon zieht.
- **CI PDF-Smoke-Test** — Der Release-Workflow rendert beim Smoke-Test der
  gepackten `.exe` jetzt zusätzlich ein Mini-PDF (1 Eintrag, 1 Kunde) und
  prüft, dass `printToPDF` gegen das gepackte Chromium funktioniert
  (`pdfBytes >= 1000`). Catches Regressions in der PDF-Pipeline bevor ein
  Release rausgeht — nicht nur in der DB/ABI-Schicht.
- **GitHub Actions auf v5** (#42) — `actions/checkout`, `actions/setup-node`,
  `actions/upload-artifact`, `actions/download-artifact` jeweils auf `@v5`
  in `release.yml` und `test.yml`. `pnpm/action-setup@v4` bleibt (kein v5
  veröffentlicht).

### Changed

- **PDF-Rundung jetzt aufrundend** — `roundMinutes` rundet nicht mehr halb-
  auf-half-down, sondern aufwärts (ceil): jede angefangene Stufe wird voll
  berechnet (Standard-Abrechnungslogik „angebrochene Viertelstunde voll").
  Auch die Roh-Minuten-Berechnung im PDF nutzt `Math.ceil(ms/60000)`, damit
  ein Sub-Minuten-Eintrag (z. B. ein Test-Toggle) als 1 Roh-Minute zählt
  und mit step=15 als 15 Minuten ausgewiesen wird statt zu verschwinden.
  `roundMinutes(0, step)` bleibt 0 — kein Phantom-Billing für leere Einträge.
- **Kalender-Tagesbalken in Kundenfarbe** — Die Mini-Linien in den
  Kalenderzellen nutzen jetzt `client.color` statt einer einheitlichen
  Indigo-Farbe; Tooltip enthält zusätzlich den Kundennamen. Indigo-Fallback
  bleibt für nicht-aufgelöste `client_id`s.

### Fixed

- **Globaler Hotkey `Alt+Shift+S` aus Heute/Kalender** — `start()` brach
  still ab, wenn kein Kunde im Timer-Tab vorausgewählt war (seit v1.2 ist
  „Heute" Default-View und hat keinen Selector). Fällt jetzt auf den ersten
  aktiven Kunden zurück, sodass der Hotkey aus jedem Tab funktioniert.
- **Fokus-Sprung im „Eintrag nachtragen"-Modal** — Der `Dialog`-Effect
  hatte `onClose` in den Dependencies; mit Inline-Arrow als `onClose`
  und einem sekündlich tickenden Timer im Hintergrund lief der Effect
  jedes Mal neu und stahl den Fokus auf den ×-Schließen-Button. Effect
  hängt jetzt nur noch an `open`, Fokus-Selector priorisiert
  Form-Inputs vor Buttons.

## [1.4.1] — 2026-04-25

### Fixed

- App-Fenster zeigte "Electron" statt "TimeTrack" als Titel

## [1.4.0] — 2026-04-25

### Added

- **Mini-Widget** (#22) — Always-on-top 200×40-Overlay, das den laufenden
  Timer jederzeit im Blick behält. Kein Hauptfenster nötig.
  - `● Kundenname HH:MM:SS ■` (running) / `Kein Timer ▶` (idle) —
    beide Buttons wired: ▶ startet via erstem aktiven Kunden,
    ■ stoppt den laufenden Eintrag.
  - Ganzes Widget drag-region; Stop/Play als `no-drag-region`-Insel.
  - Transparent, `alwaysOnTop:'screen-saver'` (sichtbar über Vollbild-Apps),
    `visibleOnAllWorkspaces`, `skipTaskbar`.
  - Position rechts-unten als Default; Drag → 250ms-debounced-Persist in
    `settings (mini_x / mini_y)`. Off-Screen-Clamp bei Neustart wenn
    Monitor abgekoppelt wurde.
  - **Hotkey `Alt+Shift+M`** toggelt Sichtbarkeit (konfigurierbar in
    Settings). Getrennte Slot-Verwaltung von `hotkey_toggle` — kein
    `globalShortcut.unregisterAll` mehr; Hotkeys können unabhängig
    geändert werden.
  - **Cross-Slot-Kollisionsschutz:** Versuch, denselben Combo für beide
    Hotkeys zu setzen, liefert sofort den Fehler
    „Hotkey konnte nicht registriert werden" (kein stilles Überschreiben).
  - Hotkey-Capture in Settings suspendiert alle GlobalShortcuts während
    der Eingabe, sodass die bestehende Tastenkombi nicht mehr den
    Handler auslöst.
  - Startup-Konflikt (Combo von anderer App belegt, wenn
    `mini_enabled=1`): nicht-blockierendes `dialog.showMessageBox`.
  - State-Push via `mini:state-changed` von Main an Mini-Renderer auf
    jedem `tray:update`; `startedAt` wird im Widget lokal getickert
    (kein IPC-Polling).
  - Migration 006: seedet `mini_enabled='0'`, `mini_hotkey='Alt+Shift+M'`,
    `mini_x='-1'`, `mini_y='-1'` via `INSERT OR IGNORE`.
- **Tags pro Eintrag** (#24) — Freitextlabels, die jedem Zeitblock zugeordnet
  werden können und für schnelles Filtern, Auswerten und PDF-Gruppierung dienen.
  - Tags werden als `,tag1,tag2,` in einer neuen `entries.tags`-Spalte
    (Migration 007, `NOT NULL DEFAULT ''`) gespeichert; exakte LIKE-Suche
    via `,tag,` verhindert Fehlpositive.
  - **`TagInput`-Komponente** — Chip-Liste + Texteingabe in einem Feld.
    Tab/Enter/Komma übernimmt den getippten Tag, Backspace entfernt den
    letzten Chip. Autocomplete-Dropdown mit Vorschlägen aus den letzten
    90 Tagen (freq-sortiert via `tags:recent` IPC). Deterministische
    8-Farben-Chip-Palette (Tag-Name → `charCode % 8`). Validierung:
    Regex `[a-z0-9._-]`, max. 32 Zeichen/Tag, max. 10 Tags/Eintrag.
  - **`EntryEditForm`** — `TagInput` integriert; `tags`-Feld wird beim
    Anlegen und Bearbeiten via `entries:create` / `entries:update` gespeichert.
  - **Kalender-Drawer-Filter** — Jeder Eintrag zeigt Farb-Chips für seine
    Tags. Über die Tag-Pille-Bar im Header lässt sich die Tagesansicht
    auf einen einzelnen Tag filtern (Toggle); Zähler wechselt zu
    „X von Y Einträge" und der Leer-State zeigt „Keine Einträge mit Tag #x".
  - **PDF-Gruppen-Export** — Neue Checkbox „Nach Tag gruppieren" im
    PDF-Export-Modal. Bei aktiver Gruppierung rendert das PDF Abschnitte
    pro Tag (alphabetisch sortiert), jeder mit eigenem Subtotal-Bereich;
    Einträge ohne Tag landen in der Gruppe „Ohne Tag" (immer am Ende).
    Silent Fallback auf Flat-Layout wenn kein Eintrag im Zeitraum Tags hat.
- **Schnell-Notiz nach Stop** (#25) — Wenn ein Timer mit leerer Beschreibung gestoppt
  wird, erscheint ein Modal „Was war das?" mit 30s-Countdown-Progressbar.
  Beschreibung eingeben und Enter drücken — der Eintrag wird sofort aktualisiert.
  Escape oder Ablauf des Countdowns überspringen das Modal lautlos.
  TodayView und CalendarDrawer refreshen automatisch nach dem Speichern.

## [1.2.0] — 2026-04-24

### Added

- **Heute-Ansicht** (neuer Default-Tab) — Aktiver-Timer-Pille mit Live-Counter,
  zwei Stat-Cards (Heute / Diese Woche), Quick-Start-Reihe für die Top-3-Kunden
  der letzten 30 Tage, Liste der letzten 5 Einträge mit Bearbeiten/Löschen
  und „+ Eintrag nachtragen"-Dialog.
- **Kalender-Ansicht** — 7×N-Monatsraster mit KW-Spalte, Tagessumme und bis zu
  5 Mini-Bars pro Tag (mit „+N" für Überlauf), Tastatur-Navigation
  (Pfeil/Enter/Esc), heutige Zelle hervorgehoben.
- **Tages-Drawer** — Klick auf einen Kalendertag öffnet eine seitliche Liste
  aller Einträge des Tages. Inline-Bearbeitung, Inline-Anlegen via Sticky-Footer,
  Löschen mit Bestätigungsdialog.
- **Manuelles Anlegen & Bearbeiten** von Einträgen mit Server-seitiger
  Validierung (Überschneidungen, Beschreibungs-Länge, max. 24 h, Kunden-
  Existenz).
- **Soft-Delete + Rückgängig** — Gelöschte Einträge werden 5 Sekunden lang per
  Toast wiederherstellbar; die Einträge werden nicht hart gelöscht (`deleted_at`-
  Spalte) sodass spätere PDF-Referenzen stabil bleiben.
- **Tray-Tooltip mit Heute-Total** (#31) — Format `● Kunde · HH:MM · Heute HH:MM`
  bzw. `TimeTrack — Heute HH:MM` im Idle, aktualisiert über den 30-s-Heartbeat.
- **DESIGN.md-Stub** — Tokens für Farben, Typografie und Spacing als
  Design-Source-of-Truth.
- **Migration 003** — Spalten `clients.rate_cent` (v1.3-PDF-Vorbereitung) und
  `entries.deleted_at`, Index `idx_entries_started_at`, Backfill für legacy
  `rounded_min`-Werte. Pre-/Post-Apply-Logging und Assertion (negative
  Dauern lösen automatischen Rollback aus).
- **`dashboard:summary`-IPC** — Heute, Woche, letzte 5 Einträge und Top-3-Kunden
  in einer einzelnen Lese-Transaktion.
- **CI Smoke-Test** — Die Release-Pipeline startet die gepackte `.exe` mit
  `--smoke-test=…`, prüft Exit-Code, Schema-Version und Electron-ABI bevor das
  Artefakt veröffentlicht wird. Schließt die Klasse von ABI-Crashes (v1.1.x)
  vor dem Tag.

### Notes

- **Einträge über Mitternacht** werden in v1.2 abgelehnt; die Edit-Maske zeigt
  einen permanenten Hinweis, eine Lösung folgt in v1.3.
- **User-facing Rounding-UI** wurde aus v1.2 ausgenommen und kommt in v1.3
  zusammen mit dem PDF-Export.

## [1.1.2] — 2026-04-24

### Fixed

- **Installer crash on first launch** — The Windows installer in v1.1.0 and v1.1.1
  shipped a `better-sqlite3` binary compiled for Node.js (ABI 127) instead of
  Electron (ABI 140). The app crashed at startup with a `NODE_MODULE_VERSION`
  mismatch. The release workflow now uses `@electron/rebuild`, which handles
  pnpm's symlinked `node_modules` correctly and rebuilds against the bundled
  Electron version before packaging.

## [1.1.1] — 2026-04-24

### Fixed

- Attempted fix for the v1.1.0 native-module mismatch using
  `electron-builder install-app-deps` — turned out not to work reliably with
  pnpm. Superseded by v1.1.2.

## [1.1.0] — 2026-04-24

### Added

- **Idle-Detection** — When the system is idle longer than the configured
  threshold (default 5 minutes), a modal asks what to do with the time:
  _Weiter laufen lassen_, _Bei Inaktivität stoppen_, or _Als Pause markieren_.
  Driven by `powerMonitor.getSystemIdleTime()` in the main process.
- **Tray Quick-Start** — Right-click the tray icon to start a timer for any
  client directly, without opening the window. The menu rebuilds dynamically
  from the active-clients list and shows a _Stop_ entry while a timer runs.
- **Settings-View** — New _Einstellungen_ tab with sections _Allgemein_,
  _Timer_, _Daten_ and _Über_. Configure language, auto-start, idle threshold,
  global hotkey (with capture UI), and inspect data paths and backups.
- **Auto-Backup** — A daily SQLite backup runs at app startup, kept rolling
  for the last 7 days under `%AppData%\TimeTrack\backups\`. Manual backups,
  pre-migration backups and restore are exposed in the Settings view. Manual
  and pre-migration backups are never auto-rotated.
- **DB Migrations** — Versioned migration system (`src/main/migrations/`) with
  a `schema_version` table, transactional apply, and an automatic
  pre-migration backup. v1.1 ships migration `002` which seeds the new
  settings keys (`idle_threshold_minutes`, `language`, `auto_start`,
  `hotkey_toggle`).
- **Vitest setup** — First automated tests: shared `duration` helpers,
  migration system (10 tests), and backup rotation/restore (8 tests). Two
  Vitest projects (`node`, `jsdom`) so renderer hooks can use the DOM.
- **Automated Windows Release** — `.github/workflows/release.yml` builds the
  NSIS installer on Windows, runs the test suite, rebuilds native modules
  for the Electron ABI, and publishes a GitHub Release with the installer
  attached when a `v*` tag is pushed.

### Changed

- Hotkey is now configurable via the Settings view; failed re-binds revert
  the change and surface an inline error.
- The tray tooltip and context menu update on every `tray:update` IPC so the
  Quick-Start menu always reflects the current client list.

### For contributors

- Native-module rebuild for tests: CI runs `pnpm rebuild better-sqlite3`
  against Node 22 before `pnpm test`, then `pnpm exec electron-rebuild` against
  Electron before `electron-builder`.
- Vitest `testTimeout` and `hookTimeout` raised to 30 s — the Windows runner
  needs the headroom for the first cold-start `better-sqlite3` call.

## [1.0.0] — 2026-04-23

First public release. Windows NSIS installer.

### Added

- **Timer** — Start/stop time entries with client + description. Running timer
  shows elapsed time in `HH:MM:SS` with a pulsing color dot and client name.
  Press Enter in the description field to start.
- **Heartbeat** — Active entries write a heartbeat every 30 seconds. On startup,
  entries with a stale heartbeat (>5 min) are automatically stopped (crash recovery).
- **Kunden-Verwaltung** — Full CRUD for clients: create with name + color picker
  (10 presets), edit inline, archive (soft-delete), and delete with confirmation.
  Archived clients are grouped separately and grayed out.
- **Global Hotkey** — `Alt+Shift+S` toggles the timer from anywhere on the system,
  even when the app window is minimized or hidden.
- **Tray Icon** — App lives in the system tray. Tooltip shows `● ClientName` while
  a timer is running, `— Kein Timer aktiv` otherwise. Right-click context menu shows
  status, "Fenster anzeigen", and "Beenden".
- **Minimize to Tray** — Closing the window hides it to tray instead of quitting.
  Quit via tray context menu or `app.quit()`.
- **SQLite database** — `better-sqlite3` with WAL mode and foreign-key enforcement.
  Stored at `%AppData%\TimeTrack\timetrack.db`.
- **Context Bridge** — Full typed `window.api` with `clients`, `entries`, and
  `settings` namespaces. `contextIsolation: true`, `nodeIntegration: false`.
- **Zustand store** — `useTimerStore` holds all timer UI state. `useTimer` hook
  manages DB interactions, tick interval, and heartbeat interval.
- **Tailwind CSS 4** — Via `@tailwindcss/vite` plugin. Dark slate theme throughout.
- **TypeScript** — Strict types shared across main + renderer via `src/shared/types.ts`.
- **Windows Installer** — NSIS installer (`time-tracking-1.0.0-setup.exe`),
  Desktop + Startmenu shortcuts, custom install directory.

### Fixed

- Stale hotkey hint in TimerView (was "F5", now correctly shows `Alt+Shift+S`).
- Archived clients: action buttons (archive/edit/delete) are now always
  fully visible — only the color dot and name dim.
- Nav tabs gained a visible `focus-visible` ring for keyboard users.
- Color-picker `aria-label`/`title` now uses German color names instead of hex.
- Placeholder views (Kalender, Einstellungen) now show proper empty states.
