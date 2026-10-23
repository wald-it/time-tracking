/**
 * Vitest setup for the `berlin` project (#263): its tests only mean something
 * when the whole process — JS and SQLite — runs in Europe/Berlin.
 *
 * The zone cannot be pinned from inside a test file for these paths: SQLite's
 * 'localtime' does not follow a `process.env.TZ` set at runtime (on Windows
 * not at all). It has to come from the environment the runner starts in —
 * `TZ=Europe/Berlin` on the Linux CI job, or a machine whose system zone is
 * Berlin. Anywhere else this fails loudly instead of skipping, so a run in the
 * wrong zone can neither pass nor hide as "0 failed, n skipped".
 */
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone

if (zone !== 'Europe/Berlin') {
  throw new Error(
    `The "berlin" Vitest project needs the process zone Europe/Berlin, got "${zone}". ` +
      `Start the run with TZ=Europe/Berlin (Linux/macOS), or leave the project out ` +
      `with --project '!berlin'. Setting process.env.TZ inside a test does not ` +
      `reach SQLite's 'localtime'.`
  )
}
