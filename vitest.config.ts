import { configDefaults, defineConfig } from 'vitest/config'
import { resolve } from 'path'

const BERLIN_TESTS = 'src/**/*.berlin.test.ts'

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
      {
        // #263: tests that need the whole process — JS and SQLite — in
        // Europe/Berlin, which only the environment can provide (see the setup
        // file). CI runs them in the Linux job with TZ=Europe/Berlin; the UTC
        // Windows/macOS jobs leave the project out.
        extends: true,
        test: {
          name: 'berlin',
          environment: 'node',
          include: [BERLIN_TESTS],
          setupFiles: ['./src/test/isolateLogs.ts']
        }
      },
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
          setupFiles: ['./vitest.setup.ts']
        }
      }
    ]
  }
})
