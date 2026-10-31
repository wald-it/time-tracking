export interface ReviewSelection {
  clientId: number
  projectId?: number
  fromIso: string
  toIso: string
}

export interface BillingPreviewLine {
  projectId: number | null
  projectName: string | null
  rateCent: number
  billedMinutes: number
  feeCent: number
  fromIso: string
  toIso: string
}

export interface DayGridRow {
  date: string
  billedMinutes: number
  activity: string
}

export interface BillingPreview {
  lines: BillingPreviewLine[]
  totals: { billedMinutes: number; feeCent: number }
  billedEntriesCount: number
  dayGrid: DayGridRow[]
}
