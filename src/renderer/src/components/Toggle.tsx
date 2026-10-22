interface ToggleProps {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}

export function Toggle({ checked, onChange, disabled }: ToggleProps): React.JSX.Element {
  return (
    <div
      role="switch"
      aria-checked={checked}
      onClick={() => !disabled && onChange(!checked)}
      className="relative cursor-pointer transition-all duration-200 shrink-0"
      style={{
        width: 40,
        height: 22,
        borderRadius: 'var(--r-key)',
        background: checked ? 'var(--inv)' : 'var(--key)',
        border: `1px solid ${checked ? 'var(--inv)' : 'var(--key-edge)'}`,
        opacity: disabled ? 0.5 : 1
      }}
    >
      <div
        className="absolute top-0.5 transition-all duration-200"
        style={{
          left: checked ? 20 : 2,
          width: 16,
          height: 16,
          borderRadius: 'var(--r-fine)',
          background: checked ? 'var(--inv-ink)' : 'var(--ink3)'
        }}
      />
    </div>
  )
}
