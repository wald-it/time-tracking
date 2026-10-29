import { useEffect, useState } from 'react'
import { parseFeedbackRules } from '../../../../shared/feedbackRules'

interface Fields {
  prefixes: string
  separator: string
  forbidden: string
}

function fieldsFromRaw(raw: string | undefined): Fields {
  const rules = parseFeedbackRules(raw)
  return {
    prefixes: rules.prefixes.join(', '),
    separator: rules.separator,
    forbidden: rules.forbidden.join(', ')
  }
}

export function useFeedbackRules(
  raw: string | undefined,
  save: (raw: string) => void
): {
  fields: Fields
  change: (key: keyof Fields, value: string) => void
  names: string[]
  namesError: string | null
} {
  const [draft, setDraft] = useState(() => ({ raw, fields: fieldsFromRaw(raw) }))
  const [names, setNames] = useState<string[]>([])
  const [namesError, setNamesError] = useState<string | null>(null)
  // Keep unfinished commas/spaces while typing; a rejected save restores raw.
  const fields = draft.raw === raw ? draft.fields : fieldsFromRaw(raw)

  useEffect(() => {
    let active = true
    window.api.feedbackRules
      .names()
      .then((result) => {
        if (!active) return
        if (result.ok) setNames(result.data)
        else setNamesError(result.error)
      })
      .catch((error: unknown) => {
        if (active) setNamesError(error instanceof Error ? error.message : String(error))
      })
    return () => {
      active = false
    }
  }, [])

  function change(key: keyof Fields, value: string): void {
    const next = { ...fields, [key]: value }
    const serialized = JSON.stringify(
      parseFeedbackRules(
        JSON.stringify({
          prefixes: next.prefixes.split(','),
          separator: next.separator,
          forbidden: next.forbidden.split(',')
        })
      )
    )
    setDraft({ raw: serialized, fields: next })
    save(serialized)
  }

  return { fields, change, names, namesError }
}
