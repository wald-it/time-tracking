/**
 * Q32: the iCal feed token and the webhook secrets between the `settings`
 * table and the encrypted secret store (`secretStore.ts`).
 *
 * The database keeps everything that is not secret — the feed switches, the
 * webhook targets with their URLs and events, and per target the marker
 * `secretStored` — and the store keeps the secrets. Without system encryption
 * (`plain` mode) the secrets stay in the database as before. A target whose
 * stored secret cannot be read fails closed: it is not delivered, instead of
 * going out unsigned.
 *
 * `index.ts` registers the app's store once (`useSecretStore`); the readers
 * here fall back to the database when none is registered (tests, and the
 * short window before the store is loaded).
 */
import type Database from 'better-sqlite3'
import { dirname } from 'node:path'
import {
  FEED_TOKEN_KEY,
  SecretStore,
  webhookSecretKey,
  type SecretMode,
  type SecretStoreDeps
} from './secretStore'
import {
  parseWebhookTargets,
  serializeWebhookTargets,
  type WebhookTarget
} from '../shared/webhooks'

type Db = Database.Database

let active: SecretStore | null = null

/** Register the app's (loaded) store. */
export function useSecretStore(store: SecretStore | null): void {
  active = store
}

/** Load and migrate before registering IPC or starting integrations. */
export async function initializeSecrets(
  db: Db,
  dbPath: string,
  deps: Omit<SecretStoreDeps, 'dir'> = {}
): Promise<SecretStore> {
  const dir = dirname(dbPath)
  const s = new SecretStore({ ...deps, dir })
  await s.load()
  try {
    await migrateSecrets(db, s, dir, deps.log)
  } catch (err) {
    // Plain database values remain usable and are retried on the next start.
    deps.log?.(`secret store: migration failed (${(err as Error).name})`)
  }
  // eslint-disable-next-line react-hooks/rules-of-hooks -- Main-process store registration, not a React hook.
  useSecretStore(s)
  return s
}

function store(explicit?: SecretStore | null): SecretStore | null {
  return explicit === undefined ? active : explicit
}

function row(db: Db, key: string): string {
  return (
    (
      db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
        | { value: string }
        | undefined
    )?.value ?? ''
  )
}

function writeRow(db: Db, key: string, value: string): void {
  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).run(key, value)
}

/** How the secrets are kept right now — for the hint in the settings. */
export function secretStorageMode(explicit?: SecretStore | null): SecretMode {
  return store(explicit)?.mode ?? 'plain'
}

/** The iCal feed token, or '' when there is none (or it cannot be read). */
export function readFeedToken(db: Db, explicit?: SecretStore | null): string {
  const s = store(explicit)
  const plain = row(db, FEED_TOKEN_KEY)
  // A plain value in the database is either `plain` mode or not migrated yet.
  if (!s || s.mode === 'plain' || plain !== '') return plain
  return s.get(FEED_TOKEN_KEY) ?? ''
}

/** Store a new feed token. Settles once it is on disk. */
export async function writeFeedToken(
  db: Db,
  token: string,
  explicit?: SecretStore | null
): Promise<void> {
  const s = store(explicit)
  if (!s || s.mode === 'plain') {
    writeRow(db, FEED_TOKEN_KEY, token)
    return
  }
  await s.set(FEED_TOKEN_KEY, token)
  writeRow(db, FEED_TOKEN_KEY, '')
}

/**
 * The webhook targets with their secrets filled in for delivery.
 * A target whose secret is stored but cannot be read comes
 * back with `secret: ''` and `secretUnreadable: true`.
 */
export function readWebhookTargets(db: Db, explicit?: SecretStore | null): WebhookTarget[] {
  const s = store(explicit)
  return parseWebhookTargets(row(db, 'webhook_targets')).map((t) => {
    if (t.secret !== '' || !t.secretStored) return { ...t, secretUnreadable: undefined }
    const secret = s && s.mode === 'encrypted' ? s.get(webhookSecretKey(t.id)) : undefined
    return secret === undefined
      ? { ...t, secret: '', secretUnreadable: true }
      : { ...t, secret, secretUnreadable: undefined }
  })
}

/**
 * Only markers cross IPC, including in plain mode or after a failed migration.
 * `secretUnreadable` tells the window that a stored secret is missing on this
 * machine (a backup restored elsewhere, or an unreadable file), so it can say
 * so at the target; the secret itself never crosses.
 */
export function webhookTargetsForRenderer(db: Db, explicit?: SecretStore | null): string {
  const unreadable = new Set(
    readWebhookTargets(db, explicit)
      .filter((t) => t.secretUnreadable)
      .map((t) => t.id)
  )
  return serializeWebhookTargets(
    parseWebhookTargets(row(db, 'webhook_targets')).map((t) => ({
      ...t,
      secret: '',
      secretStored: t.secret !== '' || t.secretStored ? true : undefined,
      secretUnreadable: unreadable.has(t.id) ? true : undefined
    }))
  )
}

let feedTokenRecreated = false

/**
 * Set at startup when the feed is switched on but no token could be found, so
 * a new one was minted: the subscription URL changed (typically a backup
 * restored on another machine). Cleared when the user regenerates the token.
 */
