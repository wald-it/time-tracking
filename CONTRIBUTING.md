# Contributing to TimeTrack

Thank you for wanting to contribute to TimeTrack! This document describes the
workflow for issues, pull requests, and local development.

> **Languages:** Repository documentation is English — new docs and changelog
> entries are written in English. Issues, PRs, and commit messages may be in
> **German or English**. Please keep code comments and variable names in
> **English**.

## Code of Conduct

By contributing you accept the [Code of Conduct](./CODE_OF_CONDUCT.md).
Please report violations to `robin.wald@hotmail.de`.

## Reporting a bug / proposing a feature

- **Bug:** Use the [bug report template](./.github/ISSUE_TEMPLATE/bug_report.yml).
  Please provide version, OS, and reproducible steps.
- **Feature:** Use the [feature request template](./.github/ISSUE_TEMPLATE/feature_request.yml).
  Describe the problem first, then the proposed solution.
- **Question / discussion:** Please use
  [GitHub Discussions](https://github.com/wald-it/time-tracking/discussions)
  instead of an issue.
- **Security vulnerability:** **No** public issue. See [SECURITY.md](./SECURITY.md).

### How issues are tracked

**Deliberately: not by milestone, and not by version label** (decision 2026-08-31). Both structures exist and both were abandoned — milestones after v1.9, the `v1.1`–`v1.5` labels after v1.5 — while the app is at v1.19. They order nothing today, and reviving them would be a new discipline rather than a return to an old one. At single-digit open issues, an ordering layer costs more upkeep than the overview it buys.

So: an open issue carries a type label (`bug`, `enhancement`) where one applies and nothing else. What is planned lives in [ROADMAP.md](./ROADMAP.md); what was deferred with a reason lives in [TODOS.md](./TODOS.md).

This is written down so the gap reads as a decision rather than as neglect — the next person to look will otherwise find "nine open issues, no milestones" and treat it as a defect.

**Revisit when either becomes true** (observable conditions, not a date): the open-issue count passes roughly 25, or more than one person works the tracker. Both break the assumption this rests on — that one maintainer holds the whole list in his head.

## Local development

Requirements: **Node.js 22** and **pnpm 10** (what CI uses), Windows or macOS.

```powershell
pnpm install        # dependencies + native modules (better-sqlite3 for Electron)
pnpm dev            # Electron + Vite dev server
pnpm test           # Vitest on the Electron binary in Node mode (see below)
pnpm typecheck      # tsc --noEmit for all tsconfig projects
pnpm lint           # ESLint
pnpm build          # typecheck + MCP server + electron-vite build (no installer)
pnpm build:unpack   # + unpacked app via electron-builder (dist/)
```

App data lands locally in `%AppData%\time-tracking\` (Windows) or
`~/Library/Application Support/time-tracking/` (macOS). You can safely back these
up or delete them during development.

### Tests and native SQLite

`pnpm test` starts Vitest via `scripts/run-vitest.mjs` on the Electron binary
in Node mode (`ELECTRON_RUN_AS_NODE=1`), so the suite runs on the Node version
the app ships. The MCP server uses the same launch path
(`src/main/mcpLaunch.ts`). Calling Vitest directly (`pnpm exec vitest`, an IDE
runner on the system Node) fails on purpose: `vitest.config.ts` refuses to load
outside Electron, with a hint to use `pnpm test`.

`better-sqlite3` is an N-API module (since
[#269](https://github.com/wald-it/time-tracking/issues/269)). Its package ships
prebuilt binaries under `node_modules/better-sqlite3/prebuilds/` that load
under Node and Electron alike, so **nothing is compiled**: there is no
`postinstall` rebuild, no `electron-rebuild` step in CI, and pnpm is told not
to build the package (`pnpm.ignoredBuiltDependencies` in `package.json`). Please
do not add a rebuild back: none is needed, and on a machine without Visual
Studio (Windows) or Xcode (macOS) it makes `pnpm install` fail.

A green run is **0 skipped** across all Vitest projects. If you see a
three-digit skip count, the environment is broken — not the code. There is
deliberately no absolute test count here — it goes stale with every PR and then
reads like a defect; a silently shrinking suite is instead guarded by
`src/test/vitestProjects.test.ts`, which fails when a `*.test.ts(x)` file is
not covered by any Vitest project.

**If tests fail with `ERR_DLOPEN_FAILED` / `NODE_MODULE_VERSION`:** the
install is broken (the prebuilt file for your platform is missing or was
replaced). Reinstall with `pnpm install --frozen-lockfile`.

Until 1.22 the module was built against the Electron ABI, and the rule here
was never to run `pnpm rebuild better-sqlite3`
([#151](https://github.com/wald-it/time-tracking/issues/151)). That trap is
gone with the N-API build.

## Pull request workflow

1. **Issue first** – except for very small fixes (typo, one-line bug).
   For larger features please reach consensus in the issue before you write
   code, so the PR does not have to be rejected.
2. **Branch convention:** `feat/v{X.Y}-{shortname}`, `fix/v{X.Y}-{shortname}`
   or `docs/v{X.Y}-{shortname}`. Example: `feat/v1.7-pdf-merge`.
3. **Small PRs.** One PR = one topic. Separate refactor and feature.
4. **Tests.** New logic in `src/main/` or `src/shared/` needs a
   Vitest test. Renderer-only changes (layout, styling) are fine without a test.
5. **Local checks before push:** `pnpm typecheck && pnpm lint && pnpm test`.
6. **Conventional Commits** (see below).
7. **PR description:** What, why, how tested, screenshots/GIFs for UI.

### Conventional Commits

```
<type>(<scope>): <kurze Zusammenfassung>

[optionaler Body]
```

Allowed types:

| Type       | Purpose                             |
| ---------- | ----------------------------------- |
| `feat`     | New user-visible feature            |
| `fix`      | Bug fix                             |
| `docs`     | Docs, README, plan files            |
| `chore`    | Build, dependencies, tooling        |
| `refactor` | Code restructuring without behavior change |
| `test`     | Add or improve tests                |
| `security` | Security-relevant change            |

Scope is optional but welcome (`csv`, `pdf`, `i18n`, `db`, `ipc`, …).

Examples:

- `feat(pdf): merge external timesheet pages into export (#42)`
- `fix(timer): stop drift after suspend/resume`
- `chore(deps): bump electron 39.0.1 -> 39.0.4`

## Style & architecture

- **TypeScript strict.** No `any` without justification.
- **Pure functions** in `src/shared/` – no Electron or DOM imports there.
- **DB migrations** are immutable. A new schema change = a new
  migration file in `src/main/migrations/` + bump the DB version.
- **i18n — mandatory since v1.8:** Every user-visible string **must** go through `useT()` /
  `t(key)` and have an entry in **both** locale files:
  `src/shared/locales/de.ts` (source of truth) and `src/shared/locales/en.ts`.
  Hardcoded German or English strings in JSX/TSX are a review blocker.
  Check with: `pnpm exec node scripts/find-untranslated.mjs`
- **No telemetry.** See [PRIVACY.md](./PRIVACY.md).

## i18n workflow

Since v1.8 all user-visible strings are bilingual (DE/EN). This pattern is
**mandatory** for every new UI change:

```typescript
// In Components / Views — Hook holen:
import { useT } from '../contexts/I18nContext'
const t = useT()

// Verwendung:
t('some.key')                          // einfacher String
t('some.key', { variable: value })    // Interpolation: Key enthält {variable}

// Wenn t an eine Hilfsfunktion weitergegeben wird:
import type { TFunction } from '../contexts/I18nContext'
function helper(t: TFunction) { ... }
```

Always add new keys to **both** files at the same time:

```typescript
// src/shared/locales/de.ts  ← Source of Truth
export const de = {
  myFeature: {
    title: 'Mein Feature',
    description: 'Beschreibung mit {name}'
  }
}

// src/shared/locales/en.ts  ← muss alle Keys aus de.ts spiegeln (TypeScript erzwingt es)
export const en: typeof de = {
  myFeature: {
    title: 'My Feature',
    description: 'Description with {name}'
  }
}
```

Keys are dot-namespaced and grouped by feature area
(`nav.*`, `settings.*`, `entry.*`, etc.). `pnpm exec node scripts/find-untranslated.mjs`
finds forgotten spots.

## Release process (maintainers only)

1. Merge stage PRs against `main` (squash).
2. Bump the version in `package.json`, turn `[Unreleased]` in `CHANGELOG.md` into the version heading.
3. Push the tag `v{X.Y.Z}` on that commit (or start the Release workflow from the tag). The workflow
   checks that tag, `package.json` and the built commit agree, builds Windows, macOS (arm64) and the
   Stream Deck plugin, checks the package contents, runs the packaged smoke test, attests build
   provenance and publishes the release with SHA-256 checksums.
4. Check the published release (notes, assets, `gh attestation verify` on one installer) → the
   auto-updater offers it to installed apps.

Artifacts are not code-signed (see [SECURITY.md](./SECURITY.md#release-integrity)).

## License

By submitting a PR you agree that your contribution is published under the
project's [MIT license](./LICENSE).
