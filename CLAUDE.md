## Native SQLite — kein Rebuild-Schritt, und Tests nur über `pnpm test`

**Baue `better-sqlite3` nicht nach.** Kein `pnpm rebuild better-sqlite3`, kein
`electron-rebuild`, kein `install-app-deps` — auch nicht „nur kurz für die Tests",
auch nicht, wenn ein Testlauf `ERR_DLOPEN_FAILED` oder `NODE_MODULE_VERSION` meldet.

Seit #269 ist `better-sqlite3` ein N-API-Modul (Version 13). Das Paket bringt fertige
Binaries unter `node_modules/better-sqlite3/prebuilds/` mit, und dieselbe Datei lädt
unter Node und unter Electron. Es gibt deshalb nichts mehr zu kompilieren: kein
Rebuild im `postinstall`, kein erzwungener Rebuild in der CI, und pnpm baut das
Paket nicht selbst (`pnpm.ignoredBuiltDependencies` in `package.json`). Der
`postinstall` lädt nur noch die Electron-Binary (`scripts/ensure-electron.mjs`), weil
Electron ab 42 das nicht mehr selbst tut und `pnpm dev` sie braucht. Ein Rebuild würde die
mitgelieferte Binary nur durch eine selbst gebaute ersetzen, und auf einer Maschine
ohne Visual Studio (Windows) oder Xcode (macOS) bricht er `pnpm install` ab — die
Maschine des Owners hat kein Visual Studio.

- Tests laufen mit `pnpm test`. Das startet Vitest über `scripts/run-vitest.mjs` auf der
  Electron-Binary im Node-Modus, also auf dem Node, das die App mitbringt (Electron 44:
  Node 24), nicht auf dem Node der Maschine. Ein grüner Lauf ist **0 skipped** über alle
  Vitest-Projekte.
- `pnpm exec vitest` direkt (oder ein IDE-Runner auf dem System-Node) bricht sofort mit
  einem Hinweis auf `pnpm test` ab: `vitest.config.ts` lädt nur unter Electron. Früher
  scheiterte der direkte Aufruf an der ABI; seit N-API würde er laufen, aber auf dem
  falschen Node, deshalb die Sperre. Das ist kein Umgebungsproblem, das du „reparieren"
  sollst.
- Hier steht bewusst **keine absolute Testzahl**. Sie war ein Proxy für die Bedingung
  und veraltete mit jedem PR (zuletzt „596" gegen tatsächlich 969) — eine falsche Zahl
  liest sich wie ein Defekt und lädt zum „Reparieren" ein. Was die Zahl nebenbei
  absicherte — eine still schrumpfende Suite —, prüft `src/test/vitestProjects.test.ts`:
  jede `*.test.ts(x)` im Repo muss von einem Vitest-Projekt eingeschlossen sein, und
  jedes Projekt muss noch etwas finden.
- Dreistellige Skip-Zahlen bedeuten kaputte Umgebung, nie „grün". Melde das, statt
  weiterzumachen.
- Meldet ein Lauf `ERR_DLOPEN_FAILED` oder `NODE_MODULE_VERSION`, ist die Installation
  kaputt (die Prebuild-Datei fehlt oder wurde ersetzt): `pnpm install --frozen-lockfile`
  neu ausführen und melden, nicht nachbauen.

Hintergrund und Fehlersuche: CONTRIBUTING.md → „Tests and native SQLite"
([#269](https://github.com/wald-it/time-tracking/issues/269); die alte ABI-Falle:
[#151](https://github.com/wald-it/time-tracking/issues/151)).

## Owner-Karte (Zeiger)

Die Architektur-/Owner-Karte dieses Repos lebt zentral im Brain-Vault:
`E:/Development/_obsidian/cc-obsidian-brain/projects/timetrack/timetrack-architektur.md`
(Obsidian: `[[timetrack-architektur]]`).

**Pflege-Pflicht:** Bei jedem Merge, der Struktur, Datenfluss oder Betriebswege
ändert, wird die Karte dort im selben Zug nachgezogen. Die Sektion
„Fallen & Invarianten" ist kuratiert — nur mit Owner-Zeichnung ändern.

Die Technik-Doku bleibt im Repo (README.md, DESIGN.md, CONTRIBUTING.md); die
Karte ist die Owner-Sicht darüber, kein Ersatz.

