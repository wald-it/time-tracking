import { useT } from '../../contexts/I18nContext'
import { useUiPrefsStore } from '../../store/uiPrefsStore'
import { entryBilledMinutes } from '../../../../shared/entryMoney'
import { formatHoursMinutes } from '../../../../shared/currency'
import { formatTimeHHMM } from '../../../../shared/date'
import { deserializeTags } from '../../../../shared/tags'
import type { Client, Entry, Project } from '../../../../shared/types'
import { formatHotkey } from './BigKey'

const pad2 = (n: number): string => String(n).padStart(2, '0')

const LEGEND =
  'text-[11px] font-semibold uppercase tracking-[0.14em] [font-stretch:118%] leading-none'
const DIGITS = 'font-num text-[clamp(64px,9vw,128px)] font-light leading-[0.86] tracking-[-0.03em]'
const UNIT = 'text-[10px] font-semibold uppercase tracking-[0.14em] [font-stretch:118%]'

/**
 * The dark readout window of the Heute hero (HANDOFF §3.2). Dark in both
 * themes. `nowMs` comes from the shared clock (`useNow`), so this component
 * starts no interval of its own. `role="timer"` without `aria-live`: a
 * screen reader reads it on demand instead of announcing every second.
 */
export function TimerDisplay({
  runningEntry,
  client,
  project,
  nowMs,
  roundMinutes,
  hotkey
}: {
  runningEntry: Entry | null
  client?: Client
  project?: Project
  nowMs: number
  roundMinutes: number
  hotkey: string
}): React.JSX.Element {
  const t = useT()
  const showProjectNumber = useUiPrefsStore((s) => s.showProjectNumber)
  const running = runningEntry !== null

  const startedMs = runningEntry ? new Date(runningEntry.started_at).getTime() : NaN
  const elapsed =
    running && Number.isFinite(startedMs) ? Math.max(0, Math.floor((nowMs - startedMs) / 1000)) : 0
  const hh = pad2(Math.floor(elapsed / 3600))
  const mm = pad2(Math.floor((elapsed % 3600) / 60))
  const ss = pad2(elapsed % 60)

  let rightHint: string | null = null
  // The running segment ticks by the rule of currency.ts with the profile values of its row.
  const billedNow = runningEntry ? entryBilledMinutes(runningEntry, nowMs) : null
  if (running && billedNow !== null) {
    rightHint = t('today.display.rounding', {
      step: roundMinutes,
      total: formatHoursMinutes(billedNow)
    })
  } else if (!running && hotkey) {
    rightHint = t('today.display.hotkeyHint', { hotkey: formatHotkey(hotkey) })
  }

  const description = runningEntry?.description.trim() ?? ''
  const tags = runningEntry ? deserializeTags(runningEntry.tags) : []

  return (
    <div className="flex min-w-0 flex-[999_1_520px] flex-col gap-5 rounded-[6px] border border-[var(--disp-line)] bg-[var(--disp)] px-7 pb-6 pt-[22px] text-[var(--disp-ink)]">
      {/* Row 1 — status */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden="true"
            className={`block h-2 w-2 ${running ? 'tt-blink bg-[var(--sig)]' : 'bg-[var(--disp-dim)]'}`}
          />
          <span className={`${LEGEND} ${running ? 'text-[var(--sig)]' : 'text-[var(--disp-dim)]'}`}>
            {running && runningEntry
              ? t('today.display.running', { time: formatTimeHHMM(runningEntry.started_at) })
              : t('today.display.ready')}
          </span>
        </div>
        {rightHint && (
          <span className={`${LEGEND} font-medium text-[var(--disp-dim)]`}>{rightHint}</span>
        )}
      </div>

      {/* Row 2 — digits */}
      <div role="timer" aria-label={`${hh}:${mm}:${ss}`} className="flex flex-wrap items-end">
        <div className="flex flex-col gap-2">
          <span className={DIGITS}>{hh}</span>
          <span className={`${UNIT} pl-1 text-[var(--disp-dim)]`}>{t('today.display.hours')}</span>
        </div>
        <div className="flex flex-col gap-2" aria-hidden="true">
          <span className={`${DIGITS} tracking-normal text-[var(--disp-dim)]`}>:</span>
          <span className={`${UNIT} invisible`}>·</span>
        </div>
        <div className="flex flex-col gap-2">
          <span className={DIGITS}>{mm}</span>
          <span className={`${UNIT} pl-1 text-[var(--disp-dim)]`}>
            {t('today.display.minutes')}
          </span>
        </div>
        <div className="ml-2.5 flex flex-col gap-2">
          <span className="font-num text-[clamp(30px,4vw,52px)] font-light leading-[0.9] text-[var(--disp-dim)]">
            :{ss}
          </span>
          <span className={`${UNIT} pl-0.5 text-[var(--disp-dim)]`}>
            {t('today.display.seconds')}
          </span>
        </div>
      </div>

      {running && runningEntry && (
        <>
          <div className="h-px bg-[var(--disp-line)]" />
          <div className="flex flex-col gap-1.5">
            {/* Row 3 — client · project */}
            <div className="flex flex-wrap items-center gap-2.5">
              <span
                aria-hidden="true"
                className="block h-2.5 w-2.5 flex-none"
                style={{ background: project?.color || (client?.color ?? 'var(--disp-dim)') }}
              />
              <span className="text-[15px] font-semibold">{client?.name ?? ''}</span>
              {project && (
                <span className="text-sm text-[var(--disp-dim)]">
                  · {project.name}
                  {showProjectNumber && project.external_project_number
                    ? ` [${project.external_project_number}]`
                    : ''}
                </span>
              )}
            </div>
            {/* Row 4 — description + tags */}
            <div className="flex flex-wrap items-center gap-2.5">
              {description ? (
                <span className="text-sm text-[var(--disp-ink)]">{description}</span>
              ) : (
                <span className="text-sm text-[var(--disp-dim)]">
                  {t('today.display.noDescription')}
                </span>
              )}
              {tags.map((tag) => (
                <span
                  key={tag}
                  className={`${UNIT} border border-[var(--disp-line)] px-1.5 py-[3px] text-[var(--disp-dim)]`}
                >
                  {tag}
                </span>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
