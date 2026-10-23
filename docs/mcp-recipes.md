# MCP recipes

Recipes are prompts for the TimeTrack MCP server, written for recurring jobs: logging time you forgot, preparing the monthly close, and checking a period for gaps. They only use the server's own tools, and before every change they show a preview and wait for your consent.

## Where to find them

The server offers each recipe as an MCP prompt:

- Claude Desktop lists the server's prompts in the chat input. Pick one and fill in its fields.
- Claude Code offers them as slash commands, for example `/mcp__timetrack__nachtrag`.
- In a client without prompt support, copy the text below into the chat and replace the fields in angle brackets.

To set up the server in a client, use the block from **Settings → Integrations** (see the README, "MCP Integration"). Claude Desktop takes the same block in its `claude_desktop_config.json` under `mcpServers`.

## How recipes change data

A recipe never changes anything without asking. Every change runs first with `preview: true`, and a preview creates and changes nothing in TimeTrack. Only after you agree does the model repeat the same call without `preview`. Write access has to be switched on under **Settings → Integrations** for that second step, and depending on your settings TimeTrack asks for confirmation as well.

The monthly close follows no format for descriptions unless you give it one in the `format` field.

## The recipes

The texts below are generated from `src/mcp/recipes.ts`; a test keeps them in step.

<!-- recipes:start -->

## Zeit nachtragen (`nachtrag`)

Einen vergessenen Eintrag aus einem Satz nachtragen, mit Vorschau vor dem Anlegen.

- `was`: Was nachgetragen werden soll, z. B. "gestern 14 bis 16 Uhr Workshop bei Acme"

```text
Trag diese Zeit in TimeTrack nach: <was>

1. Finde Kunde und Projekt mit list_clients und list_projects. Passt mehr als eines oder keines, frag mich.
2. Bestimme Beginn und Ende als Zeitstempel mit Zeitzone. Fehlt eine Uhrzeit, frag nach, statt sie zu raten.
3. Prüf mit list_entries für denselben und den vorigen Tag, ob sich der Eintrag mit einem bestehenden überschneidet (auch mit einem, der am Vorabend begann und über Mitternacht lief), und sag es mir.
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
3. Liste auf, was ich mir ansehen sollte: Einträge ohne Beschreibung, Einträge über zehn Stunden, nicht abrechenbare Einträge, Einträge ohne Projekt bei Kunden mit Projekten und Überschneidungen.
4. Schlag für Einträge mit fehlender oder unklarer Beschreibung einen Text vor, im Stil der übrigen Beschreibungen des Monats.
5. Änderungen nur einzeln mit update_entry_fields und nur nach meiner Zustimmung. Jede Änderung zuerst mit preview:true aufrufen und die Vorschau zeigen. Eine Vorschau legt in TimeTrack nichts an und ändert nichts. Erst wenn ich zustimme, denselben Aufruf ohne preview wiederholen und danach bestätigen, was angelegt oder geändert wurde.
6. Schließ mit den Summen aus Schritt 1: Stunden je Kunde, davon abrechenbar, gerundet wie die Rechnung.
```

## Zeiten auf Plausibilität prüfen (`plausibilitaet`)

Einen Zeitraum auf Lücken, lange Tage und vergessene Timer prüfen, ohne etwas zu ändern.

- `von`: Erster Tag als YYYY-MM-DD
- `bis`: Letzter Tag als YYYY-MM-DD

```text
Prüf meine Zeiten in TimeTrack von <von> bis <bis> auf Plausibilität.

1. Hol die Tagessummen mit get_report, gruppiert nach day.
2. Prüf mit get_running_timer, ob ein Timer seit mehr als zwölf Stunden läuft.
3. Prüf mit list_projects, welche Projekte ihr Budget fast oder ganz verbraucht haben.
4. Stell mir Fragen statt Schlüsse zu ziehen: Werktage ohne Eintrag, Tage über zehn Stunden, Arbeit am Wochenende, ein lange laufender Timer, knappe Budgets.
5. Ändere in diesem Durchgang nichts.
```

<!-- recipes:end -->
