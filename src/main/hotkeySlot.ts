/**
 * One global hotkey slot (start/stop, mini widget): which accelerator it
 * holds, and how it moves to another one. Kept apart from index.ts so the
 * moves can be tested against a fake registry instead of Electron's
 * `globalShortcut`.
 */

/** The part of Electron's `globalShortcut` a slot needs. */
export interface ShortcutRegistry {
  register(accelerator: string, onPress: () => void): boolean
  unregister(accelerator: string): void
}

/** What became of a requested change. */
export type HotkeyChange =
  | { ok: true }
  | {
      ok: false
      /** `taken`: the other slot holds it; `refused`: the OS would not register it. */
      reason: 'empty' | 'taken' | 'refused'
      /** Whether the slot's previous accelerator is still in force. */
      previousKept: boolean
    }

export interface HotkeySlot {
  /** The accelerator this slot holds ('' for none). */
  current: string
}

export interface ChangeOptions {
  /** The other slot's accelerator; a slot never takes it over. */
  other: string
  onPress: () => void
  /**
   * Shortcuts are paused for hotkey capture: the slot's accelerator is noted
   * but not registered with the OS, and resuming registers it again.
   */
  suspended: boolean
}

/**
 * Move `slot` to `next`, and only there: refused, the slot keeps its previous
 * accelerator registered (#292), so the stored setting and the active
 * shortcut agree. Only when the OS will not take the previous one back
 * either is the slot left empty, and the result says so.
 */
export function changeHotkey(
  registry: ShortcutRegistry,
  slot: HotkeySlot,
  next: string,
  opts: ChangeOptions
): HotkeyChange {
  if (!next) return { ok: false, reason: 'empty', previousKept: true }
  // Cross-slot collision check (v1.4 PR B). Without this, suspending
  // shortcuts during capture would let the user silently steal the
  // other slot's accelerator, since the OS-level register call would
  // succeed while the other slot is paused.
  if (next === opts.other) return { ok: false, reason: 'taken', previousKept: true }
  const previous = slot.current
  // While suspended, the OS no longer holds the previous accelerator.
  if (previous && !opts.suspended) registry.unregister(previous)
  if (registry.register(next, opts.onPress)) {
    slot.current = next
    return { ok: true }
  }
  // Suspended, the previous one is registered again on resume, not now:
  // registering it during capture would fire it instead of capturing it.
  if (!previous || opts.suspended || registry.register(previous, opts.onPress)) {
    return { ok: false, reason: 'refused', previousKept: true }
  }
  slot.current = ''
  return { ok: false, reason: 'refused', previousKept: false }
}
