import { useCallback, useState } from 'react'
import { useT } from '../contexts/I18nContext'
import type { TranslationKey } from '../../../shared/locales/de'
import { ExportModal } from '../components/ExportModal'
import { PdfMergeModal } from '../components/PdfMergeModal'
import { getQuickRange, localDateKey, type QuickRangeKind } from '../../../shared/dateRanges'
import { useWeekStart } from '../hooks/useWeekStart'
import {
  FIELD_LABEL,
  KEY,
  KEY_INV,
  LEGEND,
  SECTION,
  VIEW_TITLE
} from '../components/instrumentClasses'

/**
 * Export view (#153).
 *
 * Both export dialogs used to hang off `CalendarView`: the range pills opened
 * `ExportModal`, a right-aligned button opened `PdfMergeModal`. Neither is a
 * calendar function — the pills filtered nothing, they only prefilled a range
 * and opened a modal — so the whole toolbar was a passenger in a view whose
 * label gave no hint that exporting lived there. With the iCal export (#135)
 * behind it that stopped being tolerable: the feature exists to be a permanent
 * second calendar layer, and it was reachable only via a button labelled
 * "Dieser Monat".
 *
 * This view is that entry point, and it takes the PdfMergeModal trigger with
 * it (TODOS.md "Merge modal Nav-Trigger") — one decision instead of bolting a
 * second entry point onto each modal separately.
 *
 * The triggers themselves are unchanged: same labels, same ranges, same hero
 * treatment for the invoice path. `exportEntryPoints.test.tsx` was written
 * against the CalendarView version and pins that.
 */
export default function ExportView(): React.JSX.Element {
  const t = useT()
  const weekStart = useWeekStart()

  // Range hand-off to ExportModal. `null` = closed; a range = open with that
  // range prefilled.
  const [pdfRange, setPdfRange] = useState<{ fromIso: string; toIso: string } | null>(null)
  const [mergeOpen, setMergeOpen] = useState(false)

  // "Diese/Letzte Woche" follows the week_start setting (#188) — otherwise the
  // quick filter would hand over a different week than the week total shows.
  const onQuickRange = useCallback(
    (kind: QuickRangeKind) => {
      const range = getQuickRange(kind, new Date(), weekStart)
      setPdfRange({ fromIso: localDateKey(range.from), toIso: localDateKey(range.to) })
    },
    [weekStart]
  )

  return (
    <div className="flex w-full max-w-[920px] flex-col gap-10">
      <h1 className={VIEW_TITLE}>{t('export.view.title')}</h1>

      <Card>
        <CardHeading title={t('export.view.timesTitle')} hint={t('export.view.timesHint')} />

        {/* Trigger row, moved verbatim from CalendarView. Hero "Letzter Monat"
            is the inverse ink key — it is the most common rechnungs-flow. */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => onQuickRange('lastMonth')}
            className={KEY_INV}
            title={t('export.view.lastMonthTitle')}
          >
            {t('export.view.lastMonth')}
          </button>
          <span className={`ml-2 ${FIELD_LABEL}`}>{t('export.view.rangeLabel')}</span>
          {(['thisWeek', 'lastWeek', 'thisMonth'] as const).map((k) => (
            <button key={k} type="button" onClick={() => onQuickRange(k)} className={KEY}>
              {t(('export.range.' + k) as TranslationKey)}
            </button>
          ))}
        </div>
      </Card>

      <Card>
        <CardHeading title={t('export.view.mergeTitle')} hint={t('export.view.mergeHint')} />
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setMergeOpen(true)}
            className={KEY}
            title={t('export.view.mergeButtonTitle')}
          >
            {t('export.view.merge')}
          </button>
        </div>
      </Card>

      {/* The `key` remounts the modal per open so it re-reads the stored prefs
          (its `initialPrefs` is a lazy useState). Dropping it leaves the prefs
          from the first mount — before the settings load finishes — in place
          for the rest of the session. Case 6 of the test guards this. */}
      <ExportModal
        key={pdfRange ? `${pdfRange.fromIso}-${pdfRange.toIso}` : 'closed'}
        open={pdfRange !== null}
        prefilledRange={pdfRange ?? undefined}
        onClose={() => setPdfRange(null)}
      />

      <PdfMergeModal open={mergeOpen} onClose={() => setMergeOpen(false)} />
    </div>
  )
}

function Card({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    // Section pattern (HANDOFF §2.3) instead of a card: 2 px ink rule, legend, content.
    <section className={`${SECTION} gap-3`}>{children}</section>
  )
}

function CardHeading({ title, hint }: { title: string; hint: string }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <h2 className={LEGEND}>{title}</h2>
      <p className="text-xs" style={{ color: 'var(--ink3)' }}>
        {hint}
      </p>
    </div>
  )
}
