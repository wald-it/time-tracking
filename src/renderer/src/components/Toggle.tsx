import { useContext } from 'react'
import { FOCUS } from './instrumentClasses'
import { ToggleLabelContext } from './toggleLabelContext'

interface ToggleProps {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  /**
   * Id of the element that names the switch — the label of the settings row
   * it sits in (`aria-labelledby`). Without it the switch has no accessible
   * name, so every caller should pass one.
   */
  labelledBy?: string
}

/**
 * On/off switch (HANDOFF §5): a real `<button role="switch">`, so Space and
 * Enter toggle it natively and `disabled` takes it out of the tab order.
 *
 * The visible track is 40 × 22 (`--inv` when on, `--key` with a `--key-edge`
 * border when off, square-ish thumb with radius 2); the button around it is
 * 44 px tall so the hit target meets §8 without changing the row layout.
 */
export function Toggle({
  checked,
  onChange,
  disabled,
  labelledBy
}: ToggleProps): React.JSX.Element {
  const rowLabel = useContext(ToggleLabelContext)
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy ?? rowLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`group -my-[11px] inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--r-key)] disabled:cursor-not-allowed ${FOCUS}`}
    >
      <span
        aria-hidden
        className="relative block shrink-0 rounded-[var(--r-key)] border group-disabled:opacity-50"
        style={{
          width: 40,
          height: 22,
          background: checked ? 'var(--inv)' : 'var(--key)',
          borderColor: checked ? 'var(--inv)' : 'var(--key-edge)'
        }}
      >
        <span
          className="absolute top-0.5 block"
          style={{
            left: checked ? 20 : 2,
            width: 16,
            height: 16,
            borderRadius: 'var(--r-fine)',
            background: checked ? 'var(--inv-ink)' : 'var(--ink3)'
          }}
        />
      </span>
    </button>
  )
}
