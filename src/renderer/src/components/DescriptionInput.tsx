import { useEffect, useMemo, useRef, useState } from 'react'
import { INPUT } from './instrumentClasses'

interface Props {
  value: string
  onChange: (value: string) => void
  /** Enter with no suggestion highlighted: the host's own Enter (start, save). */
  onEnter?: () => void
  /** The pair whose recent texts are suggested; no client ⇒ no suggestions. */
  clientId: number | null
  projectId: number | null
  placeholder?: string
  ariaLabel?: string
  inputRef?: React.RefObject<HTMLInputElement | null>
  className?: string
}

/**
 * Description field with suggestions from the user's own recent texts for the
 * same client and project (Q8, 2.2): recognition instead of recall, no model.
 * The TagInput pattern: the list sits under the field, ↑↓ move, Enter takes
 * the highlighted text, Escape closes only the list.
 *
 * The list does not open on focus alone: the start dialog focuses this field
 * when it opens (B6, Enter starts the prefilled pair), and a list over the
 * start key would be in the way. Typing, ↓ or a click open it.
 */
export function DescriptionInput({
  value,
  onChange,
  onEnter,
  clientId,
  projectId,
  placeholder,
  ariaLabel,
  inputRef,
  className
}: Props): React.JSX.Element {
  const [known, setKnown] = useState<string[]>([])
  const [open, setOpen] = useState(false)
  const [highlighted, setHighlighted] = useState(-1)
  const containerRef = useRef<HTMLDivElement>(null)
  const highlightedRef = useRef<HTMLLIElement>(null)

  useEffect(() => {
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect -- #142: dauerhaft — Vorschläge vor dem Abruf des neuen Paars leeren
    setKnown([])
    setOpen(false)
    setHighlighted(-1)
    if (clientId === null) return
    async function load(): Promise<void> {
      if (clientId === null) return
      try {
        const res = await window.api.entries.recentDescriptions?.({ clientId, projectId })
        if (!cancelled) setKnown(res?.ok ? res.data : [])
      } catch {
        if (!cancelled) setKnown([])
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [clientId, projectId])

  // A derivation of the typed text and the known texts, not state (#142).
  const suggestions = useMemo(() => {
    const q = value.trim().toLowerCase()
    return known.filter((s) => s.toLowerCase() !== q && (!q || s.toLowerCase().includes(q)))
  }, [value, known])

  function take(text: string): void {
    onChange(text)
    setOpen(false)
    setHighlighted(-1)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setOpen(true)
      setHighlighted((i) => Math.min(i + 1, suggestions.length - 1))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlighted((i) => Math.max(i - 1, -1))
      return
    }
    if (e.key === 'Enter') {
      // A highlighted suggestion wins (as in TagInput, #158); otherwise Enter
      // is the host's — the start dialog starts, the quick note saves.
      if (showList && highlighted >= 0 && suggestions[highlighted]) {
        e.preventDefault()
        take(suggestions[highlighted])
        return
      }
      onEnter?.()
      return
    }
    if (e.key === 'Escape') {
      // Only a visible list is ours; otherwise Escape belongs to the dialog.
      if (!showList) return
      e.stopPropagation()
      setOpen(false)
      setHighlighted(-1)
    }
  }

  // Close the list on a click outside.
  useEffect(() => {
    function handlePointerDown(e: PointerEvent): void {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [])

  const showList = open && suggestions.length > 0

  useEffect(() => {
    if (showList && highlighted >= 0) {
      highlightedRef.current?.scrollIntoView?.({ block: 'nearest' })
    }
  }, [highlighted, showList])

  return (
    <div ref={containerRef} className="relative">
      <input
        ref={inputRef}
        type="text"
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel}
        aria-autocomplete="list"
        aria-expanded={showList}
        onChange={(e) => {
          onChange(e.target.value)
          // Typing rebuilds the list; an old highlight would point elsewhere.
          setHighlighted(-1)
          setOpen(true)
        }}
        onClick={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        // #451: the wrapper sits between the field and the host's flex column,
        // so the field no longer stretches by itself and must fill the wrapper.
        className={className ?? `w-full ${INPUT}`}
      />
      {showList && (
        <ul
          role="listbox"
          className="absolute z-50 mt-1 max-h-48 w-full overflow-auto rounded-[var(--r-key)] border border-[var(--ink)] bg-[var(--key)] py-1"
        >
          {suggestions.map((s, i) => (
            <li
              key={s}
              ref={i === highlighted ? highlightedRef : null}
              role="option"
              aria-selected={i === highlighted}
              onPointerDown={(e) => {
                e.preventDefault()
                take(s)
              }}
              className={`cursor-pointer px-3 py-2 text-xs ${
                i === highlighted
                  ? 'bg-[var(--inv)] text-[var(--inv-ink)]'
                  : 'text-[var(--ink)] hover:bg-[var(--bg)]'
              }`}
            >
              {s}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
