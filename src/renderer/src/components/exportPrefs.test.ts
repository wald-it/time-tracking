/**
 * Regression tests for the export-prefs persistence contract (v1.13.2).
 *
 * Background: export modal preferences were stored in localStorage only and
 * got lost intermittently (second app instance without the LevelDB lock,
 * hard exit via app.exit on relaunch). They now live in the DB `settings`
 * table as a JSON blob under `export_prefs`. These tests pin the parse /
 * validate / roundtrip contract that both the save path (ExportModal) and
 * the one-time localStorage migration rely on.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  DEFAULT_PREFS,
  LS_PREFS_KEY,
  parsePrefs,
  readLegacyPrefs,
  type ExportPrefs
} from './exportPrefs'

describe('parsePrefs', () => {
  it('returns defaults for null / undefined / empty input', () => {
    expect(parsePrefs(null)).toEqual(DEFAULT_PREFS)
    expect(parsePrefs(undefined)).toEqual(DEFAULT_PREFS)
    expect(parsePrefs('')).toEqual(DEFAULT_PREFS)
  })

  it('returns defaults for corrupted JSON instead of throwing', () => {
    expect(parsePrefs('{not json')).toEqual(DEFAULT_PREFS)
    expect(parsePrefs('42')).toEqual(DEFAULT_PREFS)
  })

  it('roundtrips a fully non-default pref object', () => {
    const prefs: ExportPrefs = {
      tab: 'csv',
      includeSignatures: true,
      hideFeeColumn: true,
      csvFormat: 'us',
      csvGroupByTag: true,
      icalShowClientName: false
    }
    expect(parsePrefs(JSON.stringify(prefs))).toEqual(prefs)
  })

  it.each(['none', 'tag', 'project', 'reference'] as const)(
    'ignores legacy groupBy value %s because grouping comes from the profile',
    (groupBy) => {
      const parsed = parsePrefs(JSON.stringify({ ...DEFAULT_PREFS, groupBy }))
      expect(parsed).not.toHaveProperty('groupBy')
      expect(parsed).toEqual(DEFAULT_PREFS)
    }
  )

  it.each(['pdf', 'csv', 'ical'] as const)('roundtrips tab value %s', (tab) => {
    expect(parsePrefs(JSON.stringify({ ...DEFAULT_PREFS, tab })).tab).toBe(tab)
  })

  it.each([true, false] as const)('roundtrips icalShowClientName value %s', (val) => {
    expect(
      parsePrefs(JSON.stringify({ ...DEFAULT_PREFS, icalShowClientName: val })).icalShowClientName
    ).toBe(val)
  })

  it.each(['de', 'us'] as const)('roundtrips csvFormat value %s', (csvFormat) => {
    expect(parsePrefs(JSON.stringify({ ...DEFAULT_PREFS, csvFormat })).csvFormat).toBe(csvFormat)
  })

  it('clamps out-of-set values to safe defaults per field', () => {
    const parsed = parsePrefs(
      JSON.stringify({
        tab: 'xml',
        includeSignatures: 'yes',
        groupBy: 'client',
        hideFeeColumn: 1,
        csvFormat: 'fr',
        csvGroupByTag: null
      })
    )
    expect(parsed).toEqual(DEFAULT_PREFS)
  })

  it('fills missing fields of a partial/legacy blob with defaults', () => {
    const parsed = parsePrefs(JSON.stringify({ tab: 'csv' }))
    expect(parsed).toEqual({ ...DEFAULT_PREFS, tab: 'csv' })
  })
})

describe('readLegacyPrefs (localStorage → DB migration source)', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('returns null when no legacy key exists', () => {
    expect(readLegacyPrefs()).toBeNull()
  })

  it('returns the raw legacy blob so migration can re-validate it', () => {
    const legacy = JSON.stringify({ tab: 'csv', csvFormat: 'us' })
    localStorage.setItem(LS_PREFS_KEY, legacy)
    expect(readLegacyPrefs()).toBe(legacy)
    // Migration parses through parsePrefs — corrupted legacy data must
    // still yield a valid pref object.
    expect(parsePrefs(readLegacyPrefs())).toEqual({
      ...DEFAULT_PREFS,
      tab: 'csv',
      csvFormat: 'us'
    })
  })
})
