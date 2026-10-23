/**
 * #292 — a hotkey slot changes only when the new accelerator is in force.
 * Refused, the previous one stays registered and stays the slot's, so what
 * the settings store and what the OS has registered agree. Whether the OS
 * holds a slot's accelerator is tracked per slot, also across hotkey capture.
 */
import { describe, it, expect } from 'vitest'
import {
  changeHotkey,
  hotkeySlot,
  resumeHotkeys,
  suspendHotkeys,
  type HotkeySlot,
  type ShortcutRegistry
} from './hotkeySlot'

/** A stand-in for `globalShortcut` that refuses the accelerators it is told to. */
function fakeRegistry(refused: string[] = []): ShortcutRegistry & {
  active: Set<string>
  refused: string[]
} {
  const active = new Set<string>()
  return {
    active,
    refused,
    register(accelerator) {
      if (this.refused.includes(accelerator) || active.has(accelerator)) return false
      active.add(accelerator)
      return true
    },
    unregister: (accelerator) => {
      active.delete(accelerator)
    }
  }
}

const OTHER = 'Alt+Shift+M'

/** A slot that holds `current`, registered as at start-up. */
function holding(registry: ShortcutRegistry, current: string): HotkeySlot {
  const slot = hotkeySlot(() => undefined)
  expect(changeHotkey(registry, slot, current, OTHER)).toEqual({ ok: true })
  return slot
}

describe('changing a hotkey slot (#292)', () => {
  it('moves to a free accelerator', () => {
    const registry = fakeRegistry()
    const slot = holding(registry, 'Alt+Shift+S')
    expect(changeHotkey(registry, slot, 'Alt+Shift+T', OTHER)).toEqual({ ok: true })
    expect(slot).toMatchObject({ current: 'Alt+Shift+T', registered: true })
    expect([...registry.active]).toEqual(['Alt+Shift+T'])
  })

  it('refused by the OS: the previous accelerator stays registered and stays the slot’s', () => {
    const registry = fakeRegistry(['Ctrl+Alt+Del'])
    const slot = holding(registry, 'Alt+Shift+S')
    expect(changeHotkey(registry, slot, 'Ctrl+Alt+Del', OTHER)).toEqual({
      ok: false,
      reason: 'refused',
      previousKept: true
    })
    expect(slot).toMatchObject({ current: 'Alt+Shift+S', registered: true })
    expect([...registry.active]).toEqual(['Alt+Shift+S'])
  })

  it('refused, and the previous one cannot be registered again either: says so', () => {
    const registry = fakeRegistry()
    const slot = holding(registry, 'Alt+Shift+S')
    // Something else grabs both while the slot changes.
    registry.refused.push('Alt+Shift+T', 'Alt+Shift+S')
    expect(changeHotkey(registry, slot, 'Alt+Shift+T', OTHER)).toEqual({
      ok: false,
      reason: 'refused',
      previousKept: false
    })
    expect(slot).toMatchObject({ current: '', registered: false })
    expect(registry.active.size).toBe(0)
  })

  it('an accelerator the OS cannot parse (register throws) counts as refused', () => {
    const registry = fakeRegistry()
    const slot = holding(registry, 'Alt+Shift+S')
    const throwing: ShortcutRegistry = {
      register: (accelerator, onPress) => {
        if (accelerator === 'Foo+Bar') throw new Error('Failed to parse accelerator')
        return registry.register(accelerator, onPress)
      },
      unregister: registry.unregister
    }
    expect(changeHotkey(throwing, slot, 'Foo+Bar', OTHER)).toEqual({
      ok: false,
      reason: 'refused',
      previousKept: true
    })
    expect(slot).toMatchObject({ current: 'Alt+Shift+S', registered: true })
    expect([...registry.active]).toEqual(['Alt+Shift+S'])
  })

  it('refused while the previous one was not in force anyway: says it is not kept', () => {
    // Registering it failed earlier (e.g. after capture another app had it).
    const registry = fakeRegistry()
    const slot = holding(registry, 'Alt+Shift+S')
    suspendHotkeys(registry, [slot])
    registry.refused.push('Alt+Shift+S', 'Ctrl+Alt+Del')
    expect(resumeHotkeys(registry, [slot])).toEqual(['Alt+Shift+S'])
    expect(changeHotkey(registry, slot, 'Ctrl+Alt+Del', OTHER)).toEqual({
      ok: false,
      reason: 'refused',
      previousKept: false
    })
  })

  it('refused with no previous accelerator at all: nothing is reported as lost', () => {
    // E.g. registering it at start-up failed, so the slot is empty.
    const registry = fakeRegistry(['Ctrl+Alt+Del'])
    const slot = hotkeySlot(() => undefined)
    expect(changeHotkey(registry, slot, 'Ctrl+Alt+Del', OTHER)).toEqual({
      ok: false,
      reason: 'refused',
      previousKept: true
    })
    expect(slot).toMatchObject({ current: '', registered: false })
  })

  it('taken by the other slot: nothing changes', () => {
    const registry = fakeRegistry()
    const slot = holding(registry, 'Alt+Shift+S')
    expect(changeHotkey(registry, slot, OTHER, OTHER)).toEqual({
      ok: false,
      reason: 'taken',
      previousKept: true
    })
    expect(slot).toMatchObject({ current: 'Alt+Shift+S', registered: true })
    expect([...registry.active]).toEqual(['Alt+Shift+S'])
  })

  it('an empty accelerator: nothing changes', () => {
    const registry = fakeRegistry()
    const slot = holding(registry, 'Alt+Shift+S')
    expect(changeHotkey(registry, slot, '', OTHER)).toEqual({
      ok: false,
      reason: 'empty',
      previousKept: true
    })
    expect(slot).toMatchObject({ current: 'Alt+Shift+S', registered: true })
    expect([...registry.active]).toEqual(['Alt+Shift+S'])
  })
})