export function markFeedTokenRecreated(value: boolean): void {
  feedTokenRecreated = value
}

export function wasFeedTokenRecreated(): boolean {
  return feedTokenRecreated
}

/** Resolve the feed token through the store, other feed settings through SQLite. */
export function feedSettings(db: Db): (key: string) => string {
  return (key) => (key === FEED_TOKEN_KEY ? readFeedToken(db) : row(db, key))
}

/**
 * The `webhook_targets` blob to store for targets coming from the settings
 * window: secrets go to the store, the blob keeps none. Settles once the store
 * is on disk, so the caller writes the blob only after that.
 *
 * An empty secret with `secretStored` keeps the previous secret. Explicit
 * clearing removes the marker. This also keeps an unreadable target closed.
 */
export async function prepareWebhookTargets(
  raw: string,
  explicit?: SecretStore | null,
  currentRaw = ''
): Promise<string> {
  const s = store(explicit)
  const targets = parseWebhookTargets(raw)
  const current = new Map(parseWebhookTargets(currentRaw).map((t) => [t.id, t]))
  const out: WebhookTarget[] = []
  for (const t of targets) {
    const rest = { ...t }
    delete rest.secretUnreadable
    const secret = rest.secret || (rest.secretStored ? (current.get(t.id)?.secret ?? '') : '')
    if (!s || s.mode === 'plain') {
      out.push(
        secret === '' && rest.secretStored ? rest : { ...rest, secret, secretStored: undefined }
      )
      continue
    }
    const key = webhookSecretKey(t.id)
    if (secret !== '') {
      await s.set(key, secret)
      out.push({ ...rest, secret: '', secretStored: true })
    } else if (rest.secretStored) {
      out.push({ ...rest, secretStored: true })
    } else {
      await s.set(key, '')
      out.push({ ...rest, secretStored: undefined })
    }
  }
  if (s && s.mode !== 'plain') {
    // Prune only targets the window really removed. A target the parser drops
    // for now (e.g. a URL half-typed when the field lost focus) is still in the
    // raw list and keeps its secret, so fixing the URL brings it back intact.
    const keep = new Set([...out.map((t) => t.id), ...rawTargetIds(raw)].map(webhookSecretKey))
    await s.prune('webhook:', keep)
    await s.flush()
  }
  return serializeWebhookTargets(out)
}

/** Ids of every object in the raw list, valid or not. */
function rawTargetIds(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((t) => (t && typeof t === 'object' ? (t as { id?: unknown }).id : undefined))
      .filter((id): id is string => typeof id === 'string' && id !== '')
  } catch {
    return []
  }
}

/**
 * Move plain secrets out of the database (at start). The file is written and
 * read back before the database rows are emptied, so a crash in between does
 * no harm and the next start does it again. A plain value in the database
 * wins over the file — after a restored backup it is the newer intent.
 */
export async function migrateSecrets(
  db: Db,
  s: SecretStore,
  dir: string,
  log: (m: string) => void = (): void => {}
): Promise<void> {
  if (s.mode === 'plain') return
  const token = row(db, FEED_TOKEN_KEY)
  const targets = parseWebhookTargets(row(db, 'webhook_targets'))
  const moving = targets.filter((t) => t.secret !== '')
  if (token === '' && moving.length === 0) return

  if (token !== '') await s.set(FEED_TOKEN_KEY, token)
  for (const t of moving) await s.set(webhookSecretKey(t.id), t.secret)
  await s.flush()

  // Read back from disk with a fresh store: only what really arrived there
  // may leave the database.
  const check = new SecretStore({ dir, box: s.boxForCheck() })
  await check.load()
  const arrived = (key: string, value: string): boolean => check.get(key) === value
  if (token !== '' && !arrived(FEED_TOKEN_KEY, token)) {
    log('secret store: migration read-back failed, secrets stay in the database')
    return
  }
  if (moving.some((t) => !arrived(webhookSecretKey(t.id), t.secret))) {
    log('secret store: migration read-back failed, secrets stay in the database')
    return
  }

  // secure_delete zeroes the replaced cells, so the old values do not linger in
  // freed page space that `db.backup()` would copy into every new backup.
  db.pragma('secure_delete = ON')
  db.transaction(() => {
    if (token !== '') writeRow(db, FEED_TOKEN_KEY, '')
    const stripped = targets.map((t) =>
      t.secret !== '' ? { ...t, secret: '', secretStored: true } : t
    )
    writeRow(db, 'webhook_targets', serializeWebhookTargets(stripped))
  })()
  log('secret store: secrets moved out of the database')
  scrubFreeSpace(db, log)
}

/**
 * Rewrite the file once after a migration: earlier values (an older feed token,
 * a changed webhook secret) may sit in free pages from before secure_delete.
 * VACUUM leaves no free space; the checkpoint clears the old frames out of the
 * WAL file. Best effort: a busy database (another reader) is retried at the
 * next migration, and the live rows are already clean.
 */
export function scrubFreeSpace(db: Db, log: (m: string) => void = (): void => {}): void {
  try {
    db.exec('VACUUM')
    db.pragma('wal_checkpoint(TRUNCATE)')
  } catch (err) {
    log(`secret store: free-space scrub skipped (${(err as Error).name})`)
  }
}
