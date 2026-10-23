import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

// #269: the suite runs in the runtime the app ships — Electron in Node mode,
// started by `pnpm test` (scripts/run-vitest.mjs). Since better-sqlite3 is an
// N-API module it also loads under a system Node, so a direct `vitest` call
// would no longer fail on its own: it would pass on the host's Node instead of
// Electron's. Refuse it here, before any test runs.
if (!process.versions.electron) {
  throw new Error(
    [
      'Run the tests with `pnpm test`, not `vitest` directly.',
      '',
      `This process runs on Node ${process.versions.node}; the app ships Electron's own`,
      'Node, and the suite must run on that one. `pnpm test` starts Vitest on the',
      'Electron binary in Node mode (scripts/run-vitest.mjs).'
    ].join('\n')
  )
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
          // No test writes into the real userData logs (#243).
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
