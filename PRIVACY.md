# Privacy

TimeTrack stores your data **locally** on your device. It has no server of its
own, no TimeTrack account, no telemetry and no analytics.

In its basic operation it makes one kind of network request: the **update
check** against GitHub, which you can switch off. Everything else that leaves the device does so only
through an integration **you switch on** — each is described below with what it
sends and to whom.

## Where is the data?

| Type                | Windows                                    | macOS                                                          |
| ------------------- | ------------------------------------------ | -------------------------------------------------------------- |
| Database + settings | `%APPDATA%\time-tracking\timetrack.sqlite` | `~/Library/Application Support/time-tracking/timetrack.sqlite` |
| Backups             | `%APPDATA%\time-tracking\backups\` (or the folder you chose) | `~/Library/Application Support/time-tracking/backups/` (or the folder you chose) |
| Log files           | `%APPDATA%\time-tracking\logs\`            | `~/Library/Logs/time-tracking/`                                |
| Exports (PDF, CSV, iCal, JSON) | where you save them             | where you save them                                            |

**Backups:** a daily backup (the last 7 are kept), plus a backup before every
database update, before a restore, before the first MCP write of a session, and
when you make one by hand. Backups are full copies of the database — they
include the iCal feed token and the webhook targets with their secrets. The JSON
export leaves those secrets out.

**Logs:** `main.log` (app events and errors, including messages from the user
interface), `webhooks.log` (per delivery only the target host and, on failure,
the kind of error — never the payload or a secret) and `mcp-writes.log` (one line
per write through MCP: operation, entry and client id, times — never the content
of an internal note and never the token).

**Deleting your data:** uninstalling the app does not delete the data folder.
Delete the folders listed above to remove everything.

## Basic operation: update check

When the installed app starts, `electron-updater` asks GitHub
(`github.com/wald-it/time-tracking` releases) whether a new version exists and,
if so, downloads it in the background; you decide in the app when to install.
The request carries no user identifier, no device data and no time entries —
GitHub sees the usual request data (IP address, user agent).

You can turn this off under **Settings → About → Updates** with **Check for
updates automatically**. The switch applies from the next start: a check that
already ran in the current session, and a download it started, are not undone.
From then on the app makes no request at start and downloads nothing on its own.
It contacts GitHub only when you click **Check for updates now**; if that check
finds a new version, the app downloads it in the background as above.

## Optional integrations (all off until you set them up)

### Microsoft 365 calendar import

- **Switched on by:** connecting an account under **Settings → Integrations →
  Microsoft account**.
- **Sign-in:** OAuth in your browser with Microsoft (`login.microsoftonline.com`),
  PKCE and a one-time listener on `127.0.0.1`. TimeTrack uses its own public
  app registration unless you enter your own client ID.
- **Permissions:** `Calendars.Read`, `offline_access`, `openid`, `profile`.
  `Presence.ReadWrite` is requested only if you switch on Teams presence
  mirroring.
- **What is read** (`graph.microsoft.com`), only when you import: your calendar
  events in the chosen date range — subject, start, end, all-day/cancelled flags,
  free/busy status, organizer, attendees and your response. Attendee e-mail
  domains are used locally to suggest the client; the domain-to-client mappings
  you confirm are stored in the database.
- **What is sent to Microsoft:** nothing from your time entries. With presence
  mirroring on, your Teams presence is set while a timer runs.
- **Tokens:** stored in a separate file in the data folder, encrypted by the
  operating system (DPAPI / Keychain), not part of backups or exports.
  **Disconnect** deletes that file; revoking the app's access in your Microsoft
  account is done there.

### Webhooks

- **Switched on by:** adding a target URL under **Settings → Integrations →
  Webhooks**.
- **Recipient:** only the URLs you enter.
- **What is sent** per event (`timer.started`, `timer.stopped`, `entry.created`,
  `entry.updated`, as you choose per target): the entry's id, description,
  start, stop, duration, billable flag, tags, reference, and client and project
  (id and name). The **hourly rate and revenue** and the **internal note** are
  added only when the matching privacy switches under **Settings → Integrations**
  are on (**Settings → Integrations → Privacy**) — the same switches that control
  what MCP clients may read.
- Each delivery is signed with the target's HMAC secret when one is set
  (header `X-TimeTrack-Signature`).

### iCal feed

- **Switched on by:** enabling it under **Settings → Integrations → Calendar
  feed (webcal)**.
- Served only on `127.0.0.1` (this computer), protected by a random token in
  the URL; a calendar app on the same computer can subscribe to it.
- **Content:** the last 90 days of entries — client, description, tags and
  times. Never rates, revenue or internal notes.

### MCP (AI clients such as Claude)

- **Switched on by:** registering the TimeTrack MCP server in your AI client
  (the ready-made block is under **Settings → Integrations**). The AI client
  starts the server on your computer; it reads the database read-only.
- **What leaves the device:** whatever the AI client reads through the tools —
  clients, projects, entries, totals — goes to the provider of your AI client as
  part of your conversation. Hourly rates, revenue and internal notes are hidden
  unless you switch them on.
- **Writing** (create/edit entries, start/stop the timer) is a separate opt-in
  (**Settings → Integrations → Write access**),
  goes through the running app, asks for confirmation per change by default and
  is logged in `mcp-writes.log`.

### Hardware keys (Stream Deck)

- **Switched on by:** enabling it under **Settings → Integrations → Hardware keys**.
- The plugin talks to the app on this computer only, with its own token. It can
  start and stop the timer and read the clients, projects and totals it shows;
  it sends nothing elsewhere.

## No tracking

- No telemetry service (e.g. Sentry, Mixpanel, Amplitude)
- No analytics (e.g. Google Analytics, Plausible)
- No crash reporter to third parties
- No advertising, no monetization via user data

## Third-party dependencies

All bundled open-source libraries and their licenses are listed in
**Settings → About → Licenses** (generated into `resources/licenses.json`).

## Contact

Privacy questions: robin.wald@hotmail.de
