/**
 * #222 — the installer names foreign processes that hold files in the install
 * folder (build/installerHolders.nsh). NSIS cannot be imported or run here, so
 * these are source assertions, the same kind as the installer guard in
 * src/mcp/holders.test.ts: they catch a removal or a rename, they do not prove
 * the script runs. What it does at runtime is checked with real installer runs.
 *
 * Each assertion pins a decision that a later edit could undo while every
 * other test stays green.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const buildDir = join(__dirname, '..', '..', 'build')
const holdersNsh = readFileSync(join(buildDir, 'installerHolders.nsh'), 'utf8')
const installerNsh = readFileSync(join(buildDir, 'installer.nsh'), 'utf8')

/** Script text without NSIS comments, so a comment that names a forbidden call does not count. */
function code(nsh: string): string {
  return nsh
    .split(/\r?\n/)
    .filter((line) => !/^\s*[;#]/.test(line))
    .join('\n')
}

describe('installer foreign-holder check (#222)', () => {
  it('never terminates a process', () => {
    // Diagnostic only, by decision: a foreign process may be a crash handler
    // or a driver helper, and killing it is not ours to do.
    for (const call of [
      'TerminateProcess',
      'taskkill',
      'Stop-Process',
      'KILL_PROCESS',
      'KillProcess',
      'RmShutdown'
    ]) {
      expect(code(holdersNsh), call).not.toContain(call)
    }
  })

  it('lets a silent install continue past the dialog', () => {
    // /S runs updates without a user; a dialog that defaulted to Abort would
    // turn every silent update with a holder into a failure.
    const box = code(holdersNsh).match(/MessageBox [^\n]*/)
    expect(box?.[0]).toContain('/SD IDIGNORE')
  })

  it("leaves TimeTrack's own processes to the app-running check", () => {
    // During an in-app update the app is still exiting when this runs, and MCP
    // servers run the app binary; naming them would blame TimeTrack for itself.
    const src = code(holdersNsh)
    expect(src).toContain('StrCpy $TTAppExe "${APP_EXECUTABLE_FILENAME}"')
    expect(src).toContain('${If} $4 == $TTAppExe')
  })

  it('only walks a folder that holds an installation', () => {
    // On a fresh install $INSTDIR can be any folder the user picked.
    expect(code(holdersNsh)).toContain('${FileExists} "$INSTDIR\\$TTAppExe"')
  })

  it('uses electron-builder defines only inside the macro', () => {
    // common.nsh defines APP_EXECUTABLE_FILENAME after this include is read.
    // A function that names it compiles against an undefined symbol, and with
    // warnings as errors the installer build fails (seen on the first build).
    const functions = code(holdersNsh).match(/^Function [\s\S]*?^FunctionEnd/gm) ?? []
    expect(functions.length).toBeGreaterThan(0)
    for (const fn of functions) expect(fn).not.toContain('${APP_EXECUTABLE_FILENAME}')
  })

  it('runs last in the app-running check, in the installer build only', () => {
    const src = code(installerNsh)
    expect(src).toContain('!include "installerHolders.nsh"')
    const macro = src.slice(src.indexOf('!macro customCheckAppRunning'))
    const body = macro.slice(0, macro.indexOf('!macroend'))
    const builtIn = body.indexOf('!insertmacro _CHECK_APP_RUNNING')
    const ours = body.indexOf('!insertmacro TIMETRACK_FOREIGN_HOLDERS')
    expect(builtIn).toBeGreaterThan(-1)
    expect(ours).toBeGreaterThan(builtIn)
    expect(body.slice(builtIn, ours)).toContain('!ifndef BUILD_UNINSTALLER')
  })
})
