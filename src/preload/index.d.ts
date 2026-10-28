import type { BillingRunSummary } from '../main/billingRuns'
import type {
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
  AnalyticsSummary,
  BudgetStatus
} from '../shared/types'
import type { AccountStatus, VerifyResult } from '../main/graphAccount'
import type { ClientDomain } from '../main/clientDomains'
import type { CalendarRange } from '../main/graphCalendar'
import type { ImportEntryItem, ImportResult } from '../main/graphImport'
import type { FilterOptions, MappedEvents } from '../shared/graphCalendar'

declare global {
  interface Window {
    api: {
      tray: {
        update(
          isRunning: boolean,
          label: string,
          todaySeconds: number,
          startedAt?: string | null
        ): void
      }
      mini: {
        onState(
          callback: (state: { running: boolean; label: string; startedAt: string | null }) => void
        ): () => void
        requestStart(): void
        requestStop(): void
      }
      hotkeyCapture: {
        begin(): void
        end(): void
      }
      onHotkeyToggle(callback: () => void): () => void
      onOpenStart(callback: () => void): () => void
      onTrayQuickStart(callback: (clientId: number) => void): () => void
      onTrayStop(callback: () => void): () => void
      onDataChanged(callback: () => void): () => void
      onIdleDetected(
        callback: (data: { idleSince: string; idleSeconds: number }) => void
      ): () => void
      idle: {
        dismiss(): void
      }
      clients: {
        getAll(): Promise<IpcResult<Client[]>>
        create(input: CreateClientInput): Promise<IpcResult<Client>>
        update(input: UpdateClientInput): Promise<IpcResult<Client>>
        delete(id: number): Promise<IpcResult<void>>
      }
      entries: {
        versions(id: number): Promise<IpcResult<EntryVersion[]>>
        start(input: CreateEntryInput): Promise<IpcResult<Entry>>
        switch(input: CreateEntryInput): Promise<IpcResult<SwitchTimerResult>>
        stop(id: number): Promise<IpcResult<Entry>>
        heartbeat(id: number): Promise<IpcResult<void>>
        getRunning(): Promise<IpcResult<Entry | null>>
        getByMonth(query: MonthQuery): Promise<IpcResult<Entry[]>>
        create(input: CreateManualEntryInput): Promise<IpcResult<Entry>>
        update(input: UpdateEntryInput): Promise<IpcResult<Entry>>
        delete(id: number): Promise<IpcResult<void>>
        undelete(id: number): Promise<IpcResult<Entry>>
      }
      settings: {
        getAll(): Promise<IpcResult<Settings>>
        set(key: string, value: string): Promise<IpcResult<void>>
      }
      icalFeed: {
        url(): Promise<IpcResult<string>>
        regenerate(): Promise<IpcResult<string>>
      }
      backups: {
        list(): Promise<IpcResult<BackupInfo[]>>
        create(): Promise<IpcResult<string>>
        /** `filename` of an entry from `list()` — a path is refused (#272). */
        restore(filename: string): Promise<IpcResult<{ safetyBackupPath: string }>>
        setPath(): Promise<IpcResult<string>>
        resetPath(): Promise<IpcResult<void>>
        getPathInfo(): Promise<IpcResult<{ dir: string; isCustom: boolean; isReachable: boolean }>>
      }
      dashboard: {
        todayTotal(): Promise<IpcResult<number>>
        summary(): Promise<IpcResult<DashboardSummary>>
      }
      app: {
        relaunch(): Promise<IpcResult<void>>
        getVersion(): Promise<IpcResult<string>>
        getLicenses(): Promise<IpcResult<LicenseEntry[]>>
      }
      shell: {
        openPath(path: string): Promise<IpcResult<void>>
        openExternal(url: string): Promise<IpcResult<void>>
        showItemInFolder(path: string): Promise<IpcResult<void>>
      }
      paths: {
        get(): Promise<
          IpcResult<{
            db: string
            backups: string
            logs: string
            logFile: string
            mcp: {
              command: string
              args: string[]
              env: Record<string, string>
              available: boolean
            }
          }>
        >
      }
      exporter: {
        json(): Promise<IpcResult<{ path: string; bytes: number }>>
      }
      tags: {
        recent(): Promise<IpcResult<string[]>>
        getAllWithCount(): Promise<IpcResult<Array<{ name: string; count: number }>>>
        create(name: string): Promise<IpcResult<void>>
        rename(oldName: string, newName: string): Promise<IpcResult<void>>
        merge(source: string, target: string): Promise<IpcResult<void>>
        delete(name: string): Promise<IpcResult<void>>
      }
      billingRuns: {
        list(clientId?: number): Promise<IpcResult<BillingRunSummary[]>>
        open(runId: number): Promise<IpcResult<void>>
        release(runId: number, reason: string): Promise<IpcResult<void>>
        setInvoiceRef(runId: number, ref: string): Promise<IpcResult<void>>
      }
      pdf: {
        export(req: {
          markAsBilled?: boolean
          replacesRunId?: number
          clientId: number
          fromIso: string
          toIso: string
          projectId?: number | null
          includeSignatures?: boolean
          groupBy?: 'none' | 'tag' | 'project' | 'reference'
          hideFeeColumn?: boolean
          /** @deprecated use groupBy instead. */
          groupByTag?: boolean
        }): Promise<
          IpcResult<{ path: string; runId?: number; runNumber?: string; excludedCount?: number }>
        >
        mergeExport(req: {
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
        }): Promise<IpcResult<{ path: string }>>
        mergeOnly(req: {
          /** @deprecated v1.13 #119 — use stundennachweisPaths to support multi-SN merges. */
          stundennachweisPath?: string
          /** v1.13 #119: one or more Stundennachweis PDFs appended after the invoice, in order. */
          stundennachweisPaths?: string[]
          invoicePath: string
        }): Promise<IpcResult<{ path: string }>>
        pdfInfo(req: { filePath: string }): Promise<IpcResult<{ pageCount: number }>>
        openPdfDialog(): Promise<IpcResult<{ filePath: string } | null>>
      }
      logo: {
        set(): Promise<IpcResult<{ path: string }>>
        clear(): Promise<IpcResult<void>>
      }
      csv: {
        export(req: {
          clientId: number
          fromIso: string
          toIso: string
          projectId?: number | null
          format?: 'de' | 'us'
          groupByTag?: boolean
        }): Promise<IpcResult<{ path: string }>>
      }
      ical: {
        export(req: {
          clientId: number
          fromIso: string
          toIso: string
          projectId?: number | null
          showClientName?: boolean
        }): Promise<IpcResult<{ path: string }>>
      }
      projects: {
        getAll(req?: { clientId?: number | null }): Promise<IpcResult<Project[]>>
        create(input: CreateProjectInput): Promise<IpcResult<Project>>
        update(input: UpdateProjectInput): Promise<IpcResult<Project>>
        archive(id: number): Promise<IpcResult<void>>
        delete(id: number): Promise<IpcResult<void>>
        getBudgetStatus(projectId: number): Promise<IpcResult<BudgetStatus>>
      }
      analytics: {
        getSummary(q: MonthQuery): Promise<IpcResult<AnalyticsSummary>>
      }
      graph: {
        status(): Promise<IpcResult<AccountStatus>>
        connect(): Promise<IpcResult<AccountStatus>>
        cancelConnect(): Promise<IpcResult<void>>
        verify(): Promise<IpcResult<VerifyResult>>
        disconnect(): Promise<IpcResult<AccountStatus>>
        calendarPreview(
          range: CalendarRange,
          filters?: FilterOptions
        ): Promise<IpcResult<MappedEvents>>
        importEntries(items: ImportEntryItem[]): Promise<IpcResult<ImportResult>>
        listDomains(): Promise<IpcResult<ClientDomain[]>>
        learnDomain(
          domain: string,
          clientId: number,
          projectId?: number | null
        ): Promise<IpcResult<ClientDomain>>
        forgetDomain(domain: string): Promise<IpcResult<void>>
      }
      update: {
        getStatus(): Promise<IpcResult<UpdateStatus>>
        getLastCheck(): Promise<IpcResult<string | null>>
        check(): Promise<IpcResult<void>>
        install(): Promise<IpcResult<void>>
        onStatus(callback: (status: UpdateStatus) => void): () => void
      }
    }
  }
}
