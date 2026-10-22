/**
 * Segmented control (HANDOFF §3.5): `--key` container with a 1 px `--key-edge`
 * border, radius 4, padding 3, gap 3. Segments are 36 px tall (the container
 * comes to 44 px), active `--inv` / `--inv-ink`, inactive transparent /
 * `--ink2`, with `aria-pressed`.
 */
export function SegmentedControl<V extends string>({
  options,
  value,
  onChange,
  labelledBy,
  label
}: {
  options: ReadonlyArray<{ value: V; label: string }>
  value: V
  onChange: (value: V) => void
  /** id of the element that names the group (preferred over `label`). */
  labelledBy?: string
  label?: string
}): React.JSX.Element {
  return (
    <div
      role="group"
      aria-labelledby={labelledBy}
      aria-label={labelledBy ? undefined : label}
      className="flex gap-[3px] rounded-[4px] border border-[var(--key-edge)] bg-[var(--key)] p-[3px]"
    >
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(o.value)}
            className={[
              'min-h-[36px] cursor-pointer rounded-[2px] border-0 px-3.5 text-[13px] font-semibold',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)] focus-visible:outline-solid',
              active
                ? 'bg-[var(--inv)] text-[var(--inv-ink)]'
                : 'bg-transparent text-[var(--ink2)] hover:text-[var(--ink)]'
            ].join(' ')}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
