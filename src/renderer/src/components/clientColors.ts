import type { TranslationKey } from '../../../shared/locales/de'

/** Client/project colour presets, shared by the Kunden forms and the onboarding. */
export const CLIENT_COLORS = [
  '#6366f1', // indigo
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#f59e0b', // amber
  '#10b981', // emerald
  '#3b82f6', // blue
  '#ef4444', // red
  '#f97316', // orange
  '#14b8a6', // teal
  '#84cc16' // lime
]

export const COLOR_NAME_KEYS: Record<string, TranslationKey> = {
  '#6366f1': 'clients.color.indigo',
  '#8b5cf6': 'clients.color.violet',
  '#ec4899': 'clients.color.pink',
  '#f59e0b': 'clients.color.amber',
  '#10b981': 'clients.color.emerald',
  '#3b82f6': 'clients.color.blue',
  '#ef4444': 'clients.color.red',
  '#f97316': 'clients.color.orange',
  '#14b8a6': 'clients.color.teal',
  '#84cc16': 'clients.color.lime'
}
