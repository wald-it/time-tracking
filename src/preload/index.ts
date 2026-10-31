import type { RendererSettingKey } from '../shared/settingKeys'
import type { BillingPreview, ReviewSelection } from '../shared/billingPreview'
import type { BillingRunSummary } from '../main/billingRuns'
import type { ChangedSinceRunRequest, ChangedSinceRunResult } from '../main/changedSinceRun'
import type { RuleCheckRequest } from '../main/ruleCheck'
import type { RuleCheckFinding, PeriodReviewEntry } from '../shared/ruleCheck'
import type {
  RateTarget,
  RateEditorData,
  SaveRateInput,
  ProfileFields,
  ProfileEditorData
} from '../shared/rateEditor'
import { contextBridge, ipcRenderer } from 'electron'
import type {
  McpApprovalState,
  Client,
  Entry,
  EntryVersion,
  Project,
  CreateClientInput,
  UpdateClientInput,
  CreateEntryInput,
  SwitchTimerResult,
  CreateManualEntryInput,
  UpdateEntryInput,
  CreateProjectInput,
  UpdateProjectInput,
  MonthQuery,
  Settings,
  IpcResult,
  BackupInfo,
  DashboardSummary,
  UpdateStatus,
  LicenseEntry,
  AnalyticsSummary
} from '../shared/types'
import type { CsvRequest } from '../main/csvExport'
import type { AccountStatus, VerifyResult } from '../main/graphAccount'
import type { ClientDomain } from '../main/clientDomains'
import type { CalendarRange } from '../main/graphCalendar'
import type { ImportEntryItem, ImportResult } from '../main/graphImport'
import type { FilterOptions, MappedEvents } from '../shared/graphCalendar'
import type { IcalRequest } from '../main/icalExport'

// ── v1.8 #76: FOUC prevention ─────────────────────────────────────────────
// document.documentElement is null when the preload runs (HTML not yet parsed).
// DOMContentLoaded is still FOUC-safe in Electron: the main window is only
// shown after ready-to-show, which fires after DOMContentLoaded + first paint.
// By the time the user sees anything, .dark is already set.
document.addEventListener('DOMContentLoaded', () => {
  const rawMode = ipcRenderer.sendSync('settings:getSync', 'theme_mode') as string | null
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  const isDark = rawMode === 'dark' || (rawMode !== 'light' && prefersDark)
  document.documentElement.classList.toggle('dark', isDark)
})
// ──────────────────────────────────────────────────────────────────────────

