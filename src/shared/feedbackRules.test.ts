import { describe, expect, it } from 'vitest'

describe('feedback rule parser', () => {
  it.each([undefined, '', '{broken', 'null', '[]', '42', '"text"'])(
    'defaults for %j',
    async (raw) => {
      const { parseFeedbackRules, DEFAULT_FEEDBACK_RULES } = await import('./feedbackRules')
      expect(DEFAULT_FEEDBACK_RULES).toEqual({ prefixes: [], separator: ';', forbidden: [] })
      expect(parseFeedbackRules(raw)).toEqual(DEFAULT_FEEDBACK_RULES)
    }
  )

  it('trims lists, drops non-strings and empty items, and deduplicates without case', async () => {
    const { parseFeedbackRules } = await import('./feedbackRules')
    expect(
      parseFeedbackRules(
        JSON.stringify({
          prefixes: [' IT ', 1, null, '', 'it', 'Ops'],
          separator: ' | ',
          forbidden: [' Bär ', false, 'bÄr', '  ', 'Foo']
        })
      )
    ).toEqual({ prefixes: ['IT', 'Ops'], separator: '|', forbidden: ['Bär', 'Foo'] })
  })

  it('defaults missing or invalid fields independently', async () => {
    const { parseFeedbackRules } = await import('./feedbackRules')
    expect(
      parseFeedbackRules('{"prefixes":"IT","separator":false,"forbidden":["secret"]}')
    ).toEqual({ prefixes: [], separator: ';', forbidden: ['secret'] })
    expect(parseFeedbackRules('{}')).toEqual({ prefixes: [], separator: ';', forbidden: [] })
  })

  it('preserves an explicitly empty separator to disable the rule', async () => {
    const { parseFeedbackRules } = await import('./feedbackRules')
    expect(parseFeedbackRules('{"separator":"  "}').separator).toBe('')
  })
})
