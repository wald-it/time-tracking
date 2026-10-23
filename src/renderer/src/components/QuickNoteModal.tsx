import { useEffect, useRef, useState } from 'react'
import type { Entry } from '../../../shared/types'
import { Dialog } from './Dialog'
import { INPUT, KEY, KEY_INV } from './instrumentClasses'
import { useEntriesStore } from '../store/entriesStore'
import { useT } from '../contexts/I18nContext'

const TIMEOUT_S = 30

interface Props {
  entry: Entry
  onDone: () => void
}

export function QuickNoteModal({ entry, onDone }: Props): React.JSX.Element | null {
  const t = useT()
  const [text, setText] = useState('')
  const [remaining, setRemaining] = useState(TIMEOUT_S)
  const inputRef = useRef<HTMLInputElement>(null)
  // eslint-disable-next-line react-hooks/purity -- #142: dauerhaft — useRef-Initialwert, Umbau ohne beobachtbaren Effekt
  const deadlineRef = useRef(Date.now() + TIMEOUT_S * 1000)
  const bumpVersion = useEntriesStore((s) => s.bumpVersion)

  // Countdown + auto-dismiss
  useEffect(() => {
    const tick = setInterval(() => {
      const r = Math.max(0, Math.round((deadlineRef.current - Date.now()) / 1000))
      setRemaining(r)
      if (r <= 0) onDone()
    }, 250)
    return () => clearInterval(tick)
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
        tags: entry.tags,
        // entries:update re-inserts the row and defaults every field it is
        // not given: without these the note would drop the project, make a
        // non-billable entry billable and clear reference and private note.
        project_id: entry.project_id ?? null,
        billable: entry.billable,
        reference: entry.reference,
        private_note: entry.private_note
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
    <Dialog
      open
      onClose={onDone}
      title={t('quicknote.title')}
      widthClass="w-[420px]"
      initialFocusRef={inputRef}
      closeButton={false}
      closeOnBackdrop={false}
    >
      <p className="mb-4 text-sm text-[var(--ink2)]">{t('quicknote.body')}</p>

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
        className={`mb-4 w-full ${INPUT}`}
      />

      {/* Countdown: the bar grows left→right as the time runs out */}
      <div className="mb-5 h-1 w-full bg-[var(--line)]">
        <div className="h-1 bg-[var(--ink)]" style={{ width: `${progressPct}%` }} />
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => void save()}
          disabled={!text.trim()}
          className={`flex-1 ${KEY_INV}`}
        >
          {t('common.save')}
        </button>
        <button type="button" onClick={onDone} className={KEY}>
          {t('quicknote.skip', { remaining: String(remaining) })}
        </button>
      </div>
    </Dialog>
  )
}
