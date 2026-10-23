; #198 — release the app binary before the installer tries to replace it.
;
; A bundled MCP server runs the *installed* binary in Node mode
; (src/main/mcpLaunch.ts), so it holds TimeTrack.exe open. It is a child of an
; AI client, has no window and no tray icon, and it carries the app's own
; executable name under a foreign parent process. That combination is what
; produces "TimeTrack cannot be closed" with nothing for the user to close.
;
; electron-builder's own check cannot be relied on here. It has two branches,
; and which one runs is decided by IS_POWERSHELL_AVAILABLE — a probe that
; reported "unavailable" on a machine where PowerShell plainly works (measured
; 2026-08-03). On that branch FIND_PROCESS/KILL_PROCESS fall back to
; tasklist/taskkill by image name, and the first attempt is a WM_CLOSE that a
; windowless process ignores by definition.
;
; So we ask before anyone kills anything. src/mcp/holders.ts defines a
; plain-file handshake every MCP server watches: a shutdown request under
; <userData>/mcp-holders makes it close its transport and exit on its own,
; which the client sees as a clean end rather than a crash. Writing that
; request here gives the manually started installer the same cooperative path
; the in-app updater takes (src/main/updater.ts), and only then do we fall
; through to the built-in check for anything that did not react.
;
; Verified 2026-08-03: silent install over three live MCP servers, all three
; withdrew their own registration and the install completed untouched.

; Defining customCheckAppRunning makes electron-builder skip the block in
; allowOnlyOneInstallerInstance.nsh that provides these two — and
; _CHECK_APP_RUNNING, which we still delegate to, needs both. Without them the
; build fails with `Invalid command: "${GetProcessInfo}"`.
!include "getProcessInfo.nsh"
Var pid

; #222 — foreign processes holding files in $INSTDIR (installer build only).
!include "installerHolders.nsh"

Var TTHolderDir

!macro TIMETRACK_HOLDER_DIR
  ; Default userData location. A custom TIMETRACK_DB_PATH moves the handshake
  ; with it; the installer cannot know about that, and for those installs this
  ; step is simply a no-op and the built-in check below still applies.
  StrCpy $TTHolderDir "$APPDATA\time-tracking\mcp-holders"
  ; #201 — hand the path to PowerShell through the environment instead of
  ; splicing it into a single-quoted literal: a profile path containing a
  ; quote (C:\Users\O'Brien\...) would end that literal early. nsExec children
  ; inherit the installer's environment, so $env:TT_HOLDER_DIR just works.
  System::Call 'Kernel32::SetEnvironmentVariable(t "TT_HOLDER_DIR", t "$TTHolderDir")'
!macroend

!macro customCheckAppRunning
  ; _CHECK_APP_RUNNING reads $IsPowerShellAvailable, so it still has to be set —
  ; we just do not gate our own work on it, for the reason given above.
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro TIMETRACK_HOLDER_DIR

  ; Are any MCP servers registered? No registration means nothing to coordinate.
  ; [Console]::Write on purpose: nsExec::ExecToStack captures the trailing
  ; newline that PowerShell's default output appends, so a count of zero
  ; arrives as "0\r\n" and a `!= "0"` comparison would ALWAYS enter the
  ; block — writing a shutdown request on every install, MCP integration or
  ; not. Console::Write emits the bare digits and nothing else.
  nsExec::ExecToStack `"$PowerShellPath" -NoProfile -C "[Console]::Write(@(Get-ChildItem -LiteralPath $$env:TT_HOLDER_DIR -Filter *.json -ErrorAction SilentlyContinue).Count)"`
  Pop $0
  Pop $1

  ${if} $0 != 0
    ; PowerShell itself failed (execution policy, AppLocker). The handshake is
    ; skipped and only the built-in check below runs — say so instead of
    ; silently reproducing the original #198 symptom.
    DetailPrint "MCP-Handshake uebersprungen (PowerShell-Aufruf fehlgeschlagen)"
  ${endIf}

  ${if} $0 == 0
  ${andIf} $1 != "0"
    DetailPrint "Fordere laufende MCP-Server zum Beenden auf..."
    ; Write the request, then wait for the registrations to disappear — each
    ; server removes its own file on the way out. No literal double quote in
    ; this command line: it would have to survive NSIS, CreateProcess and
    ; PowerShell's parser, so [char]34 sidesteps the question. Stale files from
    ; a crashed process only cost us the wait; the app side prunes them by
    ; liveness, so they can never block an install.
    ;
    ; The request carries both gates (#201): `nonce` for current servers, which
    ; exit when the nonce they saw at startup changes, and `requestedAt` for
    ; servers of v1.18 and earlier, which compare it against their start time —
    ; exactly the servers this installer meets during the first update after
    ; the change.
    nsExec::Exec `"$PowerShellPath" -NoProfile -C "$$q=[char]34; $$d=$$env:TT_HOLDER_DIR; New-Item -ItemType Directory -Force -Path $$d | Out-Null; Set-Content -LiteralPath (Join-Path $$d '.shutdown') -Value ('{' + $$q + 'requestedAt' + $$q + ':' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + ',' + $$q + 'nonce' + $$q + ':' + $$q + [guid]::NewGuid().ToString() + $$q + '}') -Encoding utf8; $$dl=(Get-Date).AddSeconds(8); while ((Get-Date) -lt $$dl -and @(Get-ChildItem -LiteralPath $$d -Filter *.json -ErrorAction SilentlyContinue).Count -gt 0) { Start-Sleep -Milliseconds 200 }"`
    Pop $0
  ${endIf}

  ; Built-in check, for the app window and anything that ignored the request.
  !insertmacro _CHECK_APP_RUNNING

  ; Last, so TimeTrack's own processes have had every chance to go: whatever
  ; still holds files now is something neither step above can reach.
  !ifndef BUILD_UNINSTALLER
    !insertmacro TIMETRACK_FOREIGN_HOLDERS
  !endif
!macroend

!macro customInstall
  ; Withdraw the request. Left lying around it would make every MCP server
  ; started afterwards exit the moment it saw it.
  !insertmacro TIMETRACK_HOLDER_DIR
  nsExec::Exec `"$PowerShellPath" -NoProfile -C "Remove-Item -LiteralPath (Join-Path $$env:TT_HOLDER_DIR '.shutdown') -Force -ErrorAction SilentlyContinue"`
  Pop $0
!macroend
