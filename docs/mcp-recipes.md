# MCP recipes

Recipes are prompts for the TimeTrack MCP server, written for recurring jobs: logging time you forgot, preparing the monthly close, and checking a period for gaps. They only use the server's own tools, and before every change they show a preview and wait for your consent.

## Where to find them

The server offers each recipe as an MCP prompt:

- Claude Desktop lists the server's prompts in the chat input. Pick one and fill in its fields.
- Claude Code offers them as slash commands, for example `/mcp__timetrack__nachtrag`.
- In a client without prompt support, copy the text below into the chat and replace the fields in angle brackets.

For `nachtrag` in Claude Code, run the command without an argument and give the full sentence when asked in chat. A sentence after the command reaches the recipe only up to its first space. If you supply `was`, the recipe quotes what arrived and asks you to confirm that it is complete before proceeding.

To set up the server in a client, use the block from **Settings → Integrations** (see the README, "MCP Integration"). Claude Desktop takes the same block in its `claude_desktop_config.json` under `mcpServers`.

## How recipes change data

A recipe never changes anything without asking. Every change runs first with `preview: true`, and a preview creates and changes nothing in TimeTrack. Only after you agree does the model repeat the same call without `preview`. Write access has to be switched on under **Settings → Integrations** for that second step, and depending on your settings TimeTrack asks for confirmation as well.

The monthly close follows no format for descriptions unless you give it one in the `format` field. It marks findings on billed entries with their billing run numbers and only proposes or makes changes to entries whose `billed` field is null.

## The recipes

The texts below are generated from `src/mcp/recipes.ts`; a test keeps them in step.

<!-- recipes:start -->

## Zeit nachtragen (`nachtrag`)

Einen vergessenen Eintrag aus einem Satz nachtragen, mit Vorschau vor dem Anlegen.

- `was` (optional): Was nachgetragen werden soll, als ganzer Satz. In Claude Code ohne Argument aufrufen, dann fragt das Rezept im Chat danach; nach dem Befehl kommt nur das erste Wort an.

```text
Trag diese Zeit in TimeTrack nach: (bitte frag mich im Chat nach dem ganzen Satz, der nachgetragen werden soll)

1. Finde Kunde und Projekt mit list_clients und list_projects. Passt mehr als eines oder keines, frag mich.
2. Bestimme Beginn und Ende als Zeitstempel mit Zeitzone. Fehlt eine Uhrzeit, frag nach, statt sie zu raten.
3. Prüf mit list_entries für jeden Tag, den der neue Eintrag berührt, und für den Tag davor, ob er sich mit einem bestehenden überschneidet (auch mit einem, der am Vorabend begann und über Mitternacht lief), und sag es mir.
4. Leg den Eintrag mit create_manual_entry an. Jede Änderung zuerst mit preview:true aufrufen und die Vorschau zeigen. Eine Vorschau legt in TimeTrack nichts an und ändert nichts. Erst wenn ich zustimme, denselben Aufruf ohne preview wiederholen und danach bestätigen, was angelegt oder geändert wurde.
```

## Monatsabschluss vorbereiten (`monatsabschluss`)

Einen Monat vor der Abrechnung durchsehen: was an den Einträgen fehlt oder auffällt, dazu die Summen.

- `monat`: Monat als YYYY-MM, z. B. 2026-10
- `format` (optional): Wie Beschreibungen aussehen sollen. Leer lassen, dann gilt keine Formatregel.

```text
Bereite den Monatsabschluss für <monat> in TimeTrack vor.

1. Hol die Summen mit get_report über den ganzen Monat, gruppiert nach client und project.
2. Hol die Einträge des Monats mit list_entries und die Projekte der Kunden mit list_projects.
3. Liste auf, was ich mir ansehen sollte: Einträge ohne Beschreibung, Einträge über zehn Stunden, nicht abrechenbare Einträge, Einträge ohne Projekt bei Kunden mit Projekten und Überschneidungen. Kennzeichne Befunde zu Einträgen mit billed als abgerechnet und nenne die Laufnummern.
4. Schlag nur für Einträge mit billed null und fehlender oder unklarer Beschreibung einen Text vor, im Stil der übrigen Beschreibungen des Monats.
5. Ändere nur Einträge mit billed null, einzeln mit update_entry_fields und nur nach meiner Zustimmung. Gib die version aus list_entries als expected_version mit. Jede Änderung zuerst mit preview:true aufrufen und die Vorschau zeigen. Eine Vorschau legt in TimeTrack nichts an und ändert nichts. Erst wenn ich zustimme, denselben Aufruf ohne preview wiederholen und danach bestätigen, was angelegt oder geändert wurde. update_entry_fields behält die id und liefert den Eintrag mit der neuen version (auch version_no) zurück; nimm für jede weitere Änderung diese version als expected_version.
6. Hol die Summen danach erneut mit get_report, weil Änderungen sie verschieben, und schließ damit: Stunden je Kunde, davon abrechenbar, gerundet wie die Rechnung.
```

## Zeiten auf Plausibilität prüfen (`plausibilitaet`)

Einen Zeitraum mit dem Regelcheck prüfen, dazu Lücken, vergessene Timer und knappe Budgets, ohne etwas zu ändern.

- `von`: Erster Tag als YYYY-MM-DD
- `bis`: Letzter Tag als YYYY-MM-DD

```text
Prüf meine Zeiten in TimeTrack von <von> bis <bis> auf Plausibilität.

1. Hol die Kunden mit list_clients (include_archived:true). Ruf für jeden Kunden check_period mit client_id und from/to für diesen Zeitraum auf. Übernimm dessen Befunde zu Beschreibungen, Projekten, Abrechenbarkeit, fehlenden Sätzen, langen Einträgen und Tagen, Arbeitszeiten, Wochenenden und Formatregeln.
2. Hol die Tagessummen mit get_report, gruppiert nach day, und suche Lücken zwischen Arbeitstagen.
3. Prüf mit get_running_timer, ob ein Timer seit mehr als zwölf Stunden läuft.
4. Prüf mit list_projects, welche Projekte ihr Budget fast oder ganz verbraucht haben.
5. Ein Tag fehlt in get_report auch dann, wenn dort nur ein laufender Timer oder Einträge ohne Dauer stehen. Hol einmal list_entries mit from/to über den ganzen Zeitraum (lokale Mitternacht am ersten Tag bis zur lokalen Mitternacht nach dem letzten Tag, jeweils mit Zeitzone) und limit:10000. Ist count größer als entries.length, wiederhole die Abfrage für kleinere Abschnitte, bis alle Einträge vorliegen. Vergleiche die belegten Tage mit den Tagen aus get_report; beachte bei Einträgen über Mitternacht auch segments.
6. Lass gesetzliche Feiertage aus, bevor du nach Werktagen ohne Eintrag fragst; kennst du mein Bundesland oder meine Region nicht, frag mich einmal danach. TimeTrack hat keine Feiertagsdaten. Stell mir Fragen statt Schlüsse zu ziehen: zu den Befunden von check_period, den übrigen Werktagen ohne Eintrag, einem lange laufenden Timer und knappen Budgets.
7. Ändere in diesem Durchgang nichts.
```

<!-- recipes:end -->
