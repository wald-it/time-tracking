import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RULE_CHECK,
  formatRuleCheckFinding,
  isValidRuleCheck,
  parseRuleCheck,
  RULE_CHECK_IDS
} from './ruleCheck'
import { de } from './locales/de'
import { en } from './locales/en'

describe('rule check settings and messages', () => {
  it('defaults absent, malformed and non-object settings', () => {
    for (const raw of [undefined, '', '{bad', 'null', '[]', '7', 'true'])
      expect(parseRuleCheck(raw)).toEqual(DEFAULT_RULE_CHECK)
    expect(DEFAULT_RULE_CHECK).toEqual({
      entryMaxHours: 10,
      dayMaxHours: 10,
      windowStart: '06:00',
      windowEnd: '22:00',
      weekend: true,
      maxDescriptionLength: 300
    })
  })
  it('preserves valid fields and defaults invalid fields and reversed windows', () => {
    expect(
      parseRuleCheck(
        JSON.stringify({
          entryMaxHours: 1.5,
          dayMaxHours: -1,
          windowStart: '22:00',
          windowEnd: '06:00',
          weekend: false,
          maxDescriptionLength: 1.5
        })
      )
    ).toEqual({ ...DEFAULT_RULE_CHECK, entryMaxHours: 1.5, weekend: false })
    for (const value of [0, -1, '10', null])
      expect(parseRuleCheck(JSON.stringify({ entryMaxHours: value }))).toEqual(DEFAULT_RULE_CHECK)
    expect(
      parseRuleCheck(JSON.stringify({ windowStart: '6:00', windowEnd: '25:00', weekend: 'false' }))
    ).toEqual(DEFAULT_RULE_CHECK)
  })
  it('validates finite positive thresholds, whole text lengths and ordered HH:MM windows', () => {
    expect(isValidRuleCheck(DEFAULT_RULE_CHECK)).toBe(true)
    for (const patch of [
      { entryMaxHours: NaN },
      { entryMaxHours: Infinity },
      { dayMaxHours: 0 },
      { maxDescriptionLength: 0.5 },
      { maxDescriptionLength: Number.MAX_SAFE_INTEGER + 1 },
      { windowStart: '06:60' },
      { windowEnd: '24:00' },
      { windowEnd: '06:00' }
    ])
      expect(isValidRuleCheck({ ...DEFAULT_RULE_CHECK, ...patch })).toBe(false)
  })
  it.each(RULE_CHECK_IDS)('provides and formats both locales for %s', (rule) => {
    for (const locale of ['de', 'en'] as const) {
      const strings = locale === 'de' ? de : en
      expect(strings[`ruleCheck.${rule}`]).toBeTruthy()
      const text = formatRuleCheckFinding(
        {
          entryId: 1,
          rule,
          params: {
            hours: 11,
            threshold: 10,
            day: '2026-06-01',
            start: '06:00',
            end: '22:00',
            name: 'Anna',
            field: 'secret',
            length: 301
          }
        },
        locale
      )
      expect(text).not.toMatch(/\{\w+\}|ruleCheck\./)
      if (rule === 'format_name') expect(text).toContain('Anna')
    }
  })
})
