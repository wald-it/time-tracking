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
import { FEED_TOKEN_KEY, SecretStore, webhookSecretKey, type SecretMode } from './secretStore'
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
 * The webhook targets with their secrets filled in — for delivery and for the
 * settings window. A target whose secret is stored but cannot be read comes
 * back with `secret: ''` and `secretUnreadable: true`.
 */
export function readWebhookTargets(db: Db, explicit?: SecretStore | null): WebhookTarget[] {
  const s = store(explicit)
  return parseWebhookTargets(row(db, 'webhook_targets')).map((t) => {
    if (!t.secretStored) return { ...t, secretUnreadable: undefined }
    const secret = s && s.mode === 'encrypted' ? s.get(webhookSecretKey(t.id)) : undefined
    return secret === undefined
      ? { ...t, secret: '', secretUnreadable: true }
      : { ...t, secret, secretUnreadable: undefined }
  })
}

/**
 * The `webhook_targets` blob to store for targets coming from the settings
 * window: secrets go to the store, the blob keeps none. Settles once the store
 * is on disk, so the caller writes the blob only after that.
 *
 * A target that arrives with an empty secret while its stored one is
 * unreadable keeps `secretStored`: the window cannot tell "left unchanged"
 * from "removed", and only the first keeps the target from going out
 * unsigned. A new secret clears the state.
 */
export async function prepareWebhookTargets(
  raw: string,
  explicit?: SecretStore | null
): Promise<string> {
  const s = store(explicit)
  const targets = parseWebhookTargets(raw)
  const out: WebhookTarget[] = []
  for (const t of targets) {
    const { secretUnreadable, ...rest } = t
    if (!s || s.mode === 'plain') {
      out.push(
        rest.secret === '' && rest.secretStored ? rest : { ...rest, secretStored: undefined }
      )
      continue
    }
    const key = webhookSecretKey(t.id)
    if (rest.secret !== '') {
      await s.set(key, rest.secret)
      out.push({ ...rest, secret: '', secretStored: true })
    } else if (rest.secretStored && secretUnreadable) {
      out.push({ ...rest, secretStored: true })
    } else {
      await s.set(key, '')
      out.push({ ...rest, secretStored: undefined })
    }
  }
  if (s && s.mode !== 'plain') {
    await s.prune('webhook:', new Set(out.map((t) => webhookSecretKey(t.id))))
    await s.flush()
  }
  return serializeWebhookTargets(out)
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

  db.transaction(() => {
    if (token !== '') writeRow(db, FEED_TOKEN_KEY, '')
    const stripped = targets.map((t) =>
      t.secret !== '' ? { ...t, secret: '', secretStored: true } : t
    )
    writeRow(db, 'webhook_targets', serializeWebhookTargets(stripped))
  })()
  log('secret store: secrets moved out of the database')
}