const api = {
  ruleCheck: {
    period: (request: RuleCheckRequest): Promise<IpcResult<RuleCheckFinding[]>> =>
      ipcRenderer.invoke('ruleCheck:period', request)
  },
  mcpApproval: {
    get: (): Promise<IpcResult<McpApprovalState>> => ipcRenderer.invoke('mcp:approval-state'),
    onChanged: (callback: (state: McpApprovalState) => void): (() => void) => {
      const handler = (_e: unknown, state: McpApprovalState): void => callback(state)
      ipcRenderer.on('mcp:approval-changed', handler)
      return () => ipcRenderer.removeListener('mcp:approval-changed', handler)
    }
  },
  rates: {
    list: (target: RateTarget): Promise<IpcResult<RateEditorData>> =>
      ipcRenderer.invoke('rates:list', target),
    save: (target: RateTarget, input: SaveRateInput): Promise<IpcResult<RateEditorData>> =>
      ipcRenderer.invoke('rates:save', target, input),
    delete: (target: RateTarget, id: number): Promise<IpcResult<RateEditorData>> =>
      ipcRenderer.invoke('rates:delete', target, id)
  },
  billingProfile: {
    get: (target: RateTarget): Promise<IpcResult<ProfileEditorData>> =>
      ipcRenderer.invoke('billing-profile:get', target),
    save: (target: RateTarget, fields: ProfileFields): Promise<IpcResult<ProfileEditorData>> =>
      ipcRenderer.invoke('billing-profile:save', target, fields)
  },
  // Tray + hotkey
  tray: {
    update: (
      isRunning: boolean,
      label: string,
      todaySeconds: number,
      startedAt: string | null = null
    ): void => ipcRenderer.send('tray:update', isRunning, label, todaySeconds, startedAt)
  },
  // v1.4 PR B — mini-widget channels.
  mini: {
    onState: (
      callback: (state: { running: boolean; label: string; startedAt: string | null }) => void
    ): (() => void) => {
      const handler = (
        _e: unknown,
        state: { running: boolean; label: string; startedAt: string | null }
      ): void => callback(state)
      ipcRenderer.on('mini:state-changed', handler)
      return (): void => {
        ipcRenderer.removeListener('mini:state-changed', handler)
      }
    },
    requestStart: (): void => ipcRenderer.send('mini:request-start'),
    requestStop: (): void => ipcRenderer.send('mini:request-stop')
  },
  hotkeyCapture: {
    begin: (): void => ipcRenderer.send('hotkey:beginCapture'),
    end: (): void => ipcRenderer.send('hotkey:endCapture')
  },
  onHotkeyToggle: (callback: () => void): (() => void) => {
    const handler = (): void => callback()
    ipcRenderer.on('timer:hotkey-toggle', handler)
    return () => ipcRenderer.removeListener('timer:hotkey-toggle', handler)
  },
  // #297: the start hotkey / mini play found nothing to start — main has
  // brought the window forward; open the START dialog.
  onOpenStart: (callback: () => void): (() => void) => {
    const handler = (): void => callback()
    ipcRenderer.on('timer:open-start', handler)
    return () => ipcRenderer.removeListener('timer:open-start', handler)
  },
  onTrayQuickStart: (callback: (clientId: number) => void): (() => void) => {
    const handler = (_e: unknown, clientId: number): void => callback(clientId)
    ipcRenderer.on('timer:tray-quick-start', handler)
    return () => ipcRenderer.removeListener('timer:tray-quick-start', handler)
  },
  onTrayStop: (callback: () => void): (() => void) => {
    const handler = (): void => callback()
    ipcRenderer.on('timer:tray-stop', handler)
    return () => ipcRenderer.removeListener('timer:tray-stop', handler)
  },
  // External writes (MCP bridge / hardware keys, #133): main broadcasts after
  // committing a mutation the renderer didn't initiate — resync timer state.
  onDataChanged: (callback: () => void): (() => void) => {
    const handler = (): void => callback()
    ipcRenderer.on('data:changed', handler)
    return () => ipcRenderer.removeListener('data:changed', handler)
  },
  onIdleDetected: (
    callback: (data: { idleSince: string; idleSeconds: number }) => void
  ): (() => void) => {
    const handler = (_e: unknown, data: { idleSince: string; idleSeconds: number }): void =>
      callback(data)
    ipcRenderer.on('timer:idle-detected', handler)
    return () => ipcRenderer.removeListener('timer:idle-detected', handler)
  },
  idle: {
    dismiss: (): void => ipcRenderer.send('idle:dismiss')
  },
  // Clients
  clients: {
    getAll: (): Promise<IpcResult<Client[]>> => ipcRenderer.invoke('clients:getAll'),
    create: (input: CreateClientInput): Promise<IpcResult<Client>> =>
      ipcRenderer.invoke('clients:create', input),
    update: (input: UpdateClientInput): Promise<IpcResult<Client>> =>
      ipcRenderer.invoke('clients:update', input),
    delete: (id: number): Promise<IpcResult<void>> => ipcRenderer.invoke('clients:delete', id)
  },
  // Entries
  entries: {
    getForReview: (request: RuleCheckRequest): Promise<IpcResult<PeriodReviewEntry[]>> =>
      ipcRenderer.invoke('entries:getForReview', request),
    versions: (id: number): Promise<IpcResult<EntryVersion[]>> =>
      ipcRenderer.invoke('entries:versions', id),
    start: (input: CreateEntryInput): Promise<IpcResult<Entry>> =>
      ipcRenderer.invoke('entries:start', input),
    // B1: stop the running entry and start this one at ONE instant.
    switch: (input: CreateEntryInput): Promise<IpcResult<SwitchTimerResult>> =>
      ipcRenderer.invoke('entries:switch', input),
    // Q8: the description field's suggestions for one client + project.
    recentDescriptions: (pair: {
      clientId: number
      projectId: number | null
    }): Promise<IpcResult<string[]>> => ipcRenderer.invoke('entries:recentDescriptions', pair),
    stop: (id: number): Promise<IpcResult<Entry>> => ipcRenderer.invoke('entries:stop', id),
    stopAt: (id: number, stoppedAt: string): Promise<IpcResult<Entry>> =>
      ipcRenderer.invoke('entries:stopAt', id, stoppedAt),
    heartbeat: (id: number): Promise<IpcResult<void>> =>
      ipcRenderer.invoke('entries:heartbeat', id),
    getRunning: (): Promise<IpcResult<Entry | null>> => ipcRenderer.invoke('entries:getRunning'),
    getByMonth: (query: MonthQuery): Promise<IpcResult<Entry[]>> =>
      ipcRenderer.invoke('entries:getByMonth', query),
    create: (input: CreateManualEntryInput): Promise<IpcResult<Entry>> =>
      ipcRenderer.invoke('entries:create', input),
    update: (input: UpdateEntryInput): Promise<IpcResult<Entry>> =>
      ipcRenderer.invoke('entries:update', input),
    delete: (id: number, reason?: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke('entries:delete', id, reason),
    undelete: (id: number, reason?: string): Promise<IpcResult<Entry>> =>
      ipcRenderer.invoke('entries:undelete', id, reason)
  },
  // Settings
  icalFeed: {
    url: (): Promise<IpcResult<string>> => ipcRenderer.invoke('icalFeed:url'),
    regenerate: (): Promise<IpcResult<string>> => ipcRenderer.invoke('icalFeed:regenerate')
  },
  settings: {
    getAll: (): Promise<IpcResult<Settings>> => ipcRenderer.invoke('settings:getAll'),
    set: (key: RendererSettingKey, value: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke('settings:set', key, value)
  },
  feedbackRules: {
    names: (): Promise<IpcResult<string[]>> => ipcRenderer.invoke('feedbackRules:names')
  },
  backups: {
    list: (): Promise<IpcResult<BackupInfo[]>> => ipcRenderer.invoke('backup:list'),
    create: (): Promise<IpcResult<string>> => ipcRenderer.invoke('backup:create'),
    restore: (filename: string): Promise<IpcResult<{ safetyBackupPath: string }>> =>
      ipcRenderer.invoke('backup:restore', filename),
    setPath: (): Promise<IpcResult<string>> => ipcRenderer.invoke('backup:set-path'),
    resetPath: (): Promise<IpcResult<void>> => ipcRenderer.invoke('backup:reset-path'),
    getPathInfo: (): Promise<IpcResult<{ dir: string; isCustom: boolean; isReachable: boolean }>> =>
      ipcRenderer.invoke('backup:get-path-info')
  },
  // Dashboard
  dashboard: {
    todayTotal: (): Promise<IpcResult<number>> => ipcRenderer.invoke('dashboard:todayTotal'),
    summary: (): Promise<IpcResult<DashboardSummary>> => ipcRenderer.invoke('dashboard:summary')
  },
  app: {
    relaunch: (): Promise<IpcResult<void>> => ipcRenderer.invoke('app:relaunch'),
    getVersion: (): Promise<IpcResult<string>> => ipcRenderer.invoke('app:getVersion'),
    getLicenses: (): Promise<IpcResult<LicenseEntry[]>> => ipcRenderer.invoke('app:getLicenses')
  },
  shell: {
    openPath: (path: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke('shell:openPath', path),
    openExternal: (url: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke('shell:openExternal', url),
    showItemInFolder: (path: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke('shell:showItemInFolder', path)
  },
  paths: {
    get: (): Promise<IpcResult<{ db: string; backups: string; logs: string; logFile: string }>> =>
      ipcRenderer.invoke('paths:get')
  },
  exporter: {
    json: (): Promise<IpcResult<{ path: string; bytes: number }>> =>
      ipcRenderer.invoke('export:json')
  },
  tags: {
    recent: (): Promise<IpcResult<string[]>> => ipcRenderer.invoke('tags:recent'),
    getAllWithCount: (): Promise<IpcResult<Array<{ name: string; count: number }>>> =>
      ipcRenderer.invoke('tags:get-all-with-count'),
    create: (name: string): Promise<IpcResult<void>> => ipcRenderer.invoke('tags:create', name),
    rename: (oldName: string, newName: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke('tags:rename', oldName, newName),
    merge: (source: string, target: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke('tags:merge', source, target),
    delete: (name: string): Promise<IpcResult<void>> => ipcRenderer.invoke('tags:delete', name)
  },
  review: {
    billingPreview: (req: ReviewSelection): Promise<IpcResult<BillingPreview>> =>
      ipcRenderer.invoke('review:billingPreview', req),
    exportDayGrid: (req: ReviewSelection): Promise<IpcResult<{ path: string }>> =>
      ipcRenderer.invoke('review:exportDayGrid', req),
    changedSinceRun: (req: ChangedSinceRunRequest): Promise<IpcResult<ChangedSinceRunResult>> =>
      ipcRenderer.invoke('review:changedSinceRun', req)
  },
  billingRuns: {
    list: (clientId?: number): Promise<IpcResult<BillingRunSummary[]>> =>
      ipcRenderer.invoke('billing-runs:list', clientId),
    open: (runId: number): Promise<IpcResult<void>> =>
      ipcRenderer.invoke('billing-runs:open', runId),
    release: (runId: number, reason: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke('billing-runs:release', runId, reason),
    setInvoiceRef: (runId: number, ref: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke('billing-runs:set-invoice-ref', runId, ref)
  },
  pdf: {
    export: (req: {
      columns?: 'times' | 'no_times'
      invoiceRef?: string
      markAsBilled?: boolean
      replacesRunId?: number
      clientId: number
      fromIso: string
      toIso: string
      projectId?: number | null
      includeSignatures?: boolean
      /** v1.13 #118: row grouping. 'none' = flat. */
      groupBy?: 'none' | 'tag' | 'project' | 'reference'
      /** v1.13 #118: hide the Honorar column even when a rate is configured. */
      hideFeeColumn?: boolean
      /** @deprecated use groupBy instead. */
      groupByTag?: boolean
    }): Promise<
      IpcResult<{ path: string; runId?: number; runNumber?: string; excludedCount?: number }>
    > => ipcRenderer.invoke('pdf:export', req),
    mergeExport: (req: {
      clientId: number
      fromIso: string
      toIso: string
      projectId?: number | null
      includeSignatures?: boolean
      groupBy?: 'none' | 'tag' | 'project' | 'reference'
      hideFeeColumn?: boolean
      /** @deprecated use groupBy instead. */
      groupByTag?: boolean
      invoicePath: string
    }): Promise<IpcResult<{ path: string }>> => ipcRenderer.invoke('pdf:merge-export', req),
    mergeOnly: (req: {
      /** @deprecated v1.13 #119 — use stundennachweisPaths to support multi-SN merges. */
      stundennachweisPath?: string
      /** v1.13 #119: one or more Stundennachweis PDFs appended after the invoice, in order. */
      stundennachweisPaths?: string[]
      invoicePath: string
    }): Promise<IpcResult<{ path: string }>> => ipcRenderer.invoke('pdf:merge-only', req),
    pdfInfo: (req: { filePath: string }): Promise<IpcResult<{ pageCount: number }>> =>
      ipcRenderer.invoke('pdf:pdf-info', req),
    openPdfDialog: (): Promise<IpcResult<{ filePath: string } | null>> =>
      ipcRenderer.invoke('pdf:open-pdf-dialog')
  },
  logo: {
    set: (): Promise<IpcResult<{ path: string }>> => ipcRenderer.invoke('logo:set'),
    clear: (): Promise<IpcResult<void>> => ipcRenderer.invoke('logo:clear')
  },
  // v1.5 PR C — CSV export
  csv: {
    export: (req: CsvRequest): Promise<IpcResult<{ path: string }>> =>
      ipcRenderer.invoke('csv:export', req)
  },
  // #135 — iCal export (Stufe 1: statischer .ics-Export)
  ical: {
    export: (req: IcalRequest): Promise<IpcResult<{ path: string }>> =>
      ipcRenderer.invoke('ical:export', req)
  },
  // v1.9 #75 — Projects
  projects: {
    getAll: (req?: { clientId?: number | null }): Promise<IpcResult<Project[]>> =>
      ipcRenderer.invoke('projects:getAll', req),
    create: (input: CreateProjectInput): Promise<IpcResult<Project>> =>
      ipcRenderer.invoke('projects:create', input),
    update: (input: UpdateProjectInput): Promise<IpcResult<Project>> =>
      ipcRenderer.invoke('projects:update', input),
    archive: (id: number): Promise<IpcResult<void>> => ipcRenderer.invoke('projects:archive', id),
    delete: (id: number): Promise<IpcResult<void>> => ipcRenderer.invoke('projects:delete', id)
  },
  // v1.10 #93 — Analytics
  analytics: {
    getSummary: (q: MonthQuery): Promise<IpcResult<AnalyticsSummary>> =>
      ipcRenderer.invoke('analytics:summary', q)
  },
  // #130 — Microsoft account (calendar import). `status` never carries tokens.
  graph: {
    status: (): Promise<IpcResult<AccountStatus>> => ipcRenderer.invoke('graph:status'),
    connect: (): Promise<IpcResult<AccountStatus>> => ipcRenderer.invoke('graph:connect'),
    cancelConnect: (): Promise<IpcResult<void>> => ipcRenderer.invoke('graph:cancelConnect'),
    verify: (): Promise<IpcResult<VerifyResult>> => ipcRenderer.invoke('graph:verify'),
    disconnect: (): Promise<IpcResult<AccountStatus>> => ipcRenderer.invoke('graph:disconnect'),
    calendarPreview: (
      range: CalendarRange,
      filters?: FilterOptions
    ): Promise<IpcResult<MappedEvents>> =>
      ipcRenderer.invoke('graph:calendarPreview', range, filters),
    importEntries: (items: ImportEntryItem[]): Promise<IpcResult<ImportResult>> =>
      ipcRenderer.invoke('graph:importEntries', items),
    listDomains: (): Promise<IpcResult<ClientDomain[]>> => ipcRenderer.invoke('graph:listDomains'),
    learnDomain: (
      domain: string,
      clientId: number,
      projectId?: number | null
    ): Promise<IpcResult<ClientDomain>> =>
      ipcRenderer.invoke('graph:learnDomain', domain, clientId, projectId ?? null),
    forgetDomain: (domain: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke('graph:forgetDomain', domain)
  },
  // v1.5 PR B — auto-updater
  update: {
    getStatus: (): Promise<IpcResult<UpdateStatus>> => ipcRenderer.invoke('update:getStatus'),
    getLastCheck: (): Promise<IpcResult<string | null>> =>
      ipcRenderer.invoke('update:getLastCheck'),
    check: (): Promise<IpcResult<void>> => ipcRenderer.invoke('update:check'),
    install: (): Promise<IpcResult<void>> => ipcRenderer.invoke('update:install'),
    onStatus: (callback: (status: UpdateStatus) => void): (() => void) => {
      const handler = (_e: unknown, status: UpdateStatus): void => callback(status)
      ipcRenderer.on('update:status', handler)
      return (): void => {
        ipcRenderer.removeListener('update:status', handler)
      }
    }
  }
}

// #272: the renderer gets the app's own API and nothing else — no generic
// ipcRenderer, no process.env. This also keeps the preload free of
// non-`electron` imports, which a sandboxed preload could not load.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.api = api
}
