import { configDefaults, defineConfig, type TestProjectInlineConfiguration } from 'vitest/config'
import { resolve } from 'path'

/**
 * #263: tests that need the whole process — JS and SQLite — in Europe/Berlin.
 * SQLite's 'localtime' reads the zone the process starts in and ignores a
 * `process.env.TZ` set later, so no test can pin it; the run has to start
 * there. The `berlin` project is therefore registered only when it does — on
 * a machine whose zone is Berlin, or in the berlin-zone CI job
 * (TZ=Europe/Berlin) — and plain `pnpm test` elsewhere leaves it out instead
 * of failing.
 *
 * On Windows a TZ variable moves JS to the named zone, but SQLite's 'localtime'
 * does not follow an IANA zone from TZ the way JS does; with TZ set there the
 * two clocks may disagree, so the project stays out. The test file's first
 * case checks that both clocks agree anyway.
 */
export const BERLIN_TESTS = 'src/**/*.berlin.test.{ts,tsx}'
export const RUNS_IN_BERLIN =
  Intl.DateTimeFormat().resolvedOptions().timeZone === 'Europe/Berlin' &&
  !(process.platform === 'win32' && process.env.TZ)

const berlinProject: TestProjectInlineConfiguration = {
  extends: true,
  test: {
    name: 'berlin',
    // Node environment, also for a .tsx file: these test main-process paths.
    environment: 'node',
    include: [BERLIN_TESTS],
    setupFiles: ['./src/test/isolateLogs.ts']
  }
}

export default defineConfig({
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer/src')
    }
  },
  test: {
    // CI Windows runners spend several seconds on the first better-sqlite3
    // call (cold cache + native module). 60s provides headroom for the
    // migration-backfill tests that need ~36s on slow CI runners.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: [
            'src/main/**/*.test.ts',
            'src/shared/**/*.test.ts',
            'src/mcp/**/*.test.ts',
            // src/test holds the shared test bootstrap and the meta-test that
            // checks these very patterns still cover every test file.
            'src/test/**/*.test.ts'
          ],
          exclude: [...configDefaults.exclude, BERLIN_TESTS],
          // No test writes into the real userData logs (#243).
          setupFiles: ['./src/test/isolateLogs.ts']
        }
      },
      ...(RUNS_IN_BERLIN ? [berlinProject] : []),
      {
        // The Stream Deck plugin is its own package (own node_modules, own
        // tsconfig, not part of the app build), but its pure modules — dial
        // model, touch-strip faces, layout contract — are testable here and
        // would otherwise have no suite at all.
        extends: true,
        test: {
          name: 'streamdeck',
          environment: 'node',
          include: ['streamdeck-plugin/src/**/*.test.ts']
        }
      },
      {
        extends: true,
        test: {
          name: 'jsdom',
          environment: 'jsdom',
          include: ['src/renderer/**/*.test.{ts,tsx}'],
          exclude: [...configDefaults.exclude, BERLIN_TESTS],
          setupFiles: ['./vitest.setup.ts']
        }
      }
    ]
  }
})