describe('changing a hotkey slot during hotkey capture (#292)', () => {
  it('refused: the previous one is kept for resuming, not registered mid-capture', () => {
    // Capture pauses the shortcuts so that pressing them reaches the capture.
    const registry = fakeRegistry(['Ctrl+Alt+Del'])
    const slot = holding(registry, 'Alt+Shift+S')
    suspendHotkeys(registry, [slot])
    expect(changeHotkey(registry, slot, 'Ctrl+Alt+Del', OTHER)).toEqual({
      ok: false,
      reason: 'refused',
      previousKept: true
    })
    expect(slot).toMatchObject({ current: 'Alt+Shift+S', registered: false })
    expect(registry.active.size).toBe(0)
    expect(resumeHotkeys(registry, [slot])).toEqual([])
    expect([...registry.active]).toEqual(['Alt+Shift+S'])
  })

  it('a change that succeeds registers the new accelerator, and resuming leaves it', () => {
    const registry = fakeRegistry()
    const slot = holding(registry, 'Alt+Shift+S')
    suspendHotkeys(registry, [slot])
    expect(changeHotkey(registry, slot, 'Alt+Shift+T', OTHER)).toEqual({ ok: true })
    expect(resumeHotkeys(registry, [slot])).toEqual([])
    expect([...registry.active]).toEqual(['Alt+Shift+T'])
  })

  it('two changes in one capture: the first one is released, not left registered', () => {
    // E.g. "Reset" while capturing, then a new key.
    const registry = fakeRegistry()
    const slot = holding(registry, 'Alt+Shift+S')
    suspendHotkeys(registry, [slot])
    expect(changeHotkey(registry, slot, 'Alt+Shift+R', OTHER)).toEqual({ ok: true })
    expect(changeHotkey(registry, slot, 'Alt+Shift+T', OTHER)).toEqual({ ok: true })
    resumeHotkeys(registry, [slot])
    expect([...registry.active]).toEqual(['Alt+Shift+T'])
  })

  it('resuming fails: the slot says it is not registered and the accelerator is reported', () => {
    const registry = fakeRegistry()
    const slot = holding(registry, 'Alt+Shift+S')
    suspendHotkeys(registry, [slot])
    registry.refused.push('Alt+Shift+S') // another app took it meanwhile
    expect(resumeHotkeys(registry, [slot])).toEqual(['Alt+Shift+S'])
    expect(slot).toMatchObject({ current: 'Alt+Shift+S', registered: false })
    // A later change does not try to unregister what the OS never gave back.
    expect(changeHotkey(registry, slot, 'Alt+Shift+T', OTHER)).toEqual({ ok: true })
    expect([...registry.active]).toEqual(['Alt+Shift+T'])
  })
})
