import { useEffect, useRef, useState } from 'react'
import type { Entry } from '../../../shared/types'
import { useEntriesStore } from '../store/entriesStore'
import { useT } from '../contexts/I18nContext'

const TIMEOUT_S = 30

interface Props {
  entry: Entry
  onDone: () => void
}

export function QuickNoteModal({ entry, onDone }: Props): React.JSX.Element {
  const t = useT()
  const [text, setText] = useState('')
  const [remaining, setRemaining] = useState(TIMEOUT_S)
  const inputRef = useRef<HTMLInputElement>(null)
  // eslint-disable-next-line react-hooks/purity -- #142: dauerhaft — useRef-Initialwert, Umbau ohne beobachtbaren Effekt
  const deadlineRef = useRef(Date.now() + TIMEOUT_S * 1000)
  const bumpVersion = useEntriesStore((s) => s.bumpVersion)

  // Auto-focus input
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Countdown + auto-dismiss
  useEffect(() => {
    const tick = setInterval(() => {
      const r = Math.max(0, Math.round((deadlineRef.current - Date.now()) / 1000))
      setRemaining(r)
      if (r <= 0) onDone()
    }, 250)
    return () => clearInterval(tick)
  }, [onDone])

  // Escape = skip
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onDone()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onDone])

  const save = async (): Promise<void> => {
    const desc = text.trim()
    if (desc) {
      await window.api.entries.update({
        id: entry.id,
        client_id: entry.client_id,
        description: desc,
        started_at: entry.started_at,
        // entry was just stopped so stopped_at is always set here
        stopped_at: entry.stopped_at!,
        tags: entry.tags
      })
      bumpVersion()
    }
    onDone()
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') void save()
  }

  // Bar grows left→right as time elapses (0% = just opened, 100% = time up)
  const progressPct = ((TIMEOUT_S - remaining) / TIMEOUT_S) * 100

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgb(0_0_0/0.35)]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="quicknote-title"
    >
      <div
        className="w-[420px] rounded-[var(--r-disp)] p-6 border"
        style={{ background: 'var(--key)', borderColor: 'var(--line)' }}
      >
        <h2
          id="quicknote-title"
          className="mb-1 text-xl font-semibold"
          style={{ color: 'var(--ink)' }}
        >
          {t('quicknote.title')}
        </h2>
        <p className="mb-4 text-sm" style={{ color: 'var(--ink2)' }}>
          {t('quicknote.body')}
        </p>

        <input
          ref={inputRef}
          type="text"
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            // Reset deadline so the modal doesn't close while the user is typing
            deadlineRef.current = Date.now() + TIMEOUT_S * 1000
          }}
          onKeyDown={handleKeyDown}
          placeholder={t('quicknote.placeholder')}
          className="mb-4 w-full rounded-[var(--r-key)] px-3 py-2.5 text-sm border outline-none
            focus:ring-2 focus:ring-[var(--focus)] focus:border-transparent"
          style={{
            background: 'var(--key)',
            borderColor: 'var(--line)',
            color: 'var(--ink)'
          }}
        />

        {/* Progress bar */}
        <div
          className="mb-5 h-1 w-full overflow-hidden rounded-[var(--r-fine)]"
          style={{ background: 'var(--line)' }}
        >
          <div
            className="h-1 rounded-[var(--r-fine)] bg-[var(--ink)] transition-none"
            style={{ width: `${progressPct}%` }}
          />
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void save()}
            disabled={!text.trim()}
            className="flex-1 rounded-[var(--r-key)] bg-[var(--inv)] px-4 py-2.5 text-sm font-medium
              text-[var(--inv-ink)] key-hover disabled:opacity-40 disabled:cursor-not-allowed
              focus:outline-none focus:ring-2 focus:ring-[var(--focus)]"
          >
            {t('common.save')}
          </button>
          <button
            type="button"
            onClick={onDone}
            className="rounded-[var(--r-key)] px-4 py-2.5 text-sm font-medium border
              key-hover focus:outline-none focus:ring-2 focus:ring-[var(--focus)] transition-colors"
            style={{
              background: 'var(--key)',
              borderColor: 'var(--line)',
              color: 'var(--ink2)'
            }}
          >
            {t('quicknote.skip', { remaining: String(remaining) })}
          </button>
        </div>
      </div>
    </div>
  )
}
