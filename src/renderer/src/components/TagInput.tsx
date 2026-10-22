import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { deserializeTags, parseTagInput, serializeTags } from '../../../shared/tags'
import { useT } from '../contexts/I18nContext'
import { FOCUS } from './instrumentClasses'

interface Props {
  /** Serialized tags value from the DB (`,bug,ux,` format). */
  value: string
  onChange: (serialized: string) => void
  disabled?: boolean
  /** Optional callback to navigate to the tag management settings tab. */
  onManageTags?: () => void
}

/**
 * Tag chips are outlined legend chips in ink (Messinstrument, HANDOFF §3.2 /
 * §3.10): colour never carries meaning on its own, and the old per-letter
 * palette was not tied to anything the tag means.
 */
const CHIP_CLASS = 'bg-[var(--key)] text-[var(--ink2)] border-[var(--key-edge)]'

// Sentinel value for the "create new tag" option in the dropdown
const CREATE_SENTINEL = '__create__'

/**
 * Tag chip list + text input with Tab/Enter/comma to add, Backspace to
 * remove, and autocomplete dropdown populated from `tags:get-all-with-count`
 * (master registry).
 *
 * Closed tag system: free text that doesn't match an existing tag shows a
 * "+ 'foo' erstellen" option. Selecting it calls `tags:create` and adds
 * the tag immediately.
 *
 * Stores tags as the serialized DB format (`,tag1,tag2,`) via `onChange`.
 */
