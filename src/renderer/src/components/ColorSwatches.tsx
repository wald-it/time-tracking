import { useT } from '../contexts/I18nContext'
import { FOCUS } from './instrumentClasses'
import { CLIENT_COLORS, COLOR_NAME_KEYS } from './clientColors'

/** The selected swatch: 2 px ink ring with a `--bg` gap. */
const SELECTED = 'ring-2 ring-[var(--ink)] ring-offset-2 ring-offset-[var(--bg)]'
/** Hover as the 1 px outline of HANDOFF §2.4, on the swatch, not the hit area. */
const HOVER =
  'group-hover:outline group-hover:outline-1 group-hover:outline-offset-2 group-hover:outline-[var(--ink3)]'

interface Props {
  value: string
  onChange: (color: string) => void
  /** Label of an extra "no colour of its own" swatch (value `''`), first in the row. */
  inheritLabel?: string
  /** Name of the group (the field label above it). */
  groupLabel: string
}

/**
 * A row of colour swatches. Each swatch shows 32 px but is a 44 × 44 button
 * (HANDOFF §8), named after its colour and marked with `aria-pressed`.
 */
export function ColorSwatches({
  value,
  onChange,
  inheritLabel,
  groupLabel
}: Props): React.JSX.Element {
  const t = useT()
  const swatch = (color: string, label: string, face: React.ReactNode): React.JSX.Element => (
    <button
      key={color || 'inherit'}
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={value === color}
      onClick={() => onChange(color)}
      className={`group grid h-11 w-11 place-items-center rounded-[var(--r-key)] ${FOCUS}`}
    >
      {face}
    </button>
  )
  return (
    <div role="group" aria-label={groupLabel} className="-ml-1.5 flex flex-wrap items-center">
      {inheritLabel !== undefined &&
        swatch(
          '',
          inheritLabel,
          <span
            aria-hidden
            className={`grid h-8 w-8 place-items-center rounded-[var(--r-fine)] border border-[var(--key-edge)] bg-[var(--key)] text-xs text-[var(--ink3)] ${value === '' ? SELECTED : HOVER}`}
          >
            –
          </span>
        )}
      {CLIENT_COLORS.map((c) => {
        const name = t(COLOR_NAME_KEYS[c])
        return swatch(
          c,
          t('clients.form.colorAria', { color: name }),
          <span
            aria-hidden
            className={`block h-8 w-8 rounded-[var(--r-fine)] ${value === c ? SELECTED : HOVER}`}
            style={{ backgroundColor: c }}
          />
        )
      })}
    </div>
  )
}
