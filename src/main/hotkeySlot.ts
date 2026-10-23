/**
 * One global hotkey slot (start/stop, mini widget): which accelerator it
 * holds, whether the OS has it registered right now, and how it moves to
 * another one. Kept apart from index.ts so the moves can be tested against a
 * fake registry instead of Electron's `globalShortcut`.
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
      /** Whether the slot still holds its previous accelerator. */
      previousKept: boolean
    }

export interface HotkeySlot {
  /** The accelerator this slot holds ('' for none). */
  current: string
  /**
   * Whether the OS has `current` registered right now. False while shortcuts
   * are paused for hotkey capture, or when registering it failed. Tracked,
   * not inferred, so a slot never unregisters what it does not hold and never
   * leaves behind what it does (#292).
   */
  registered: boolean
  /** Paused for hotkey capture: `current` is meant to be registered on resume. */
  paused: boolean
  onPress: () => void
}

export function hotkeySlot(onPress: () => void): HotkeySlot {
  return { current: '', registered: false, paused: false, onPress }
}

/** `register`, with a throw (Electron: an accelerator it cannot parse) as a refusal. */
function tryRegister(
  registry: ShortcutRegistry,
  accelerator: string,
  onPress: () => void
): boolean {
  try {
    return registry.register(accelerator, onPress)
  } catch {
    return false
  }
}

/**
 * Move `slot` to `next`, and only there: refused, the slot keeps its previous
 * accelerator (registered again if the OS had it), so the stored setting and
 * the active shortcut agree. Only when the OS will not take the previous one
 * back either is the slot left empty, and the result says so. `other` is the
 * other slot's accelerator; a slot never takes it over.
 */
export function changeHotkey(
  registry: ShortcutRegistry,
  slot: HotkeySlot,
  next: string,
  other: string
): HotkeyChange {
  if (!next) return { ok: false, reason: 'empty', previousKept: true }
  // Cross-slot collision check (v1.4 PR B). Without this, suspending
  // shortcuts during capture would let the user silently steal the
  // other slot's accelerator, since the OS-level register call would
  // succeed while the other slot is paused.
  if (next === other) return { ok: false, reason: 'taken', previousKept: true }
  const previous = slot.current
  const hadPrevious = slot.registered
  if (hadPrevious) {
    registry.unregister(previous)
    slot.registered = false
  }
  if (tryRegister(registry, next, slot.onPress)) {
    slot.current = next
    slot.registered = true
    return { ok: true }
  }
  // Refused, and the OS did not have the previous one: nothing was given up.
  // Paused for capture, it stays the slot's and resuming registers it;
  // otherwise it was not in force before either, and the result says so.
  if (!hadPrevious) return { ok: false, reason: 'refused', previousKept: slot.paused }
  if (tryRegister(registry, previous, slot.onPress)) {
    slot.registered = true
    return { ok: false, reason: 'refused', previousKept: true }
  }
  slot.current = ''
  return { ok: false, reason: 'refused', previousKept: false }
}

/** Pause the slots' shortcuts for hotkey capture; they keep their accelerators. */
export function suspendHotkeys(registry: ShortcutRegistry, slots: HotkeySlot[]): void {
  for (const slot of slots) {
    slot.paused = true
    if (!slot.registered) continue
    registry.unregister(slot.current)
    slot.registered = false
  }
}

/**
 * Register again what capture paused. Returns the accelerators the OS refused;
 * those slots stay unregistered (and say so) instead of claiming a shortcut
 * that does not work.
 */
export function resumeHotkeys(registry: ShortcutRegistry, slots: HotkeySlot[]): string[] {
  const refused: string[] = []
  for (const slot of slots) {
    slot.paused = false
    if (!slot.current || slot.registered) continue
    slot.registered = tryRegister(registry, slot.current, slot.onPress)
    if (!slot.registered) refused.push(slot.current)
  }
  return refused
}
