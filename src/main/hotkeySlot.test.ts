/**
 * #292 — a hotkey slot changes only when the new accelerator is in force.
 * Refused, the previous one stays registered and stays the slot's, so what
 * the settings store and what the OS has registered agree.
 */
import { describe, it, expect } from 'vitest'
import { changeHotkey, type HotkeySlot, type ShortcutRegistry } from './hotkeySlot'

/** A stand-in for `globalShortcut` that refuses the accelerators it is told to. */
function fakeRegistry(refused: string[] = []): ShortcutRegistry & { active: Set<string> } {
  const active = new Set<string>()
  return {
    active,
    register: (accelerator) => {
      if (refused.includes(accelerator) || active.has(accelerator)) return false
      active.add(accelerator)
      return true
    },
    unregister: (accelerator) => {
      active.delete(accelerator)
    }
  }
}

const onPress = (): void => undefined
const opts = { other: 'Alt+Shift+M', onPress, suspended: false }

/** A slot that holds `current`, registered with `registry` as at start-up. */
function holding(registry: ShortcutRegistry, current: string): HotkeySlot {
  registry.register(current, onPress)
  return { current }
}

describe('changing a hotkey slot (#292)', () => {
  it('moves to a free accelerator', () => {
    const registry = fakeRegistry()
    const slot = holding(registry, 'Alt+Shift+S')
    expect(changeHotkey(registry, slot, 'Alt+Shift+T', opts)).toEqual({ ok: true })
    expect(slot.current).toBe('Alt+Shift+T')
    expect([...registry.active]).toEqual(['Alt+Shift+T'])
  })

  it('refused by the OS: the previous accelerator stays registered and stays the slot’s', () => {
    const registry = fakeRegistry(['Ctrl+Alt+Del'])
    const slot = holding(registry, 'Alt+Shift+S')
    expect(changeHotkey(registry, slot, 'Ctrl+Alt+Del', opts)).toEqual({
      ok: false,
      reason: 'refused',
      previousKept: true
    })
    expect(slot.current).toBe('Alt+Shift+S')
    expect([...registry.active]).toEqual(['Alt+Shift+S'])
  })

  it('refused, and the previous one cannot be registered again either: says so', () => {
    const registry = fakeRegistry()
    const slot = holding(registry, 'Alt+Shift+S')
    // Something else grabs both while the slot changes.
    const refusing = { ...registry, register: () => false }
    expect(changeHotkey(refusing, slot, 'Alt+Shift+T', opts)).toEqual({
      ok: false,
      reason: 'refused',
      previousKept: false
    })
    expect(slot.current).toBe('')
    expect(registry.active.size).toBe(0)
  })

  it('taken by the other slot: nothing changes', () => {
    const registry = fakeRegistry()
    const slot = holding(registry, 'Alt+Shift+S')
    expect(changeHotkey(registry, slot, 'Alt+Shift+M', opts)).toEqual({
      ok: false,
      reason: 'taken',
      previousKept: true
    })
    expect(slot.current).toBe('Alt+Shift+S')
    expect([...registry.active]).toEqual(['Alt+Shift+S'])
  })

  it('an empty accelerator: nothing changes', () => {
    const registry = fakeRegistry()
    const slot = holding(registry, 'Alt+Shift+S')
    expect(changeHotkey(registry, slot, '', opts)).toEqual({
      ok: false,
      reason: 'empty',
      previousKept: true
    })
    expect(slot.current).toBe('Alt+Shift+S')
    expect([...registry.active]).toEqual(['Alt+Shift+S'])
  })

  it('refused during hotkey capture: the previous one is kept for resuming, not registered now', () => {
    // Capture has paused the shortcuts: the slot still names its accelerator,
    // but the OS no longer has it, so pressing it can reach the capture.
    const registry = fakeRegistry(['Ctrl+Alt+Del'])
    const slot = holding(registry, 'Alt+Shift+S')
    registry.unregister('Alt+Shift+S')
    expect(changeHotkey(registry, slot, 'Ctrl+Alt+Del', { ...opts, suspended: true })).toEqual({
      ok: false,
      reason: 'refused',
      previousKept: true
    })
    expect(slot.current).toBe('Alt+Shift+S')
    expect(registry.active.size).toBe(0)
  })

  it('a change during hotkey capture registers the new accelerator', () => {
    const registry = fakeRegistry()
    const slot = holding(registry, 'Alt+Shift+S')
    registry.unregister('Alt+Shift+S')
    expect(changeHotkey(registry, slot, 'Alt+Shift+T', { ...opts, suspended: true })).toEqual({
      ok: true
    })
    expect(slot.current).toBe('Alt+Shift+T')
    expect([...registry.active]).toEqual(['Alt+Shift+T'])
  })
})
