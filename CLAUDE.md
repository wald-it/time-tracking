## Native SQLite-ABI — eine Regel, die du nicht umgehen darfst

**Führe niemals `pnpm rebuild better-sqlite3` aus.** Auch nicht „nur kurz für die Tests",
auch nicht, wenn ein Testlauf `ERR_DLOPEN_FAILED` oder `NODE_MODULE_VERSION` meldet.

`better-sqlite3` wird gegen die **Electron**-ABI gebaut, weil die App das zur Laufzeit
braucht. `pnpm rebuild` ersetzt die Binary durch einen Node-ABI-Build und lässt dabei den
Cache-Marker `node_modules/better-sqlite3/build/Release/.forge-meta` unverändert. Da
`electron-builder install-app-deps` nur diesen Marker liest, wird jedes spätere
`pnpm install` zum stillen No-op: die App kann ihre eigene Datenbank nicht mehr öffnen,
und **kein** Kommando meldet einen Fehler. Der Marker lügt.

- Tests laufen mit `pnpm test`. Das startet Vitest über `scripts/run-vitest.mjs` auf der
  Electron-Binary im Node-Modus — dieselbe Lösung wie beim MCP-Server
  (`src/main/mcpLaunch.ts`). Ein grüner Lauf ist **0 skipped** über alle Vitest-Projekte.
- Hier steht bewusst **keine absolute Testzahl** mehr. Sie war ein Proxy für die
  Bedingung und veraltete mit jedem PR (zuletzt „596" gegen tatsächlich 969) — eine
  falsche Zahl liest sich wie ein Defekt und lädt zum „Reparieren" ein. Was die Zahl
  nebenbei absicherte — eine still schrumpfende Suite —, prüft jetzt
  `src/test/vitestProjects.test.ts`: jede `*.test.ts(x)` im Repo muss von einem
  Vitest-Projekt eingeschlossen sein, und jedes Projekt muss noch etwas finden.
- `pnpm exec vitest` direkt aufzurufen kann nicht funktionieren und scheitert mit einer
  Anleitung. Das ist kein Umgebungsproblem, das du „reparieren" sollst.
- Dreistellige Skip-Zahlen bedeuten kaputte Umgebung, nie „grün". Melde das, statt
  weiterzumachen.
- Ist die Binary doch einmal falsch: `pnpm exec electron-rebuild -f -w better-sqlite3`.
  Das `-f` ist zwingend — ohne erzwungenen Rebuild gewinnt der lügende Marker.
- Dasselbe gilt in der CI, und zwar nicht theoretisch: pnpm hebt native
  Build-Ergebnisse in seinem Store über Läufe hinweg auf, weshalb dort ein
  vergiftetes Paar aus Node-Binary und Electron-Marker überleben kann. Die
  Workflows erzwingen den Rebuild deshalb direkt nach dem Install. Diesen Schritt
  bitte nicht als überflüssig wegkürzen.

Hintergrund und Fehlersuche: CONTRIBUTING.md → „Tests und die native SQLite-ABI"
([#151](https://github.com/wald-it/time-tracking/issues/151)).

## Owner-Karte (Zeiger)

Die Architektur-/Owner-Karte dieses Repos lebt zentral im Brain-Vault:
`E:/Development/_obsidian/cc-obsidian-brain/projects/timetrack/timetrack-architektur.md`
(Obsidian: `[[timetrack-architektur]]`).

**Pflege-Pflicht:** Bei jedem Merge, der Struktur, Datenfluss oder Betriebswege
ändert, wird die Karte dort im selben Zug nachgezogen. Die Sektion
„Fallen & Invarianten" ist kuratiert — nur mit Owner-Zeichnung ändern.

Die Technik-Doku bleibt im Repo (README.md, DESIGN.md, CONTRIBUTING.md); die
Karte ist die Owner-Sicht darüber, kein Ersatz.

## Roadmap (Zeiger)

Die Roadmap (1.23.0 → 2.0.0 → 2.x, Stand je Posten) ist eine private Seite des Owners:
https://claude.ai/artifact/3vtyNj65S422pxXcSyLcsm. Erzeugt wird sie im Brain-Vault mit
`tools/timetrack-roadmap.py`; welches Issue zu welchem Meilenstein gehört, steht in
`projects/timetrack/roadmap/roadmap.toml`.

**Aktualisierungspflicht:** Wer in einer Session PRs mergt, Issues anlegt oder schließt oder den
Stand eines Meilensteins ändert, aktualisiert die Seite am Ende der Session:
`python tools/timetrack-roadmap.py --check` (Exit 1 heißt: neue offene Issues erst in der TOML
zuordnen), dann ohne `--check` erzeugen, die Ausgabe `cockpit/timetrack-roadmap.html` lesen und
unter derselben URL neu veröffentlichen. Eine Session ohne Vault-Zugriff oder ohne
Artifact-Werkzeug meldet ihre Änderungen an die Session, die die Roadmap pflegt.

