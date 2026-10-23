import { describe, it, expect } from 'vitest'
import { localeFromSetting, translate } from './i18n'
import type { TranslationKey } from './locales/de'
import { de } from './locales/de'
import { en } from './locales/en'

describe('translate()', () => {
  it('returns the DE string for a known key', () => {
    expect(translate(de, 'update.checking')).toBe('Suche nach Updates …')
  })

  it('returns the EN string for a known key', () => {
    expect(translate(en, 'update.checking')).toBe('Checking for updates …')
  })

  it('falls back to the key itself for unknown keys', () => {
    expect(translate(de, 'nonexistent.key')).toBe('nonexistent.key')
  })

  it('interpolates a single variable', () => {
    const result = translate(de, 'update.available', { version: '1.5.1' })
    expect(result).toBe('Version 1.5.1 verfügbar — wird heruntergeladen …')
  })

  it('interpolates multiple variables', () => {
    const result = translate(de, 'update.downloading', { version: '1.5.1', progress: 42 })
    expect(result).toBe('Lade Version 1.5.1: 42%')
  })

  it('interpolates in EN locale', () => {
    const result = translate(en, 'update.downloading', { version: '1.5.1', progress: 99 })
    expect(result).toBe('Downloading version 1.5.1: 99%')
  })

  it('handles missing vars gracefully — leaves placeholder unchanged', () => {
    const result = translate(de, 'update.available', {})
    expect(result).toContain('{version}')
  })

  it('returns key when strings map is empty', () => {
    expect(translate({}, 'update.checking')).toBe('update.checking')
  })

  // #296: one pass, so outside data in a value is never read as a slot.
  it('a value that looks like a slot stays as written', () => {
    const strings = { k: '{a} and {b}' }
    expect(translate(strings, 'k', { a: '{b}', b: 'B' })).toBe('{b} and B')
    expect(translate(strings, 'k', { a: 'A' })).toBe('A and {b}')
  })

  it('fills a slot that appears twice', () => {
    expect(translate({ k: '{x}-{x}' }, 'k', { x: 1 })).toBe('1-1')
  })
})

describe('localeFromSetting()', () => {
  it('en is English, anything else German', () => {
    expect(localeFromSetting('en')).toBe('en')
    expect(localeFromSetting('de')).toBe('de')
    expect(localeFromSetting(undefined)).toBe('de')
    expect(localeFromSetting(null)).toBe('de')
    expect(localeFromSetting('fr')).toBe('de')
  })
})

describe('locale completeness', () => {
  const deKeys = Object.keys(de) as TranslationKey[]

  it('EN locale has all DE keys', () => {
    const missing = deKeys.filter((k) => !(k in en))
    expect(missing).toEqual([])
  })

  it('no locale key is an empty string', () => {
    const enRecord = en as Record<string, string>
    const deRecord = de as Record<string, string>
    const emptyDE = deKeys.filter((k) => deRecord[k] === '')
    const emptyEN = deKeys.filter((k) => enRecord[k] === '')
    expect(emptyDE).toEqual([])
    expect(emptyEN).toEqual([])
  })

  // #296 part B: German quotes are „…“ throughout; a straight " or ' in a
  // German text is a quote that slipped back in.
  it('DE strings quote with „…“, never with straight quotes', () => {
    const straight = deKeys.filter((k) => /["']/.test(de[k]))
    expect(straight).toEqual([])
  })

  it('all DE strings contain their interpolation slots in EN', () => {
    // Slots like {version} in DE must also appear in EN (or be intentionally dropped).
    // This catches copy-paste mistakes where the slot is forgotten.
    const SLOT_RE = /\{(\w+)\}/g
    const mismatches: string[] = []
    for (const key of deKeys) {
      const deSlots = [...de[key].matchAll(SLOT_RE)].map((m) => m[1]).sort()
      const enSlots = [...en[key].matchAll(SLOT_RE)].map((m) => m[1]).sort()
      if (JSON.stringify(deSlots) !== JSON.stringify(enSlots)) {
        mismatches.push(
          `${key}: DE has {${deSlots.join('}, {')}}, EN has {${enSlots.join('}, {')}}`
        )
      }
    }
    expect(mismatches).toEqual([])
  })
})
