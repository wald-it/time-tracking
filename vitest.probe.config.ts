import { defineConfig } from 'vitest/config'
// Same Electron-only guard as the suite: the probe must run on the app's Node.
import './vitest.config'

// Runs the *.probe.ts files, which `pnpm test` does not pick up (they need a
// real file from the owner and print a report). `pnpm test --config
// vitest.probe.config.ts`; see src/main/entryLifecycle/backupProbe.probe.ts.
export default defineConfig({
  test: {
    name: 'probe',
    environment: 'node',
    include: ['src/**/*.probe.ts'],
    testTimeout: 600_000
  }
})
