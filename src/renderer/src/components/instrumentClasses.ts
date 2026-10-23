/**
 * Shared Messinstrument class strings for the form-heavy views (HANDOFF §2.3,
 * §2.4, §3.4, §5): Einstellungen, Kunden, Export, Tags and the forms they
 * embed. The Heute/Kalender/Auswertung components keep their local copies;
 * these are the same values, collected once because eight files need them.
 *
 * Styling only — nothing here carries behaviour.
 */

/** 2 px `--focus` outline, offset 2 px (HANDOFF §2.4). */
export const FOCUS =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]'

/** Secondary key (HANDOFF §3.4): `--key`, 1 px `--key-edge`, keycap edge, ≥ 44 px. */
export const KEY = `key-hover inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-[var(--r-key)] border border-[var(--key-edge)] bg-[var(--key)] px-4 text-[13px] font-semibold text-[var(--ink)] shadow-[var(--edge-key)] active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40 disabled:active:translate-y-0 ${FOCUS}`

/** Primary ink key (HANDOFF §1 rule 3: primary actions are ink keys, not orange). */
export const KEY_INV = `key-hover inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-[var(--r-key)] border border-[var(--inv)] bg-[var(--inv)] px-4 text-[13px] font-semibold text-[var(--inv-ink)] active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40 disabled:active:translate-y-0 ${FOCUS}`

/** Icon-only key, 44 × 44 (HANDOFF §3.4). Callers add `aria-label`. */
export const ICON_KEY = `key-hover inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--r-key)] border border-[var(--key-edge)] bg-[var(--key)] text-[var(--ink)] shadow-[var(--edge-key)] active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40 disabled:active:translate-y-0 ${FOCUS}`

/** Flat icon button inside a row (HANDOFF §2.4 "icon button hover"), 44 × 44. */
export const ICON_BTN = `inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--r-key)] text-[var(--ink2)] hover:bg-[var(--key)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent ${FOCUS}`

/**
 * Input / select frame (HANDOFF §5): `--key`, 1 px `--key-edge`, radius 4,
 * 2 px focus ring — without a font size, for callers that set their own.
 */
export const INPUT_FRAME = `min-h-11 rounded-[var(--r-key)] border border-[var(--key-edge)] bg-[var(--key)] px-3 text-[var(--ink)] placeholder:text-[var(--ink3)] disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`

/** Input / select at body size (14 px). */
export const INPUT = `${INPUT_FRAME} text-sm`

/** Multi-line input — same frame, vertical padding instead of a fixed height. */
export const TEXTAREA = `rounded-[var(--r-key)] border border-[var(--key-edge)] bg-[var(--key)] px-3 py-2 text-sm text-[var(--ink)] placeholder:text-[var(--ink3)] ${FOCUS}`

/** Read-only value well (paths, hotkeys, URLs): hairline frame, Plex Mono — no size/colour. */
export const READOUT_FRAME = 'font-num rounded-[var(--r-key)] border border-[var(--line)] px-3 py-2'

/** Read-only value well at 12 px `--ink2`. */
export const READOUT = `${READOUT_FRAME} text-xs text-[var(--ink2)]`

/** Section legend (HANDOFF §2.2): 11/600 caps, expanded, `--ink2`. */
export const LEGEND =
  'text-[11px] font-semibold uppercase tracking-[.14em] [font-stretch:118%] text-[var(--ink2)]'

/** Small field label above an input (table-header style, HANDOFF §2.2). */
export const FIELD_LABEL =
  'text-[10px] font-semibold uppercase tracking-[.14em] [font-stretch:118%] text-[var(--ink3)]'

/** Section pattern (HANDOFF §2.3): 2 px `--ink` rule, then legend row, then content. */
export const SECTION = 'flex flex-col border-t-2 border-[var(--ink)] pt-3.5'

/** View title (HANDOFF §2.2 "section title"): 20/600, slightly expanded. */
export const VIEW_TITLE = 'text-xl font-semibold [font-stretch:108%] text-[var(--ink)]'
