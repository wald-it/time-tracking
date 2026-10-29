/** Stable main-process messages, mapped to translated field text in the renderer. */
export const RATE_EDITOR_CONFLICT_ERROR =
  'Für heute ist bereits eine Satzzeile im Editor hinterlegt. Bitte dort ändern.'
export const RATE_DATE_ERROR = 'Bitte ein gültiges Datum im Format JJJJ-MM-TT eingeben.'
export const RATE_VALUE_ERROR =
  'Der Satz muss eine ganze Zahl ab 0 Cent sein. Nur Projekte dürfen den Kundensatz erben.'
export const RATE_BASELINE_ERROR = 'Das Datum 0001-01-01 der Kundenzeile bleibt bestehen.'
export const RATE_DELETE_ERROR = 'Die erste oder letzte Kundenzeile kann nicht gelöscht werden.'
export const PROFILE_INTERVAL_ERROR =
  'Der Takt muss eine ganze Zahl von 0 bis 60 Minuten oder leer sein.'
export const PROFILE_MINIMUM_ERROR =
  'Die Mindestzeit muss eine ganze Zahl ab 0 Minuten oder leer sein.'
export const RATE_OWNER_ERROR = 'Kunde oder Projekt nicht gefunden.'
export const RATE_ROW_ERROR = 'Satzzeile nicht gefunden.'

export interface RateTarget {
  kind: 'client' | 'project'
  id: number
}
export interface RateRow {
  id: number
  valid_from: string
  rate_cent: number | null
}
export interface SaveRateInput {
  id?: number
  valid_from: string
  rate_cent: number | null
}
export interface ProfileFields {
  interval_min: number | null
  min_unit_min: number | null
}
export interface ProfileEditorData extends ProfileFields {
  inherited: { interval_min: number; min_unit_min: number }
}
export interface RateEditorData {
  rows: RateRow[]
  current_rate_cent: number | null
}
