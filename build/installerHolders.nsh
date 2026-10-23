; #222 — name the processes that hold files in the install folder.
;
; An update replaces the installed files in two steps that both give up on a
; busy file: the old uninstaller renames every file out of $INSTDIR and aborts
; on the first one it cannot move (uninstaller.nsh, un.atomicRMDir), and the
; 7z copy retries and then gives up (extractAppPackage.nsh). Both end in the
; same "TimeTrack cannot be closed" dialog, and neither names anything. The
; app-running check and the MCP holder handshake (installer.nsh) only reach
; TimeTrack's own processes; a foreign process with a file open in $INSTDIR is
; invisible to both. That is what blocked the v1.19.0 update (a crash handler
; of another vendor's software), and finding it took Resource Monitor.
;
; Neither failing step has a hook, so we look before they run: the Restart
; Manager answers "who has these files open", and we ask it about every file
; under $INSTDIR. Diagnostic only — nothing is ever terminated. Every failure
; inside this check counts as "no finding": it may miss a holder, but it must
; never be the reason an install stops.
;
; What it cannot see: a process whose only tie to $INSTDIR is its working
; directory. The Restart Manager tracks files, not directories.
;
; Installer only. The uninstaller build (BUILD_UNINSTALLER) compiles the same
; include, and with warnings as errors an unreferenced function fails it.

!ifndef BUILD_UNINSTALLER

!include "LogicLib.nsh"
!include "FileFunc.nsh"

; RM_PROCESS_INFO: RM_UNIQUE_PROCESS (4 + 8), strAppName (256 WCHAR),
; strServiceShortName (64 WCHAR), then four DWORDs.
!define TT_RM_PROCESS_INFO_SIZE 668
; More holders than this are summarised as a count. Keeps the dialog readable
; and the string below NSIS_MAX_STRLEN.
!define TT_RM_MAX_LISTED 8
; Bounds the walk if $INSTDIR is ever pointed at something much bigger than
; an app folder.
!define /ifndef TT_RM_MAX_FILES 5000

; ${APP_EXECUTABLE_FILENAME} is defined in electron-builder's common.nsh,
; which the generated script includes after this file. Functions are compiled
; where they stand, so they read the name from this variable; the macro at the
; end expands inside the install section, after common.nsh, and fills it.
Var TTAppExe
Var TTRmSession
; Files visited, and of those registered with the Restart Manager.
Var TTRmSeen
; 1 when the walk refused a file because of TT_RM_MAX_FILES.
Var TTRmCut
Var TTRmFiles
; 1 when the list holds a service or a system process.
Var TTHolderService
Var TTRmStatus
; Holders of the last pass, one per line; empty when there is nothing to report.
Var TTForeignHolders
Var TTHolderMsg

!macro TT_SAVE_REGISTERS
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  Push $8
  Push $9
!macroend

!macro TT_RESTORE_REGISTERS
  Pop $9
  Pop $8
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

; Registers every file below $INSTDIR<relative path on the stack> with the
; open session. Same walk as electron-builder's un.atomicRMDir, so it covers
; exactly the files the uninstaller will try to move.
Function ttRmRegisterDir
  Exch $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $0

  FindFirst $R1 $R2 "$INSTDIR$R0\*.*"
  loop:
    StrCmp $R2 "" done
    StrCmp $R2 "." next
    StrCmp $R2 ".." next
    IfFileExists "$INSTDIR$R0\$R2\*.*" 0 isFile
      Push "$R0\$R2"
      Call ttRmRegisterDir
      Goto next

    isFile:
      ; Counts visits, not successes: if registration keeps failing, a cap on
      ; successes would never bound the walk. Checked here, on a file, so that
      ; only a file actually left out counts as a cut.
      IntCmp $TTRmSeen ${TT_RM_MAX_FILES} cut 0 cut
      IntOp $TTRmSeen $TTRmSeen + 1
      ; RmRegisterResources takes an array of string pointers. One file per
      ; call keeps that array at a single element; registrations add up
      ; within a session.
      StrCpy $R3 "$INSTDIR$R0\$R2"
      StrLen $R4 $R3
      IntOp $R4 $R4 + 1
      System::Call '*(&w$R4 "$R3")p.r0'
      System::Call '*(p r0)p.R4'
      System::Call 'rstrtmgr::RmRegisterResources(i $TTRmSession, i 1, p R4, i 0, p 0, i 0, p 0)i.R3'
      System::Free $R4
      System::Free $0
      ${If} $R3 == 0
        IntOp $TTRmFiles $TTRmFiles + 1
      ${EndIf}

  next:
    FindNext $R1 $R2
    Goto loop

  cut:
    StrCpy $TTRmCut 1

  done:
  FindClose $R1

  Pop $0
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
FunctionEnd

; One pass: fills $TTForeignHolders with "image.exe (PID n)" lines for every
; process other than TimeTrack itself that holds a file under $INSTDIR, and
; $TTRmStatus with how the pass went (for the log only).
Function ttForeignHolderPass
  !insertmacro TT_SAVE_REGISTERS
  Push $R5
  Push $R6
  Push $R7
  Push $R8
  Push $R9

  StrCpy $TTForeignHolders ""
  StrCpy $TTRmSeen 0
  StrCpy $TTRmCut 0
  StrCpy $TTRmFiles 0
  StrCpy $TTHolderService 0
  StrCpy $7 0

  System::Call 'rstrtmgr::RmStartSession(*i .r1, i 0, w .r2)i.r0'
  ${If} $0 != 0
    StrCpy $TTRmStatus "RmStartSession=$0"
    Goto out
  ${EndIf}
  StrCpy $TTRmSession $1

  Push ""
  Call ttRmRegisterDir
  ${If} $TTRmFiles == 0
    StrCpy $TTRmStatus "no files registered"
    Goto endSession
  ${EndIf}

  ; First call asks for the count (ERROR_MORE_DATA = 234), second fetches.
  System::Call 'rstrtmgr::RmGetList(i $TTRmSession, *i .r5, *i 0, p 0, *i .r6)i.r0'
  ${If} $0 == 0
    StrCpy $TTRmStatus "ok, $TTRmFiles files, no holders"
    Goto endSession
  ${EndIf}
  ${If} $0 != 234
    StrCpy $TTRmStatus "RmGetList=$0"
    Goto endSession
  ${EndIf}

  ; Two spare entries absorb a holder that appears in between. If more appear,
  ; the fetch reports 234 again with the new count; take it and fetch again,
  ; up to three times, rather than report nothing.
  StrCpy $R8 0
  fetch:
    IntOp $R8 $R8 + 1
    IntOp $5 $5 + 2
    IntOp $R5 $5 * ${TT_RM_PROCESS_INFO_SIZE}
    ${If} $7 != 0
      System::Free $7
    ${EndIf}
    System::Alloc $R5
    Pop $7
    ${If} $7 == 0
      StrCpy $TTRmStatus "out of memory"
      Goto endSession
    ${EndIf}

    ; `*i r5 r6`: in from $5 (capacity), out to $6 (entries filled). A leading
    ; dot would mean "no input" and pass 0.
    System::Call 'rstrtmgr::RmGetList(i $TTRmSession, *i .r8, *i r5 r6, p r7, *i .r9)i.r0'
    ${If} $0 == 234
    ${AndIf} $R8 < 3
      StrCpy $5 $8
      Goto fetch
    ${EndIf}
  ${If} $0 != 0
    StrCpy $TTRmStatus "RmGetList=$0"
    Goto endSession
  ${EndIf}

  System::Call 'kernel32::GetCurrentProcessId()i.R9'
  StrCpy $R6 0 ; entries read
  StrCpy $R7 0 ; holders listed
  StrCpy $R8 0 ; holders beyond TT_RM_MAX_LISTED
  ${DoWhile} $R6 < $6
    IntOp $R5 $R6 * ${TT_RM_PROCESS_INFO_SIZE}
    IntOp $R5 $7 + $R5
    ; PID, start time (skipped), strAppName, strServiceShortName, ApplicationType
    System::Call '*$R5(i .r2, i, i, &w256 .r3, &w64 .r5, i .r1)'
    IntOp $R6 $R6 + 1

    ${If} $2 == $R9
      ${Continue}
    ${EndIf}

    ; The image name decides whether this is TimeTrack itself (the app on its
    ; way out during an update, or an MCP server running the app binary in
    ; Node mode). Those belong to the app-running check and the handshake.
    StrCpy $4 ""
    System::Call 'kernel32::OpenProcess(i 0x1000, i 0, i r2)p.r8' ; PROCESS_QUERY_LIMITED_INFORMATION
    ${If} $8 <> 0
      System::Call 'kernel32::QueryFullProcessImageNameW(p r8, i 0, w .r9, *i ${NSIS_MAX_STRLEN})i.r0'
      System::Call 'kernel32::CloseHandle(p r8)'
      ${If} $0 != 0
        ${GetFileName} $9 $4
      ${EndIf}
    ${EndIf}

    ${If} $4 == $TTAppExe
      ${Continue}
    ${EndIf}
    ${If} $4 == ""
      ; No access to the process (another user, elevated). Fall back to the
      ; name the Restart Manager reports, which is usually the product name.
      ${If} $3 == "${PRODUCT_NAME}"
        ${Continue}
      ${EndIf}
      StrCpy $4 $3
    ${EndIf}

    ; A service or a critical system process is not something the user can
    ; just close, so the line says what it is (RmService = 3, RmCritical = 1000).
    StrCpy $0 "PID $2"
    ${If} $1 == 3
      ${If} $LANGUAGE == 1031
        StrCpy $0 "$0, Windows-Dienst $5"
      ${Else}
        StrCpy $0 "$0, Windows service $5"
      ${EndIf}
    ${ElseIf} $1 == 1000
      ${If} $LANGUAGE == 1031
        StrCpy $0 "$0, Systemprozess"
      ${Else}
        StrCpy $0 "$0, system process"
      ${EndIf}
    ${EndIf}

    ${If} $1 == 3
    ${OrIf} $1 == 1000
      StrCpy $TTHolderService 1
    ${EndIf}

    ${If} $R7 < ${TT_RM_MAX_LISTED}
      ${If} $TTForeignHolders == ""
        StrCpy $TTForeignHolders "$4 ($0)"
      ${Else}
        StrCpy $TTForeignHolders "$TTForeignHolders$\r$\n$4 ($0)"
      ${EndIf}
      IntOp $R7 $R7 + 1
    ${Else}
      IntOp $R8 $R8 + 1
    ${EndIf}
  ${Loop}

  ${If} $R8 > 0
    StrCpy $TTForeignHolders "$TTForeignHolders$\r$\n(+$R8)"
  ${EndIf}
  StrCpy $TTRmStatus "ok, $TTRmFiles files, $6 entries"

  endSession:
  System::Call 'rstrtmgr::RmEndSession(i $TTRmSession)'
  ${If} $7 != 0
    System::Free $7
  ${EndIf}
  ${If} $TTRmCut == 1
    StrCpy $TTRmStatus "$TTRmStatus, walk stopped after ${TT_RM_MAX_FILES} files"
  ${EndIf}

  out:
  Pop $R9
  Pop $R8
  Pop $R7
  Pop $R6
  Pop $R5
  !insertmacro TT_RESTORE_REGISTERS
FunctionEnd

; DetailPrint is switched off for interactive installs (installSection.nsh),
; so the outcome goes to a file the user or support can open afterwards.
Function ttLogHolderPass
  Exch $R0 ; label for this line
  Push $0
  Push $1
  ClearErrors
  FileOpen $0 "$TEMP\TimeTrack-setup-holders.log" a
  ${IfNot} ${Errors}
    ; UTF-16 with a BOM: FileWrite would write the ANSI code page, and a user
    ; folder or a process name outside it would arrive as question marks.
    FileSeek $0 0 END $1
    ${If} $1 == 0
      FileWriteWord $0 0xFEFF
    ${EndIf}
    StrCpy $1 $TTForeignHolders
    ${If} $1 == ""
      StrCpy $1 "-"
    ${EndIf}
    FileWriteUTF16LE $0 "$R0 | $INSTDIR | $TTRmStatus | holders: $1$\r$\n"
    FileClose $0
  ${EndIf}
  ClearErrors
  Pop $1
  Pop $0
  Pop $R0
FunctionEnd

!macro TIMETRACK_FOREIGN_HOLDERS
  ; Nothing installed yet means nothing to replace — and $INSTDIR may then be
  ; any folder the user picked, which we have no business walking.
  StrCpy $TTAppExe "${APP_EXECUTABLE_FILENAME}"
  ${If} ${FileExists} "$INSTDIR\$TTAppExe"
    ttHoldersCheck:
      Call ttForeignHolderPass
      Push "pass 1"
      Call ttLogHolderPass
      StrCmp $TTForeignHolders "" ttHoldersDone

      ; A virus scanner opens files for a moment. Only a holder that is still
      ; there a second later is worth interrupting the install for.
      Sleep 1000
      Call ttForeignHolderPass
      Push "pass 2"
      Call ttLogHolderPass
      StrCmp $TTForeignHolders "" ttHoldersDone

      ; German or English, chosen at runtime. A LangString would have to be
      ; defined for every language electron-builder bundles (about 30), or the
      ; -WX build fails; the other languages get the English text.
      ${If} $LANGUAGE == 1031
        StrCpy $TTHolderMsg "Diese Programme verwenden noch Dateien im Installationsordner:$\r$\n$\r$\n$TTForeignHolders$\r$\n$\r$\nSolange sie laufen, kann das Update von ${PRODUCT_NAME} fehlschlagen. Beende sie und klicke auf Wiederholen."
        ${If} $TTHolderService == 1
          StrCpy $TTHolderMsg "$TTHolderMsg Einen Windows-Dienst hältst du in der Dienste-Verwaltung (services.msc) an. Einen Systemprozess kannst du nicht beenden; dann hilft Ignorieren oder ein Neustart von Windows."
        ${EndIf}
        StrCpy $TTHolderMsg "$TTHolderMsg$\r$\n$\r$\nMit Ignorieren läuft die Installation trotzdem weiter, mit Abbrechen endet sie."
      ${Else}
        StrCpy $TTHolderMsg "These programs are still using files in the install folder:$\r$\n$\r$\n$TTForeignHolders$\r$\n$\r$\nWhile they run, the ${PRODUCT_NAME} update can fail. Close them and click Retry."
        ${If} $TTHolderService == 1
          StrCpy $TTHolderMsg "$TTHolderMsg You can stop a Windows service in the Services console (services.msc). A system process cannot be closed; Ignore or restarting Windows helps then."
        ${EndIf}
        StrCpy $TTHolderMsg "$TTHolderMsg$\r$\n$\r$\nIgnore continues the installation anyway. Abort ends it."
      ${EndIf}

      MessageBox MB_ABORTRETRYIGNORE|MB_ICONEXCLAMATION "$TTHolderMsg" /SD IDIGNORE IDRETRY ttHoldersRetry IDIGNORE ttHoldersIgnore
      Push "user: abort"
      Call ttLogHolderPass
      Quit

    ttHoldersRetry:
      Push "user: retry"
      Call ttLogHolderPass
      Goto ttHoldersCheck

    ttHoldersIgnore:
      Push "user: ignore"
      Call ttLogHolderPass

    ttHoldersDone:
  ${EndIf}
!macroend

!endif
