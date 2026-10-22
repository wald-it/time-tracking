import { useT } from '../../contexts/I18nContext'

const MODIFIER_GLYPHS: Record<string, string> = {
  shift: '⇧',
  alt: 'Alt',
  option: 'Alt',
  altgr: 'AltGr',
  control: 'Ctrl',
  ctrl: 'Ctrl',
  commandorcontrol: 'Ctrl',
  cmdorctrl: 'Ctrl',
  command: '⌘',
  cmd: '⌘',
  super: 'Win',
  meta: 'Win'
}

/**
 * Turns an Electron accelerator from the settings ("Alt+Shift+S") into the
 * key-cap label the mockups show ("Alt ⇧ S"). Unknown parts pass through.
 */
// eslint-disable-next-line react-refresh/only-export-components -- reine Formatierhilfe, die TimerDisplay für den Hotkey-Hinweis mitbenutzt.
export function formatHotkey(accelerator: string): string {
  return accelerator
    .split('+')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => MODIFIER_GLYPHS[part.toLowerCase()] ?? part)
    .join(' ')
}

/**
 * The big STOPP / START key beside the display (HANDOFF §3.3). Running: the
 * inverse key with a `--sig` square. Idle: a `--sig` key with a play
 * triangle. The hotkey line shows the configured global hotkey.
 */
export function BigKey({
  running,
  hotkey,
  onStart,
  onStop
}: {
  running: boolean
  hotkey: string
  onStart: () => void
  onStop: () => void
}): React.JSX.Element {
  const t = useT()
  const label = formatHotkey(hotkey)
  return (
    <button
      type="button"
      onClick={running ? onStop : onStart}
      aria-label={running ? t('header.stopTimer') : t('timer.modal.start')}
      aria-keyshortcuts={hotkey || undefined}
      className={`key-hover flex min-h-[200px] flex-[0_0_148px] cursor-pointer flex-col items-center justify-center gap-[18px] rounded-[6px] border-0 shadow-[var(--edge-bigkey)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)] active:translate-y-px ${
        running ? 'bg-[var(--inv)] text-[var(--inv-ink)]' : 'bg-[var(--sig)] text-[var(--sig-ink)]'
      }`}
    >
      {running ? (
        <span
          aria-hidden="true"
          className="block h-[30px] w-[30px] rounded-[2px] bg-[var(--sig)]"
        />
      ) : (
        <svg aria-hidden="true" width="30" height="30" viewBox="0 0 30 30" className="block">
          <path d="M7 3 L27 15 L7 27 Z" fill="currentColor" />
        </svg>
      )}
      <span className="text-[13px] font-semibold uppercase tracking-[0.22em] [font-stretch:118%]">
        {running ? t('today.bigkey.stop') : t('today.bigkey.start')}
      </span>
      {label && (
        <span
          className={`font-num text-[11px] ${running ? 'text-[var(--inv-dim)]' : 'text-[var(--sig-ink)]'}`}
        >
          {label}
        </span>
      )}
    </button>
  )
}