export function TagInput({
  value,
  onChange,
  disabled = false,
  onManageTags
}: Props): React.ReactElement {
  const t = useT()
  const tags = deserializeTags(value)
  const [inputValue, setInputValue] = useState('')
  const [allKnown, setAllKnown] = useState<string[]>([])
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const reloadKnown = useCallback(async () => {
    const res = await window.api.tags.getAllWithCount()
    if (res.ok) setAllKnown(res.data.map((r) => r.name))
  }, [])

  // Load master registry on mount
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- #142: dauerhaft — asynchroner Abruf beim Mount
    void reloadKnown()
  }, [reloadKnown])

  // Suggestions follow purely from the typed text, the master registry and
  // the already-selected tags — a derivation, not state (#142). `selected` is
  // re-derived from `value` inside the memo because the outer `tags` const is
  // a fresh array on every render and would defeat memoization.
  //
  // The highlight reset that used to share this effect is NOT a derivation;
  // it lives at its two triggers instead: typing (input onChange) and
  // removing a chip (removeTag).
  const suggestions = useMemo(() => {
    const selected = deserializeTags(value)
    const q = inputValue.trim().toLowerCase().replace(/^#/, '')
    const matches = allKnown
      .filter((t) => (!q || t.startsWith(q)) && !selected.includes(t))
      .slice(0, 8)
    // Append "create" sentinel if typed text is non-empty and not an exact match
    return q && !allKnown.includes(q) && !selected.includes(q)
      ? [...matches, CREATE_SENTINEL]
      : matches
  }, [inputValue, allKnown, value])

  /**
   * Clear the text input and drop the highlight together.
   *
   * They belong to each other: emptying the input rebuilds the suggestion
   * list, so an index pointing into the old list is meaningless afterwards.
   * Keeping the two calls in one place is what stops them drifting apart:
   * when #142 moved the reset out of an effect and onto its triggers, this
   * one was missed (#158) — caught before release, but only because someone
   * reopened the list after picking a tag.
   */
  function clearInput(): void {
    setInputValue('')
    setHighlightedIndex(-1)
  }

  async function addTag(tag: string): Promise<void> {
    if (!tag || tags.includes(tag) || tags.length >= 10) return
    onChange(serializeTags([...tags, tag]))
    clearInput()
    setDropdownOpen(false)
  }

  async function commitInput(raw: string): Promise<void> {
    if (raw === CREATE_SENTINEL) {
      const name = inputValue.trim().toLowerCase().replace(/^#/, '')
      if (!name) return
      const res = await window.api.tags.create(name)
      if (res.ok) {
        await reloadKnown()
        await addTag(name)
      }
      return
    }
    const parsed = parseTagInput(raw)
    if (parsed.length === 0) {
      clearInput()
      return
    }
    const next = [...tags]
    for (const t of parsed) {
      if (!next.includes(t) && next.length < 10) next.push(t)
    }
    onChange(serializeTags(next))
    clearInput()
    setDropdownOpen(false)
  }

  function removeTag(tag: string): void {
    onChange(serializeTags(tags.filter((t) => t !== tag)))
    // The freed tag re-enters the suggestion list, so a kept index would now
    // point at a different entry than the one the user saw highlighted.
    setHighlightedIndex(-1)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setDropdownOpen(true)
      setHighlightedIndex((i) => Math.min(i + 1, suggestions.length - 1))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlightedIndex((i) => Math.max(i - 1, -1))
      return
    }
    if (e.key === 'Enter' || e.key === 'Tab' || e.key === ',') {
      // A highlighted suggestion wins regardless of what is typed — including
      // nothing at all (#158). This branch used to sit behind
      // `&& inputValue.trim()`, so picking an entry with the arrow keys and
      // pressing Enter without typing dropped the choice silently and let the
      // event reach the surrounding <form>, which saved the entry without it.
      if (dropdownOpen && highlightedIndex >= 0 && suggestions[highlightedIndex]) {
        e.preventDefault()
        void commitInput(suggestions[highlightedIndex])
        return
      }
      // Nothing highlighted and nothing typed: Tab must still move focus and
      // Enter must still submit the form. Return WITHOUT preventDefault.
      if (!inputValue.trim()) return
      e.preventDefault()
      // In closed mode, Enter on free text: create if not known
      const q = inputValue.trim().toLowerCase().replace(/^#/, '')
      if (q && allKnown.includes(q)) {
        void commitInput(q)
      } else if (q) {
        void commitInput(CREATE_SENTINEL)
      }
      return
    }
    if (e.key === 'Escape') {
      // Only the dropdown is ours to close. Dialog.tsx and CalendarDrawer.tsx
      // listen for Escape on `window`, so without stopping propagation the
      // first Escape tore down the whole modal along with unsaved edits
      // (#158). With the list closed the key belongs to the host again.
      if (!dropdownOpen) return
      e.stopPropagation()
      setDropdownOpen(false)
      setHighlightedIndex(-1)
      return
    }
    if (e.key === 'Backspace' && inputValue === '' && tags.length > 0) {
      removeTag(tags[tags.length - 1])
      return
    }
  }

  // Close dropdown on outside click
  useEffect(() => {
    function handlePointerDown(e: PointerEvent): void {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setDropdownOpen(false)
      }
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [])

  const showDropdown = dropdownOpen && suggestions.length > 0 && !disabled

  return (
    <div ref={containerRef} className="relative">
      <div
        // Same frame as every input (HANDOFF §5); the ring follows the inner field.
        className={`flex min-h-11 flex-wrap items-center gap-1 rounded-[var(--r-key)] border border-[var(--key-edge)] bg-[var(--key)] px-2 py-1.5 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--focus)] ${disabled ? 'opacity-50' : ''}`}
        onClick={() => {
          inputRef.current?.focus()
          // Reopening hangs off `onFocus` alone, which does not fire again
          // when the cursor never left the field — after picking a tag you
          // had to click away and back to see the list (#158).
          setDropdownOpen(true)
        }}
      >
        {tags.map((tag) => (
          <span
            key={tag}
            className={`inline-flex items-center gap-1 rounded-[var(--r-fine)] border px-1.5 py-0.5 text-xs font-medium ${CHIP_CLASS}`}
          >
            #{tag}
            {!disabled && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  removeTag(tag)
                }}
                className={`leading-none opacity-60 hover:opacity-100 focus-visible:opacity-100 ${FOCUS}`}
                aria-label={t('tags.removeAria', { tag })}
              >
                ×
              </button>
            )}
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={(e) => {
            setInputValue(e.target.value)
            // Typing rebuilds the suggestion list — drop the old highlight
            // rather than let it survive onto an unrelated entry.
            setHighlightedIndex(-1)
            setDropdownOpen(true)
          }}
          onFocus={() => setDropdownOpen(true)}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder={tags.length === 0 ? t('tags.placeholder') : ''}
          className="min-w-[80px] flex-1 bg-transparent text-xs text-[var(--ink)] placeholder:text-[var(--ink3)] focus:outline-none"
          aria-label={t('tags.inputAria')}
          aria-autocomplete="list"
          aria-expanded={showDropdown}
        />
      </div>

      {showDropdown && (
        <ul
          role="listbox"
          className="absolute z-50 mt-1 max-h-48 w-full overflow-auto rounded-[var(--r-key)] border border-[var(--ink)] bg-[var(--key)] py-1"
        >
          {suggestions.map((s, i) => (
            <li
              key={s}
              role="option"
              aria-selected={i === highlightedIndex}
              onPointerDown={(e) => {
                e.preventDefault()
                void commitInput(s)
              }}
              className={`cursor-pointer px-3 py-2 text-xs ${
                i === highlightedIndex
                  ? 'bg-[var(--inv)] text-[var(--inv-ink)]'
                  : 'hover:bg-[var(--bg)]'
              }`}
              style={
                i !== highlightedIndex
                  ? { color: s === CREATE_SENTINEL ? 'var(--ink2)' : 'var(--ink)' }
                  : undefined
              }
            >
              {s === CREATE_SENTINEL
                ? t('tags.createOption', { tag: inputValue.trim().toLowerCase().replace(/^#/, '') })
                : `#${s}`}
            </li>
          ))}
        </ul>
      )}

      {onManageTags && allKnown.length === 0 && !disabled && (
        <button
          type="button"
          onClick={onManageTags}
          className={`mt-1 text-xs underline ${FOCUS}`}
          style={{ color: 'var(--ink3)' }}
        >
          {t('tags.manageLink')}
        </button>
      )}
    </div>
  )
}
