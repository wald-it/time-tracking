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

describe('failed old-version uninstall (#358)', () => {
  it.each(['customUnInstallCheck', 'customUnInstallCheckCurrentUser'])(
    '%s logs the error and exits with 2 without a silent dialog',
    (hook) => {
      const src = code(holdersNsh)
      const macro = src.match(new RegExp(`^!macro ${hook}\\s*\\n([\\s\\S]*?)^!macroend`, 'm'))
      expect(macro, `${hook} must replace electron-builder's default handler`).not.toBeNull()
      expect(macro?.[1].trim()).toBe('Call ttHandleUninstallResult')

      const handler = src.match(/^Function ttHandleUninstallResult\n([\s\S]*?)^FunctionEnd/m)?.[1]
      expect(handler).toBeDefined()
      // Keep the upstream launch-error return and let a successful uninstall continue.
      expect(handler).toMatch(/IfErrors 0 \+3\s+DetailPrint [^\n]+\s+Return/)
      expect(handler).toMatch(/\$\{If\} \$R0 != 0[\s\S]*Quit\s+\$\{EndIf\}\s*$/)
      expect(handler).toMatch(/Push "uninstall failed: \$R0"\s+Call ttLogHolderPass\s+IfSilent/)

      // Follow the silent jump to its target: it must bypass the entire dialog
      // and reach SetErrorLevel/ Quit without a return or another blocking box.
      const silent = handler?.match(/IfSilent (\w+)\s*\n([\s\S]*?)^\s*\1:\s*\n([\s\S]*)/m)
      expect(silent).not.toBeNull()
      expect(silent?.[3]).toMatch(/^\s*SetErrorLevel 2\s+Quit\s+\$\{EndIf\}\s*$/)
      expect(silent?.[3]).not.toMatch(/MessageBox/)
      expect(silent?.[2]).toContain('${If} $LANGUAGE == 1031')
      expect(silent?.[2]).toContain('Die alte Version von TimeTrack konnte nicht entfernt werden.')
      expect(silent?.[2]).toContain('The old version of TimeTrack could not be removed.')
      const boxes = silent?.[2].match(/MessageBox [^\n]*/g) ?? []
      expect(boxes).toHaveLength(1)
      expect(boxes[0]).toContain('"$TTHolderMsg" /SD IDOK')

      // Reuse #222's append-only UTF-16 log, including its error-code label.
      const logger = src.match(/^Function ttLogHolderPass\n([\s\S]*?)^FunctionEnd/m)?.[1]
      expect(logger).toContain('FileOpen $0 "$TEMP\\TimeTrack-setup-holders.log" a')
      expect(logger).toContain('FileWriteUTF16LE $0 "$R0 |')
    }
  )
})
