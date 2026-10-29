import { readFileSync } from 'fs'
import { join } from 'path'
import { runInNewContext } from 'vm'
import { expect, it, vi } from 'vitest'

it('keeps smoke mode alive between probe windows until its report is written', () => {
  const source = readFileSync(join(__dirname, '../main/index.ts'), 'utf8')
  // Exercise the actual event wiring without starting Electron or the app DB.
  const registration = source.match(/app\.on\('window-all-closed', \(\) => \{[\s\S]*?\n\}\)/)?.[0]
  expect(registration).toBeDefined()
  for (const platform of ['win32', 'linux', 'darwin']) {
    for (const smokeTestArg of ['--smoke-test=report.json', undefined]) {
      const quit = vi.fn()
      let closeLastWindow: (() => void) | undefined
      runInNewContext(registration!, {
        app: {
          on: (_event: string, handler: () => void) => (closeLastWindow = handler),
          quit
        },
        process: { platform },
        smokeTestArg
      })
      closeLastWindow!()
      expect(quit, `${platform}, smoke=${smokeTestArg !== undefined}`).toHaveBeenCalledTimes(
        smokeTestArg === undefined && platform !== 'darwin' ? 1 : 0
      )
    }
  }
})
