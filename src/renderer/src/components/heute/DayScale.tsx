import { useMemo } from 'react'
import type { Client, Entry, Project } from '../../../../shared/types'
import { useLocale, useT } from '../../contexts/I18nContext'
import { entrySecondsToday, formatClock, formatHm, layoutDayScale } from './dayScaleLayout'

/**
 * Tagesverlauf — the signature element of Heute (HANDOFF §3.8).
 *
 * Section pattern (2 px ink rule → legend + date title, client legend on the
 * right), then the scale: entry bars as buttons, baseline, 15-min ticks, hour
 * labels and the needle. All geometry comes from `dayScale.ts`; this file only
 * places it with absolute positions in %. `nowMs` is the shared clock from
 * `useNow()` — no interval here.
 */
export function DayScale({
  entries,
  clientsById,
  projectsById,
  nowMs,
  onSelect
}: {
  entries: Entry[]
  clientsById: Map<number, Client>
  projectsById: Map<number, Project>
  nowMs: number
  onSelect: (e: Entry) => void
}): React.JSX.Element {
  const t = useT()
  const { locale } = useLocale()

  const layout = useMemo(() => layoutDayScale(entries, nowMs), [entries, nowMs])
  const isRunning = entries.some((e) => e.stopped_at === null)

  // Only the calendar day matters for the title, not every clock tick.
  const dayKey = new Date(nowMs).toDateString()
  const dateTitle = useMemo(
    () =>
      new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'de-DE', {
        weekday: 'long',
        day: 'numeric',
        month: 'long'
      }).format(new Date(dayKey)),
    [locale, dayKey]
  )

  // Day total per client, largest first.
  const legend = useMemo(() => {
    const totals = new Map<number, number>()
    for (const e of entries) {
      totals.set(e.client_id, (totals.get(e.client_id) ?? 0) + entrySecondsToday(e, nowMs))
    }
    return [...totals.entries()]
      .filter(([, secs]) => secs > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([clientId, secs]) => {
        const client = clientsById.get(clientId)
        return {
          clientId,
          name: client?.name ?? '—',
          color: client?.color || 'var(--tick)',
          secs
        }
      })
  }, [entries, clientsById, nowMs])

  const needleBg = isRunning ? 'var(--sig)' : 'var(--ink)'
  const needleInk = isRunning ? 'var(--sig-ink)' : 'var(--bg)'

  return (
    <section aria-label={t('today.dayscale.legend')} className="flex flex-col gap-[18px]">
      <div
        className="flex flex-wrap items-end justify-between gap-4 pt-[14px]"
        style={{ borderTop: '2px solid var(--ink)' }}
      >
        <div>
          <h2
            className="m-0 text-[11px] font-semibold uppercase"
            style={{ color: 'var(--ink2)', letterSpacing: '.14em', fontStretch: '118%' }}
          >
            {t('today.dayscale.legend')}
          </h2>
          <div
            className="mt-1 text-[20px] font-semibold"
            style={{ color: 'var(--ink)', fontStretch: '108%' }}
          >
            {dateTitle}
          </div>
        </div>
        {legend.length > 0 && (
          <ul className="m-0 flex list-none flex-wrap gap-[22px] p-0">
            {legend.map((c) => (
              <li
                key={c.clientId}
                className="flex items-center gap-2 text-[13px]"
                style={{ color: 'var(--ink)' }}
              >
                <span
                  aria-hidden="true"
                  className="h-[10px] w-[10px] shrink-0"
                  style={{ background: c.color }}
                />
                <span>{c.name}</span>
                <span className="font-num" style={{ color: 'var(--ink2)' }}>
                  {formatHm(c.secs)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="relative mx-3 h-[100px]">
        {entries.map((e, i) => {
          const bar = layout.bars[i]
          const client = clientsById.get(e.client_id)
          const project = e.project_id != null ? projectsById.get(e.project_id) : undefined
          const color = project?.color || client?.color || 'var(--tick)'
          const start = formatClock(new Date(e.started_at).getTime())
          const end = bar.running ? '' : formatClock(new Date(e.stopped_at as string).getTime())
          const label = [
            `${start}–${end}`,
            client?.name ?? '—',
            ...(project ? [project.name] : []),
            ...(bar.running ? [t('today.dayscale.running')] : [])
          ].join(' · ')
          return (
            <button
              key={e.id}
              type="button"
              title={label}
              aria-label={label}
              onClick={() => onSelect(e)}
              className="absolute cursor-pointer p-0 hover:outline-1 hover:outline-offset-1 hover:outline-solid hover:outline-[var(--ink)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-[var(--focus)]"
              style={{
                top: 22,
                height: 40,
                left: `${bar.left.toFixed(3)}%`,
                width: `${bar.width.toFixed(3)}%`,
                border: 0,
                borderRadius: 1,
                background: bar.running
                  ? `repeating-linear-gradient(135deg, ${color} 0 5px, transparent 5px 8px)`
                  : color,
                boxShadow: bar.running ? `inset 0 0 0 1px ${color}` : 'none'
              }}
            />
          )
        })}

        <div
          aria-hidden="true"
          className="absolute right-0 left-0 h-px"
          style={{ top: 62, background: 'var(--ink)' }}
        />

        {layout.ticks.map((tick) => (
          <div
            key={tick.sec}
            aria-hidden="true"
            className="absolute w-px"
            style={{
              top: 63,
              left: `${tick.left.toFixed(3)}%`,
              height: tick.length,
              background: 'var(--tick)',
              opacity: tick.dim ? 0.35 : 1
            }}
          />
        ))}

        {layout.hours.map((h) => (
          <span
            key={h.hour}
            aria-hidden="true"
            className="font-num absolute text-[11px]"
            style={{
              top: 80,
              left: `${h.left.toFixed(3)}%`,
              transform: 'translateX(-50%)',
              color: h.dim ? 'var(--ink3)' : 'var(--ink2)'
            }}
          >
            {h.label}
          </span>
        ))}

        <div
          aria-hidden="true"
          className="absolute top-0 w-0"
          style={{ left: `${layout.needle.toFixed(3)}%`, height: 78 }}
        >
          <div
            className="absolute"
            style={{ left: -1, top: 16, width: 2, height: 62, background: needleBg }}
          />
          <span
            className="font-num absolute text-[11px] font-semibold whitespace-nowrap"
            style={{
              top: -4,
              left: 0,
              transform: 'translateX(-50%)',
              background: needleBg,
              color: needleInk,
              padding: '2px 6px'
            }}
          >
            {formatClock(nowMs)}
          </span>
        </div>
      </div>
    </section>
  )
}
