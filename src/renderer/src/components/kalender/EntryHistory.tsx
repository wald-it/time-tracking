import { useEffect, useId, useState } from 'react'
import type { Client, EntryVersion, Project } from '../../../../shared/types'
import { collapseEntryVersions, diffEntryVersions } from '../../../../shared/entryHistory'
import type { EntryHistoryChange } from '../../../../shared/entryHistory'
import { useLocale, useT } from '../../contexts/I18nContext'
import { useEntriesStore } from '../../store/entriesStore'

const SOURCE_NAMES = [
  'app',
  'controller',
  'idle',
  'import',
  'mcp',
  'migration',
  'quicknote',
  'recovery',
  'tag-rename'
] as const

const DISCLOSURE =
  'min-h-[44px] text-left text-[12px] text-[var(--ink2)] hover:bg-[var(--key)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]'

export function EntryHistory({
  entryId,
  versionNo,
  clients,
  projects
}: {
  entryId: number
  versionNo?: number
  clients: Client[]
  projects: Project[] | null
}): React.JSX.Element {
  const t = useT()
  const [open, setOpen] = useState(false)
  const mutationVersion = useEntriesStore((s) => s.version)
  const id = useId()
  return (
    <div className="min-w-0">
      <button
        type="button"
        className={DISCLOSURE}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        {t('history.toggle')}
      </button>
      <div id={id}>
        {open && (
          <HistoryList
            key={`${entryId}:${versionNo}:${mutationVersion}`}
            entryId={entryId}
            clients={clients}
            projects={projects}
          />
        )}
      </div>
    </div>
  )
}

function HistoryList({
  entryId,
  clients,
  projects
}: {
  entryId: number
  clients: Client[]
  projects: Project[] | null
}): React.JSX.Element {
  const t = useT()
  const [versions, setVersions] = useState<EntryVersion[] | null>(null)
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true
    void window.api.entries
      .versions(entryId)
      .then((result) => {
        if (!active) return
        if (result.ok) setVersions(result.data)
        else setError(true)
      })
      .catch(() => {
        if (active) setError(true)
      })
    return () => {
      active = false
    }
  }, [entryId, attempt])

  if (error)
    return (
      <div role="alert" className="text-[12px] text-[var(--danger)]">
        {t('history.loadFailed')}
        <button
          type="button"
          className={DISCLOSURE}
          onClick={() => {
            setError(false)
            setVersions(null)
            setAttempt((a) => a + 1)
          }}
        >
          {t('history.retry')}
        </button>
      </div>
    )
  if (!versions)
    return (
      <p role="status" className="text-[12px] text-[var(--ink3)]">
        {t('common.loading')}
      </p>
    )
  if (!versions.length)
    return <p className="text-[12px] text-[var(--ink3)]">{t('history.empty')}</p>
  const groups = collapseEntryVersions(versions)
  const ordered = groups.flatMap((g) => g.versions)
  return (
    <ol aria-label={t('history.toggle')} className="m-0 list-none p-0">
      {groups.map((group) => (
        <li key={group.versions[0].version_id}>
          <VersionRow
            version={group.versions[0]}
            previous={ordered[ordered.indexOf(group.versions[0]) - 1]}
            clients={clients}
            projects={projects}
            capture={group.capture}
          />
          {group.versions.length > 1 && (
            <CaptureAdditions versions={group.versions} clients={clients} projects={projects} />
          )}
        </li>
      ))}
    </ol>
  )
}

function CaptureAdditions({
  versions,
  clients,
  projects
}: {
  versions: EntryVersion[]
  clients: Client[]
  projects: Project[] | null
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const t = useT()
  const id = useId()
  return (
    <>
      <button
        type="button"
        className={DISCLOSURE}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        {t('history.additions', { count: versions.length - 1 })}
      </button>
      <ol id={id} hidden={!open} className="m-0 list-none border-l border-[var(--line)] pl-3">
        {versions.slice(1).map((version, i) => (
          <li key={version.version_id}>
            <VersionRow
              version={version}
              previous={versions[i]}
              clients={clients}
              projects={projects}
            />
          </li>
        ))}
      </ol>
    </>
  )
}

function VersionRow({
  version,
  previous,
  capture,
  clients,
  projects
}: {
  version: EntryVersion
  previous?: EntryVersion
  capture?: boolean
  clients: Client[]
  projects: Project[] | null
}): React.JSX.Element {
  const t = useT()
  const { locale } = useLocale()
  // A source the app does not know yet (a newer writer) shows as stored.
  const sourceName = (source: string): string =>
    (SOURCE_NAMES as readonly string[]).includes(source)
      ? t(`history.sourceName.${source as (typeof SOURCE_NAMES)[number]}`)
      : source
  const formatDate = (iso: string): string => {
    const date = new Date(iso)
    return Number.isNaN(date.getTime())
      ? iso
      : date.toLocaleString(locale === 'en' ? 'en-GB' : 'de-DE')
  }
  const value = (v: EntryVersion, field: EntryHistoryChange): string => {
    switch (field) {
      case 'times':
        return (v.segments.length ? v.segments : [v])
          .map(
            (s) =>
              `${formatDate(s.started_at)} → ${s.stopped_at ? formatDate(s.stopped_at) : t('history.running')}`
          )
          .join('; ')
      case 'client':
        return clients.find((c) => c.id === v.client_id)?.name ?? `#${v.client_id}`
      case 'project':
        return v.project_id === null
          ? t('history.none')
          : (projects?.find((p) => p.id === v.project_id)?.name ?? `#${v.project_id}`)
      case 'billable':
        return t(v.billable ? 'history.yes' : 'history.no')
      case 'deleted':
      case 'restored':
        return ''
      default:
        return v[field] || t('history.none')
    }
  }
  const changes: EntryHistoryChange[] = previous
    ? diffEntryVersions(previous, version)
    : [
        'times',
        'client',
        'project',
        'description',
        'billable',
        // Optional fields only when set; a later diff row never repeats an unchanged value.
        ...(['tags', 'reference', 'private_note'] as const).filter((field) => version[field]),
        ...(version.deleted ? ['deleted' as const] : [])
      ]
  return (
    <div className="border-t border-[var(--line)] py-2 text-[12px] text-[var(--ink2)] [overflow-wrap:anywhere]">
      <div className="flex flex-wrap items-baseline gap-x-2">
        {capture && <span className="font-semibold">{t('history.capture')}</span>}
        <span className="font-num">{t('history.version', { number: version.version_no })}</span>
        <time className="font-num" dateTime={version.written_at}>
          {formatDate(version.written_at)}
        </time>
        <span>
          {t('history.source')}: {sourceName(version.source)}
        </span>
      </div>
      {version.reason && (
        <p className="m-0">
          {t('history.reason')}: {version.reason}
        </p>
      )}
      {changes.map((field) => (
        <p className="m-0 whitespace-pre-wrap" key={field}>
          {t(`history.field.${field}`)}
          {field !== 'deleted' && field !== 'restored' && (
            <>
              :{' '}
              <span className={field === 'times' ? 'font-num' : undefined}>
                {previous && <>{value(previous, field)} → </>}
                {value(version, field)}
              </span>
            </>
          )}
        </p>
      ))}
      {previous && !changes.length && <p className="m-0">{t('history.unchanged')}</p>}
    </div>
  )
}
