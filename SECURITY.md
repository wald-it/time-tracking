# Security Policy

## Supported Versions

Only the latest minor release receives security fixes.

| Version      | Supported          |
| ------------ | ------------------ |
| 1.x (latest) | :white_check_mark: |
| < 1.x        | :x:                |

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

### Option 1 — GitHub Private Security Advisory (preferred)

1. Go to https://github.com/wald-it/time-tracking/security/advisories/new
2. Describe the vulnerability with steps to reproduce it.
3. You will get a first response within **5 working days**.

### Option 2 — E-mail

Write to **robin.wald@hotmail.de** with the subject `[SECURITY] TimeTrack`.
Please encrypt sensitive details if you can.

## What happens next?

1. Confirmation of receipt (≤ 5 working days)
2. Assessment and severity rating
3. Fix developed and tested
4. Coordinated disclosure: patch release + advisory
5. Credit in the CHANGELOG (if you want it)

## Release integrity

**Release artifacts are not code-signed.** The Windows installer carries no
Authenticode signature, so Windows SmartScreen warns before running it. The
macOS build is signed ad hoc only and not notarized, so Gatekeeper blocks the
first start. To open it on macOS 15 and later: System Settings → Privacy &
Security → Open Anyway; on older versions: right-click → Open.

What you can check instead (from 1.22.0 on):

- **SHA-256 checksums** of every file are listed in the release notes.
  Windows: `Get-FileHash <file> -Algorithm SHA256`; macOS: `shasum -a 256 <file>`.
- **Build provenance:** every file is attested by the release workflow of this
  repository: `gh attestation verify <file> -R wald-it/time-tracking` confirms
  that it was built by GitHub Actions here and names the commit it was built from.

The **in-app updater** downloads updates from the GitHub release and checks them
against the SHA-512 in that release's `latest.yml`. Without a code-signing
certificate there is no publisher check: the update is exactly as trustworthy as
the GitHub release it comes from.

## Runtime

TimeTrack runs on **Electron 44** (44.9.3: Chromium 152.0.7977.167, Node
24.22.0), a line that receives upstream security updates until 2 March 2027
according to Electron's release schedule. The move to the next supported line is
planned before then. Up to 1.22, TimeTrack ran on Electron 39, which has had no
security updates since May 2026. The app loads only its own local user
interface — no remote web content — which limits how far a browser engine flaw
can be reached.

## Scope

TimeTrack is a desktop app without a server of its own. Relevant attack surfaces:

- **Local data** in the user's app data folder (`%APPDATA%\time-tracking\` on
  Windows, `~/Library/Application Support/time-tracking/` on macOS): the SQLite
  database `timetrack.sqlite`, its backups under `backups\` and the log files.
  Anyone with access to your user account can read them. The database and every
  backup also hold the iCal feed token and the webhook targets with their HMAC
  secrets; the Microsoft 365 tokens are kept in a separate file encrypted by the
  operating system (DPAPI / Keychain) and are not part of backups.
- **Local interfaces**, all off by default:
  - the MCP write bridge and the hardware-key (Stream Deck) bridge — a named
    pipe / Unix socket, each with its own random token file in the app data
    folder;
  - the iCal feed — an HTTP server on `127.0.0.1` only, with a random token in
    the URL;
  - the Microsoft 365 sign-in — a one-time listener on `127.0.0.1` / `::1`
    during login (OAuth with PKCE and state check).
- **Outbound connections:** the update check (GitHub), Microsoft 365 when
  connected, and webhooks to the targets you configure.
- **Files from elsewhere:** restoring a backup, the invoice PDF in the PDF merge,
  calendar data from Microsoft 365, and text that MCP clients write into entries.
- **Electron IPC** between the user interface and the main process.
