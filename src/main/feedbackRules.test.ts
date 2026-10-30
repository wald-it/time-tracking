import { describe, expect, it } from 'vitest'

const empty = { prefixes: [], separator: ';', forbidden: [] }

describe('checkFeedbackText', () => {
  it('accepts ordinary text with empty rules', async () => {
    const { checkFeedbackText } = await import('./feedbackRules')
    expect(checkFeedbackText('Work completed', empty, [])).toEqual([])
  })

  it.each(['', ' \n\t '])('ignores empty text %j even with active rules', async (text) => {
    const { checkFeedbackText } = await import('./feedbackRules')
    expect(
      checkFeedbackText(text, { ...empty, prefixes: ['IT'], forbidden: ['secret'] }, ['Anna'])
    ).toEqual([])
  })

  it('requires an exact prefix immediately followed by a colon', async () => {
    const { checkFeedbackText } = await import('./feedbackRules')
    const rules = { ...empty, prefixes: ['IT', 'Ops'] }
    for (const text of ['  IT: done ', 'Ops: done'])
      expect(checkFeedbackText(text, rules, [])).toEqual([])
    for (const text of ['it: done', 'IT : done', 'IT work', 'Other: IT: done'])
      expect(checkFeedbackText(text, rules, [])).toEqual([{ kind: 'prefix', detail: 'IT, Ops' }])
  })

  it('reports every empty segment with a one-based position after the first colon', async () => {
    const { checkFeedbackText } = await import('./feedbackRules')
    expect(checkFeedbackText('IT: ; work;; result; ', empty, [])).toEqual(
      [1, 3, 5].map((n) => ({ kind: 'separator', detail: String(n) }))
    )
    expect(checkFeedbackText('IT: ', empty, [])).toEqual([{ kind: 'separator', detail: '1' }])
    expect(checkFeedbackText('IT: work; result: ready', empty, [])).toEqual([])
  })

  it('splits the whole text without a colon and treats multi-character separators literally', async () => {
    const { checkFeedbackText } = await import('./feedbackRules')
    expect(checkFeedbackText('||work||||', { ...empty, separator: '||' }, [])).toEqual(
      [1, 3, 4].map((n) => ({ kind: 'separator', detail: String(n) }))
    )
    expect(checkFeedbackText('work||result', { ...empty, separator: '||' }, [])).toEqual([])
  })

  it('disables separator checks for an empty separator', async () => {
    const { checkFeedbackText } = await import('./feedbackRules')
    expect(checkFeedbackText('IT: ;; ', { ...empty, separator: '' }, [])).toEqual([])
  })

  it('matches forbidden words once each, case-insensitively, in rule order', async () => {
    const { checkFeedbackText } = await import('./feedbackRules')
    expect(
      checkFeedbackText(
        'Beta ALPHA alpha.',
        { ...empty, forbidden: ['alpha', 'beta', 'absent'] },
        []
      )
    ).toEqual([
      { kind: 'forbidden', detail: 'alpha' },
      { kind: 'forbidden', detail: 'beta' }
    ])
  })

  it('uses Unicode letter and number boundaries, including umlauts', async () => {
    const { checkFeedbackText } = await import('./feedbackRules')
    const rules = { ...empty, forbidden: ['Bär'] }
    expect(checkFeedbackText('Bärbel äBär Bär2 Bär中 3Bär', rules, [])).toEqual([])
    expect(checkFeedbackText('(bÄR)!', rules, [])).toEqual([{ kind: 'forbidden', detail: 'Bär' }])
  })

  it('escapes regex characters in forbidden words and names', async () => {
    const { checkFeedbackText } = await import('./feedbackRules')
    expect(
      checkFeedbackText('a+b met Dr. X', { ...empty, forbidden: ['a+b', 'a.b'] }, [
        'Dr. X',
        'Dr. Y'
      ])
    ).toEqual([
      { kind: 'forbidden', detail: 'a+b' },
      { kind: 'name', detail: 'Dr. X' }
    ])
  })

  it('matches whole name phrases with normalized whitespace and ignores partial names', async () => {
    const { checkFeedbackText } = await import('./feedbackRules')
    expect(
      checkFeedbackText('Met ANNA  MÜLLER and Anna\tMüller.', empty, [
        ' Anna   Müller ',
        'Anna Müller',
        'Karl'
      ])
    ).toEqual([{ kind: 'name', detail: 'Anna Müller' }])
    expect(checkFeedbackText('Anna Müllerchen, Johanna Müller', empty, ['Anna Müller'])).toEqual([])
  })

  it('reports a name already forbidden only as forbidden', async () => {
    const { checkFeedbackText } = await import('./feedbackRules')
    expect(
      checkFeedbackText('Anna  Müller', { ...empty, forbidden: ['anna müller'] }, ['Anna Müller'])
    ).toEqual([{ kind: 'forbidden', detail: 'anna müller' }])
  })

  it('orders findings by prefix, separator, forbidden, name without mutating inputs', async () => {
    const { checkFeedbackText } = await import('./feedbackRules')
    const rules = { prefixes: ['IT'], separator: ';', forbidden: ['secret'] }
    const before = structuredClone(rules)
    expect(checkFeedbackText('Other: Anna; secret;', rules, Object.freeze(['Anna']))).toEqual([
      { kind: 'prefix', detail: 'IT' },
      { kind: 'separator', detail: '3' },
      { kind: 'forbidden', detail: 'secret' },
      { kind: 'name', detail: 'Anna' }
    ])
    expect(rules).toEqual(before)
  })
})
