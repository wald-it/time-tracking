import { useState, useEffect, useCallback, useRef } from 'react'
import type {
  Client,
  CreateClientInput,
  UpdateClientInput,
  Project,
  ProjectWithCount,
  CreateProjectInput,
  UpdateProjectInput
} from '../../../shared/types'
import { formatRateInput, parseRateInput } from '../../../shared/rate'
import {
  normaliseShortCodeInput,
  SHORT_CODE_INVALID_ERROR,
  SHORT_CODE_MAX_LENGTH,
  SHORT_CODE_PATTERN,
  SHORT_CODE_TAKEN_ERROR
} from '../../../shared/clientShortCode'
import { useClientsStore } from '../store/clientsStore'
import { useProjectsStore } from '../store/projectsStore'
import { useT, useLocale } from '../contexts/I18nContext'
import { useUiPrefsStore } from '../store/uiPrefsStore'
import * as Icons from '../components/Icons'
import {
  FIELD_LABEL,
  FOCUS,
  ICON_BTN,
  INPUT,
  KEY,
  KEY_INV,
  LEGEND,
  SECTION,
  VIEW_TITLE
} from '../components/instrumentClasses'
import { Dialog } from '../components/Dialog'
import { ColorSwatches } from '../components/ColorSwatches'
import { CLIENT_COLORS } from '../components/clientColors'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { BillingEditors } from '../components/BillingEditors'
import { RATE_EDITOR_CONFLICT_ERROR } from '../../../shared/rateEditor'

/** Lightens a hex color by the given amount (0-100) to create a visually
 * related but distinct project color from the client color. */
function shiftColor(hex: string, lightnessShift = 18): string {
  if (!hex || !hex.startsWith('#') || hex.length !== 7) return hex
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b)
  let h = 0,
    s = 0
  const l = (max + min) / 2
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    switch (max) {
      case r:
        h = ((g - b) / d + (g < b ? 6 : 0)) / 6
        break
      case g:
        h = ((b - r) / d + 2) / 6
        break
      default:
        h = ((r - g) / d + 4) / 6
    }
  }
  const newL = Math.min(0.85, Math.max(0, l + lightnessShift / 100))
  function hue2rgb(p: number, q: number, t: number): number {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  let nr, ng, nb
  if (s === 0) {
    nr = ng = nb = newL
  } else {
    const q = newL < 0.5 ? newL * (1 + s) : newL + s - newL * s
    const p = 2 * newL - q
    nr = hue2rgb(p, q, h + 1 / 3)
    ng = hue2rgb(p, q, h)
    nb = hue2rgb(p, q, h - 1 / 3)
  }
  const toHex = (x: number): string =>
    Math.round(x * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${toHex(nr)}${toHex(ng)}${toHex(nb)}`
}

/** Returns a human-readable relative date string (e.g. "vor 3 Tagen") using Intl.RelativeTimeFormat. */
function formatRelativeDate(isoDate: string, locale: string): string {
  const diff = new Date(isoDate).getTime() - Date.now()
  const diffDays = Math.round(diff / (1000 * 60 * 60 * 24))
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  if (Math.abs(diffDays) < 1) return rtf.format(0, 'day')
  if (Math.abs(diffDays) < 30) return rtf.format(diffDays, 'day')
  if (Math.abs(diffDays) < 365) return rtf.format(Math.round(diffDays / 30), 'month')
  return rtf.format(Math.round(diffDays / 365), 'year')
}

/** Status legend beside a name (paused, archived): hairline frame, table-label type. */
const STATUS_TAG = `shrink-0 rounded-[var(--r-fine)] border border-[var(--ink3)] px-1.5 py-0.5 leading-none ${FIELD_LABEL}`

export default function ClientsView(): React.JSX.Element {
  const t = useT()
  const [clients, setClients] = useState<Client[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editingClient, setEditingClient] = useState<Client | null>(null)
  const [archivedExpanded, setArchivedExpanded] = useState(false)
  const bumpClientsVersion = useClientsStore((s) => s.bumpVersion)
  const bumpProjectsVersion = useProjectsStore((s) => s.bumpVersion)

  // Project sub-list state
  const [expandedClientIds, setExpandedClientIds] = useState<Set<number>>(new Set())
  const [projectsByClient, setProjectsByClient] = useState<Record<number, ProjectWithCount[]>>({})
  const [showProjectForm, setShowProjectForm] = useState(false)
  const [editingProject, setEditingProject] = useState<Project | null>(null)
  const [projectFormClientId, setProjectFormClientId] = useState<number | null>(null)

  // Pending-delete state (drives ConfirmDialog instead of native confirm())
  const [pendingDeleteClient, setPendingDeleteClient] = useState<Client | null>(null)
  const [pendingDeleteProject, setPendingDeleteProject] = useState<ProjectWithCount | null>(null)

  useEffect(() => {
    loadClients()
  }, [])

  async function loadClients(): Promise<void> {
    setIsLoading(true)
    const res = await window.api.clients.getAll()
    if (res.ok) setClients(res.data)
    setIsLoading(false)
  }

  const loadProjectsForClient = useCallback(async (clientId: number) => {
    const res = await window.api.projects.getAll({ clientId })
    if (res.ok) {
      setProjectsByClient((prev) => ({ ...prev, [clientId]: res.data as ProjectWithCount[] }))
    }
  }, [])

  async function toggleClientExpanded(clientId: number): Promise<void> {
    setExpandedClientIds((prev) => {
      const next = new Set(prev)
      if (next.has(clientId)) {
        next.delete(clientId)
      } else {
        next.add(clientId)
        loadProjectsForClient(clientId)
      }
      return next
    })
  }

  function openNew(): void {
    setEditingClient(null)
    setShowForm(true)
  }

  function openEdit(client: Client): void {
    setEditingClient(client)
    setShowForm(true)
  }

  async function handleDelete(client: Client): Promise<void> {
    setPendingDeleteClient(client)
  }

  async function doDeleteClient(): Promise<void> {
    if (!pendingDeleteClient) return
    await window.api.clients.delete(pendingDeleteClient.id)
    setPendingDeleteClient(null)
    await loadClients()
    bumpClientsVersion()
  }

  // Updates leave out the list copy of the rate: it may lag a due editor row,
  // and the main process would write it back (P6e, owner decision C).
  async function handleToggleActive({ rate_cent: _rate, ...client }: Client): Promise<void> {
    await window.api.clients.update({ ...client, active: client.active ? 0 : 1 })
    await loadClients()
    bumpClientsVersion()
  }

  async function handleSave(data: {
    name: string
    short_code: string | null
    color: string
    rate_cent?: number
    billing_address_line1: string | null
    billing_address_line2: string | null
    billing_address_line3: string | null
    billing_address_line4: string | null
    vat_id: string | null
    contact_person: string | null
    contact_email: string | null
  }): Promise<string | null> {
    if (editingClient) {
      const { rate_cent: _rate, ...client } = editingClient
      const input: UpdateClientInput = { ...client, ...data }
      const res = await window.api.clients.update(input)
      if (!res.ok) return res.error.replace(/^(?:Sqlite)?Error:\s*/, '')
    } else {
      const input: CreateClientInput = data
      const res = await window.api.clients.create(input)
      if (!res.ok) return res.error.replace(/^(?:Sqlite)?Error:\s*/, '')
    }
    await loadClients()
    bumpClientsVersion()
    setShowForm(false)
    setEditingClient(null)
    return null
  }

  function openNewProject(clientId: number): void {
    setEditingProject(null)
    setProjectFormClientId(clientId)
    setShowProjectForm(true)
  }

  function openEditProject(project: Project): void {
    setEditingProject(project)
    setProjectFormClientId(project.client_id)
    setShowProjectForm(true)
  }

  async function handleProjectSave(data: {
    name: string
    color: string
    rate_cent?: number | null
    external_project_number: string | null
    start_date: string | null
    end_date: string | null
    budget_minutes: number | null
    status: 'active' | 'paused' | 'archived'
    contact_person: string | null
  }): Promise<string | null> {
    if (!projectFormClientId && projectFormClientId !== 0) return null
    if (editingProject) {
      const { rate_cent: _rate, ...project } = editingProject
      const input: UpdateProjectInput = {
        ...project,
        ...data,
        client_id: projectFormClientId
      }
      const res = await window.api.projects.update(input)
      if (!res.ok) return res.error.replace(/^(?:Sqlite)?Error:\s*/, '')
    } else {
      const input: CreateProjectInput = { client_id: projectFormClientId, ...data }
      const res = await window.api.projects.create(input)
      if (!res.ok) return res.error.replace(/^(?:Sqlite)?Error:\s*/, '')
    }
    await loadProjectsForClient(projectFormClientId)
    bumpProjectsVersion()
    setShowProjectForm(false)
    setEditingProject(null)
    setProjectFormClientId(null)
    return null
  }

  async function handleProjectArchive(project: Project): Promise<void> {
    await window.api.projects.archive(project.id)
    if (project.client_id !== null) await loadProjectsForClient(project.client_id)
    bumpProjectsVersion()
  }

  async function handleProjectDelete(project: ProjectWithCount): Promise<void> {
    setPendingDeleteProject(project)
  }

  async function doDeleteProject(): Promise<void> {
    if (!pendingDeleteProject) return
    const res = await window.api.projects.delete(pendingDeleteProject.id)
    const clientId = pendingDeleteProject.client_id
    setPendingDeleteProject(null)
    if (!res.ok) return
    if (clientId !== null) await loadProjectsForClient(clientId)
    bumpProjectsVersion()
  }

  const activeClients = clients.filter((c) => c.active)
  const inactiveClients = clients.filter((c) => !c.active)

  return (
    <div className="w-full max-w-3xl">
      <div className="mb-8 flex items-center justify-between gap-4">
        <h1 className={VIEW_TITLE}>{t('clients.title')}</h1>
        <button onClick={openNew} className={KEY_INV}>
          <Icons.Plus />
          {t('clients.addNew')}
        </button>
      </div>

      {isLoading ? (
        <p className="text-[var(--ink3)] text-sm">{t('clients.loading')}</p>
      ) : (
        <>
          {clients.length === 0 && (
            <div className="text-center py-16 text-[var(--ink3)]">
              <p className="text-4xl mb-3">👤</p>
              <p className="font-medium">{t('clients.empty.title')}</p>
              <p className="text-sm mt-1">{t('clients.empty.hint')}</p>
            </div>
          )}

          {activeClients.length > 0 && (
            <ClientList
              clients={activeClients}
              expandedClientIds={expandedClientIds}
              projectsByClient={projectsByClient}
              onEdit={openEdit}
              onDelete={handleDelete}
              onToggleActive={handleToggleActive}
              onToggleExpand={toggleClientExpanded}
              onNewProject={openNewProject}
              onEditProject={openEditProject}
              onArchiveProject={handleProjectArchive}
              onDeleteProject={handleProjectDelete}
            />
          )}

          {inactiveClients.length > 0 && (
            <div className={`mt-12 ${SECTION}`}>
              <button
                onClick={() => setArchivedExpanded((v) => !v)}
                aria-expanded={archivedExpanded}
                className={`flex min-h-11 items-center gap-1.5 self-start hover:text-[var(--ink)] ${LEGEND} ${FOCUS}`}
              >
                <svg
                  aria-hidden="true"
                  className={`w-3 h-3 ${archivedExpanded ? 'rotate-90' : ''}`}
                  viewBox="0 0 12 12"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M4 2l4 4-4 4" />
                </svg>
                {t('clients.archivedSection', { count: inactiveClients.length })}
              </button>
              {archivedExpanded && (
                <ClientList
                  clients={inactiveClients}
                  expandedClientIds={expandedClientIds}
                  projectsByClient={projectsByClient}
                  onEdit={openEdit}
                  onDelete={handleDelete}
                  onToggleActive={handleToggleActive}
                  onToggleExpand={toggleClientExpanded}
                  onNewProject={openNewProject}
                  onEditProject={openEditProject}
                  onArchiveProject={handleProjectArchive}
                  onDeleteProject={handleProjectDelete}
                  dimmed
                />
              )}
            </div>
          )}
        </>
      )}

      {showForm && (
        <ClientFormModal
          client={editingClient}
          onBillingChanged={() => {
            void loadClients()
            bumpClientsVersion()
            // Inherited rules change the shown projects' budget use.
            if (editingClient && projectsByClient[editingClient.id]) {
              void loadProjectsForClient(editingClient.id)
              bumpProjectsVersion()
            }
          }}
          onSave={handleSave}
          onClose={() => {
            setShowForm(false)
            setEditingClient(null)
          }}
        />
      )}

      {showProjectForm && (
        <ProjectFormModal
          project={editingProject}
          onBillingChanged={() => {
            if (projectFormClientId !== null) void loadProjectsForClient(projectFormClientId)
            bumpProjectsVersion()
          }}
          clientColor={clients.find((c) => c.id === projectFormClientId)?.color ?? ''}
          onSave={handleProjectSave}
          onClose={() => {
            setShowProjectForm(false)
            setEditingProject(null)
            setProjectFormClientId(null)
          }}
        />
      )}

      <ConfirmDialog
        open={pendingDeleteClient !== null}
        variant="danger"
        title={t('clients.confirm.deleteTitle')}
        message={
          pendingDeleteClient ? t('clients.confirm.delete', { name: pendingDeleteClient.name }) : ''
        }
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        onConfirm={() => void doDeleteClient()}
        onCancel={() => setPendingDeleteClient(null)}
      />

      <ConfirmDialog
        open={pendingDeleteProject !== null}
        variant="danger"
        title={t('projects.confirm.deleteTitle')}
        message={
          pendingDeleteProject
            ? (pendingDeleteProject.entry_count ?? 0) > 0
              ? t('projects.confirm.deleteWithEntries', {
                  name: pendingDeleteProject.name,
                  count: String(pendingDeleteProject.entry_count)
                })
              : t('projects.confirm.delete', { name: pendingDeleteProject.name })
            : ''
        }
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        onConfirm={() => void doDeleteProject()}
        onCancel={() => setPendingDeleteProject(null)}
      />
    </div>
  )
}

function ClientList({
  clients,
  expandedClientIds,
  projectsByClient,
  onEdit,
  onDelete,
  onToggleActive,
  onToggleExpand,
  onNewProject,
  onEditProject,
  onArchiveProject,
  onDeleteProject,
  dimmed = false
}: {
  clients: Client[]
  expandedClientIds: Set<number>
  projectsByClient: Record<number, ProjectWithCount[]>
  onEdit: (c: Client) => void
  onDelete: (c: Client) => void
  onToggleActive: (c: Client) => void
  onToggleExpand: (clientId: number) => void
  onNewProject: (clientId: number) => void
  onEditProject: (p: Project) => void
  onArchiveProject: (p: Project) => void
  onDeleteProject: (p: ProjectWithCount) => void
  dimmed?: boolean
}): React.JSX.Element {
  return (
    // Section pattern (HANDOFF §2.3): rows separated by 1 px hairlines, no cards.
    <ul
      className={`flex flex-col border-b border-[var(--line)] ${dimmed ? 'border-t border-t-[var(--line)]' : 'border-t-2 border-t-[var(--ink)]'}`}
    >
      {clients.map((c) => (
        <ClientItem
          key={c.id}
          client={c}
          expanded={expandedClientIds.has(c.id)}
          projects={projectsByClient[c.id]}
          onEdit={onEdit}
          onDelete={onDelete}
          onToggleActive={onToggleActive}
          onToggleExpand={onToggleExpand}
          onNewProject={onNewProject}
          onEditProject={onEditProject}
          onArchiveProject={onArchiveProject}
          onDeleteProject={onDeleteProject}
          dimmed={dimmed}
        />
      ))}
    </ul>
  )
}

function ClientItem({
  client: c,
  expanded,
  projects,
  onEdit,
  onDelete,
  onToggleActive,
  onToggleExpand,
  onNewProject,
  onEditProject,
  onArchiveProject,
  onDeleteProject,
  dimmed = false
}: {
  client: Client
  expanded: boolean
  projects: ProjectWithCount[] | undefined
  onEdit: (c: Client) => void
  onDelete: (c: Client) => void
  onToggleActive: (c: Client) => void
  onToggleExpand: (clientId: number) => void
  onNewProject: (clientId: number) => void
  onEditProject: (p: Project) => void
  onArchiveProject: (p: Project) => void
  onDeleteProject: (p: ProjectWithCount) => void
  dimmed?: boolean
}): React.JSX.Element {
  const t = useT()
  const activeProjects =
    projects?.filter((p) => p.status === 'active' || (!p.status && p.active)) ?? []
  const pausedProjects = projects?.filter((p) => p.status === 'paused') ?? []
  const archivedProjects =
    projects?.filter((p) => p.status === 'archived' || (!p.status && !p.active)) ?? []
  const allProjects = projects ?? []

  return (
    <li className="border-t border-[var(--line)] first:border-t-0">
      {/* Client row */}
      <div
        className="flex min-h-14 items-center gap-3 py-1.5 hover:bg-[var(--key)]"
        style={c.contact_person ? { alignItems: 'flex-start' } : {}}
      >
        {/* Chevron toggle */}
        <button
          onClick={() => onToggleExpand(c.id)}
          aria-expanded={expanded}
          aria-label={t(expanded ? 'clients.projects.hide' : 'clients.projects.show')}
          className={ICON_BTN}
        >
          <svg
            className={`w-3.5 h-3.5 ${expanded ? 'rotate-90' : ''}`}
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M4 2l4 4-4 4" />
          </svg>
        </button>

        <span
          className={`h-3 w-3 shrink-0 ${dimmed ? 'opacity-40' : ''}`}
          style={{ backgroundColor: c.color }}
        />
        {/* Archived: --ink3 and a legend instead of a faded row, which fell
            below --ink3's contrast. */}
        <span className="flex-1 min-w-0">
          <span className="flex flex-wrap items-center gap-1.5">
            <span
              className="font-semibold"
              style={{ color: dimmed ? 'var(--ink3)' : 'var(--ink)' }}
            >
              {c.name}
            </span>
            {c.short_code && (
              <span className="font-num text-xs text-[var(--ink3)]">{c.short_code}</span>
            )}
            {dimmed && <span className={STATUS_TAG}>{t('clients.archived.label')}</span>}
          </span>
          {c.contact_person && (
            <span className="block text-xs" style={{ color: 'var(--ink3)' }}>
              {c.contact_person}
            </span>
          )}
        </span>
        {/* project count badge */}
        {allProjects.length > 0 && !expanded && (
          <span className="font-num rounded-[var(--r-fine)] border border-[var(--line)] px-1.5 py-0.5 text-xs text-[var(--ink3)]">
            {allProjects.length}
          </span>
        )}
        <button
          onClick={() => onToggleActive(c)}
          title={c.active ? t('clients.action.archive') : t('clients.action.reactivate')}
          aria-label={`${c.active ? t('clients.action.archive') : t('clients.action.reactivate')}: ${c.name}`}
          className={ICON_BTN}
        >
          {c.active ? <Icons.Archive /> : <Icons.Unarchive />}
        </button>
        {c.active && (
          <button
            onClick={() => onNewProject(c.id)}
            title={t('projects.addNew')}
            aria-label={`${t('projects.addNew')}: ${c.name}`}
            className={ICON_BTN}
          >
            <Icons.Plus />
          </button>
        )}
        <button
          onClick={() => onEdit(c)}
          className={ICON_BTN}
          aria-label={`${t('common.edit')}: ${c.name}`}
          title={t('common.edit')}
        >
          <Icons.Edit />
        </button>
        <button
          onClick={() => onDelete(c)}
          className={ICON_BTN}
          style={{ color: 'var(--danger)' }}
          aria-label={`${t('common.delete')}: ${c.name}`}
          title={t('common.delete')}
        >
          <Icons.Trash />
        </button>
      </div>

      {/* Project sub-list (collapsible) */}
      {expanded && (
        <div className="border-t border-[var(--line)] pt-1 pb-3 pl-14">
          {/* Active projects */}
          {activeProjects.length === 0 &&
            pausedProjects.length === 0 &&
            archivedProjects.length === 0 && (
              <p className="text-xs py-1" style={{ color: 'var(--ink3)' }}>
                {t('projects.empty')}
              </p>
            )}
          {activeProjects.length > 0 && (
            <ul className="mb-2 flex flex-col">
              {activeProjects.map((p) => (
                <ProjectItem
                  key={p.id}
                  project={p}
                  clientColor={c.color}
                  onEdit={onEditProject}
                  onArchive={onArchiveProject}
                  onDelete={onDeleteProject}
                />
              ))}
            </ul>
          )}
          {/* Paused projects */}
          {pausedProjects.length > 0 && (
            <div className="mb-2">
              <p className={`${FIELD_LABEL} mt-2 mb-1`}>
                {t('projects.pausedSection', { count: String(pausedProjects.length) })}
              </p>
              <ul className="flex flex-col">
                {pausedProjects.map((p) => (
                  <ProjectItem
                    key={p.id}
                    project={p}
                    clientColor={c.color}
                    onEdit={onEditProject}
                    onArchive={onArchiveProject}
                    onDelete={onDeleteProject}
                  />
                ))}
              </ul>
            </div>
          )}
          {/* Archived projects */}
          {archivedProjects.length > 0 && (
            <ArchivedProjectsSection
              projects={archivedProjects}
              clientColor={c.color}
              onEdit={onEditProject}
              onArchive={onArchiveProject}
              onDelete={onDeleteProject}
            />
          )}
          {/* Add project button */}
          {c.active && (
            <button onClick={() => onNewProject(c.id)} className={`${KEY} mt-2`}>
              <Icons.Plus />
              {t('projects.addNew')}
            </button>
          )}
        </div>
      )}
    </li>
  )
}

function ProjectItem({
  project: p,
  clientColor,
  onEdit,
  onArchive,
  onDelete
}: {
  project: ProjectWithCount
  clientColor: string
  onEdit: (p: Project) => void
  onArchive: (p: Project) => void
  onDelete: (p: ProjectWithCount) => void
}): React.JSX.Element {
  const t = useT()
  const { locale } = useLocale()
  const showProjectNumber = useUiPrefsStore((s) => s.showProjectNumber)
  const dotColor = p.color || (clientColor ? shiftColor(clientColor) : '')
  const archived = p.status === 'archived' || (!p.status && !p.active)
  const rateLabel =
    p.rate_cent === null
      ? t('projects.inheritedRate')
      : p.rate_cent === 0
        ? t('projects.goodwillRate')
        : formatRateInput(p.rate_cent) + ' €/h'

  const statsLabel = (() => {
    const count = p.entry_count ?? 0
    if (count === 0) return null
    const countStr = t(count === 1 ? 'projects.stats.entry' : 'projects.stats.entries', { count })
    if (!p.last_used_at) return countStr
    const rel = formatRelativeDate(p.last_used_at, locale)
    return `${countStr} · ${rel}`
  })()

  const hasBudget = (p.budget_minutes ?? 0) > 0
  const usedMin = p.used_minutes ?? 0
  const budgetMin = p.budget_minutes ?? 0
  const budgetPct = hasBudget ? Math.min(100, Math.round((usedMin / budgetMin) * 100)) : 0
  const overBudget = hasBudget && usedMin > budgetMin
  const budgetWarn = hasBudget && budgetPct >= 80

  return (
    <li className="group flex min-h-11 items-center gap-2.5 border-t border-[var(--line)] py-1 first:border-t-0 hover:bg-[var(--key)]">
      <span className="h-2 w-2 shrink-0 self-start mt-1.5" style={{ backgroundColor: dotColor }} />
      <span className="flex-1 min-w-0">
        <span className="flex items-center gap-1.5 flex-wrap">
          <span
            className="text-sm font-medium"
            style={{ color: archived ? 'var(--ink3)' : 'var(--ink)' }}
          >
            {p.name}
            {showProjectNumber && p.external_project_number ? (
              <span style={{ color: 'var(--ink3)' }}> [{p.external_project_number}]</span>
            ) : null}
          </span>
          {p.status === 'paused' && (
            <span className={STATUS_TAG}>{t('projects.form.statusPaused')}</span>
          )}
          {archived && <span className={STATUS_TAG}>{t('projects.form.statusArchived')}</span>}
        </span>
        {p.contact_person && (
          <span className="block text-xs mt-0.5" style={{ color: 'var(--ink3)' }}>
            {p.contact_person}
          </span>
        )}
        {statsLabel && (
          <span className="block text-xs mt-0.5" style={{ color: 'var(--ink3)' }}>
            {statsLabel}
          </span>
        )}
        {hasBudget && (
          <span className="flex items-center gap-1.5 mt-1">
            <span className="h-1 flex-1 overflow-hidden" style={{ background: 'var(--line)' }}>
              <span
                className="block h-full"
                style={{
                  width: `${budgetPct}%`,
                  // No hard-coded amber any more (tokens only): warn = full ink,
                  // normal = tick grey; the figures beside it carry the meaning.
                  background: overBudget
                    ? 'var(--danger)'
                    : budgetWarn
                      ? 'var(--ink)'
                      : 'var(--tick)'
                }}
              />
            </span>
            <span
              className="font-num shrink-0 text-xs"
              style={{
                color: overBudget ? 'var(--danger)' : budgetWarn ? 'var(--ink)' : 'var(--ink3)'
              }}
            >
              {(usedMin / 60).toFixed(1)}h / {(budgetMin / 60).toFixed(1)}h
            </span>
          </span>
        )}
      </span>
      <span className="flex flex-col items-end gap-0.5">
        <span className="font-num text-xs" style={{ color: 'var(--ink3)' }}>
          {rateLabel}
        </span>
        {p.end_date && (
          <span className="text-xs" style={{ color: 'var(--ink3)' }}>
            {t('projects.endsOn', {
              // A plain date: read as local midnight, not UTC.
              date: new Date(`${p.end_date.slice(0, 10)}T00:00:00`).toLocaleDateString(
                locale === 'en' ? 'en-GB' : 'de-DE',
                { day: '2-digit', month: '2-digit', year: 'numeric' }
              )
            })}
          </span>
        )}
      </span>
      <button
        onClick={() => onArchive(p)}
        title={p.active ? t('projects.action.archive') : t('projects.action.reactivate')}
        aria-label={`${p.active ? t('projects.action.archive') : t('projects.action.reactivate')}: ${p.name}`}
        className={`${ICON_BTN} opacity-0 group-hover:opacity-100 focus-visible:opacity-100`}
      >
        {p.active ? <Icons.Archive /> : <Icons.Unarchive />}
      </button>
      <button
        onClick={() => onEdit(p)}
        className={`${ICON_BTN} opacity-0 group-hover:opacity-100 focus-visible:opacity-100`}
        aria-label={`${t('common.edit')}: ${p.name}`}
        title={t('common.edit')}
      >
        <Icons.Edit />
      </button>
      <button
        onClick={() => onDelete(p)}
        className={`${ICON_BTN} opacity-0 group-hover:opacity-100 focus-visible:opacity-100`}
        style={{ color: 'var(--danger)' }}
        aria-label={`${t('common.delete')}: ${p.name}`}
        title={t('common.delete')}
      >
        <Icons.Trash />
      </button>
    </li>
  )
}

function ArchivedProjectsSection({
  projects,
  clientColor,
  onEdit,
  onArchive,
  onDelete
}: {
  projects: ProjectWithCount[]
  clientColor: string
  onEdit: (p: Project) => void
  onArchive: (p: Project) => void
  onDelete: (p: ProjectWithCount) => void
}): React.JSX.Element {
  const t = useT()
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="mt-1">
      <button
        onClick={() => setExpanded((v) => !v)}
        className={`flex min-h-11 items-center gap-1 text-xs hover:text-[var(--ink)] ${FOCUS}`}
        style={{ color: 'var(--ink3)' }}
      >
        <svg
          className={`w-3 h-3 ${expanded ? 'rotate-90' : ''}`}
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M4 2l4 4-4 4" />
        </svg>
        {t('projects.archivedSection', { count: String(projects.length) })}
      </button>
      {expanded && (
        <ul className="flex flex-col">
          {projects.map((p) => (
            <ProjectItem
              key={p.id}
              project={p}
              clientColor={clientColor}
              onEdit={onEdit}
              onArchive={onArchive}
              onDelete={onDelete}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

function ClientFormModal({
  client,
  onBillingChanged,
  onSave,
  onClose
}: {
  client: Client | null
  onBillingChanged: () => void
  onSave: (data: {
    name: string
    short_code: string | null
    color: string
    rate_cent?: number
    billing_address_line1: string | null
    billing_address_line2: string | null
    billing_address_line3: string | null
    billing_address_line4: string | null
    vat_id: string | null
    contact_person: string | null
    contact_email: string | null
  }) => Promise<string | null>
  onClose: () => void
}): React.JSX.Element {
  const t = useT()
  const [name, setName] = useState(client?.name ?? '')
  const [shortCode, setShortCode] = useState(client?.short_code ?? '')
  const [shortCodeError, setShortCodeError] = useState('')
  const [color, setColor] = useState(client?.color ?? CLIENT_COLORS[0])
  const [rateInput, setRateInput] = useState(() => formatRateInput(client?.rate_cent ?? 0))
  // The rate valid today; an update sends the field only when it differs.
  const [rateBase, setRateBase] = useState(client?.rate_cent ?? 0)
  const rateTouched = useRef(false)
  const [isSaving, setIsSaving] = useState(false)
  const [billingBusy, setBillingBusy] = useState(false)
  const [error, setError] = useState('')
  const [rateError, setRateError] = useState('')
  // v1.11 #94 — Stammdaten
  const [billingLine1, setBillingLine1] = useState(client?.billing_address_line1 ?? '')
  const [billingLine2, setBillingLine2] = useState(client?.billing_address_line2 ?? '')
  const [billingLine3, setBillingLine3] = useState(client?.billing_address_line3 ?? '')
  const [billingLine4, setBillingLine4] = useState(client?.billing_address_line4 ?? '')
  const [vatId, setVatId] = useState(client?.vat_id ?? '')
  const [contactPerson, setContactPerson] = useState(client?.contact_person ?? '')
  const [contactEmail, setContactEmail] = useState(client?.contact_email ?? '')
  const hasExistingDetails = !!(
    client?.billing_address_line1 ||
    client?.billing_address_line2 ||
    client?.billing_address_line3 ||
    client?.billing_address_line4 ||
    client?.vat_id ||
    client?.contact_person ||
    client?.contact_email
  )
  const [showDetails, setShowDetails] = useState(hasExistingDetails)

  function nullIfEmpty(v: string): string | null {
    return v.trim() === '' ? null : v.trim()
  }

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    if (billingBusy) return
    const trimmed = name.trim()
    if (!trimmed) {
      setError(t('clients.form.nameRequired'))
      return
    }
    const code = normaliseShortCodeInput(shortCode)
    if (code && !SHORT_CODE_PATTERN.test(code)) {
      setShortCodeError(t('clients.form.shortCodeInvalid'))
      return
    }
    const parsed = parseRateInput(rateInput)
    if (parsed === 'invalid') {
      setRateError(t('clients.form.rateInvalid'))
      return
    }
    if (parsed === 'negative') {
      setRateError(t('clients.form.rateNegative'))
      return
    }
    setIsSaving(true)
    try {
      const saveError = await onSave({
        name: trimmed,
        short_code: code,
        color,
        ...(client && parsed === rateBase ? {} : { rate_cent: parsed }),
        billing_address_line1: nullIfEmpty(billingLine1),
        billing_address_line2: nullIfEmpty(billingLine2),
        billing_address_line3: nullIfEmpty(billingLine3),
        billing_address_line4: nullIfEmpty(billingLine4),
        vat_id: nullIfEmpty(vatId),
        contact_person: nullIfEmpty(contactPerson),
        contact_email: nullIfEmpty(contactEmail)
      })
      if (saveError === SHORT_CODE_TAKEN_ERROR) setShortCodeError(t('clients.form.shortCodeTaken'))
      else if (saveError === SHORT_CODE_INVALID_ERROR)
        setShortCodeError(t('clients.form.shortCodeInvalid'))
      else if (saveError === RATE_EDITOR_CONFLICT_ERROR) setRateError(t('rates.conflict'))
      else if (saveError) setError(saveError)
    } catch {
      setError(t('clients.form.saveFailed'))
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={client ? t('clients.form.editTitle') : t('clients.form.createTitle')}
      widthClass="w-[640px]"
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {/* Name */}
        <div className="flex flex-col gap-1.5">
          <label className={FIELD_LABEL}>{t('clients.form.nameLabel')}</label>
          <input
            type="text"
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              setError('')
            }}
            placeholder={t('clients.form.namePlaceholder')}
            className={INPUT}
          />
          {error && (
            <p className="text-xs" style={{ color: 'var(--danger)' }}>
              {error}
            </p>
          )}
        </div>

        {/* Short code */}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="client-short-code" className={FIELD_LABEL}>
            {t('clients.form.shortCodeLabel')}
          </label>
          <input
            id="client-short-code"
            type="text"
            value={shortCode}
            maxLength={SHORT_CODE_MAX_LENGTH}
            onChange={(e) => {
              setShortCode(e.target.value.toUpperCase())
              setShortCodeError('')
            }}
            aria-invalid={!!shortCodeError}
            aria-describedby={`client-short-code-hint${shortCodeError ? ' client-short-code-error' : ''}`}
            className={`${INPUT} font-num`}
          />
          <p id="client-short-code-hint" className="text-xs text-[var(--ink3)]">
            {t('clients.form.shortCodeHint')}
          </p>
          {shortCodeError && (
            <p id="client-short-code-error" role="alert" className="text-xs text-[var(--danger)]">
              {shortCodeError}
            </p>
          )}
        </div>

        {/* Color */}
        <div className="flex flex-col gap-1.5">
          <label className={FIELD_LABEL}>{t('clients.form.colorLabel')}</label>
          <ColorSwatches
            value={color}
            onChange={setColor}
            groupLabel={t('clients.form.colorLabel')}
          />
        </div>

        {/* Hourly rate */}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="client-rate" className={FIELD_LABEL}>
            {t('clients.form.rateLabel')}
          </label>
          <div className="relative">
            <input
              id="client-rate"
              aria-invalid={!!rateError}
              aria-describedby="client-rate-hint client-rate-error"
              type="text"
              inputMode="decimal"
              value={rateInput}
              onChange={(e) => {
                rateTouched.current = true
                setRateInput(e.target.value)
                setRateError('')
              }}
              placeholder={t('clients.form.ratePlaceholder')}
              className={`${INPUT} w-full pr-10`}
            />
            <span
              className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm"
              style={{ color: 'var(--ink3)' }}
            >
              €
            </span>
          </div>
          {rateError && (
            <p
              id="client-rate-error"
              role="alert"
              className="text-xs"
              style={{ color: 'var(--danger)' }}
            >
              {rateError}
            </p>
          )}
          {!rateError && (
            <p className="text-xs" style={{ color: 'var(--ink3)' }}>
              {t('clients.form.rateHint')}
            </p>
          )}
        </div>

        <p id="client-rate-hint" className="text-xs text-[var(--ink3)]">
          {t('rates.fromToday')}
        </p>
        <BillingEditors
          target={client ? { kind: 'client', id: client.id } : null}
          disabled={isSaving}
          onBusyChange={setBillingBusy}
          onRateLoaded={(rate) => {
            setRateBase(rate ?? 0)
            if (!rateTouched.current) setRateInput(formatRateInput(rate ?? 0))
          }}
          onRateSaved={(rate) => {
            rateTouched.current = false
            setRateBase(rate ?? 0)
            setRateInput(formatRateInput(rate ?? 0))
            setRateError('')
          }}
          onChanged={onBillingChanged}
        />

        {/* Collapsible details toggle */}
        <button
          type="button"
          onClick={() => setShowDetails((v) => !v)}
          className={`flex min-h-11 w-full items-center gap-2 text-left ${FOCUS}`}
          style={{ color: 'var(--ink3)' }}
        >
          <hr className="flex-1" style={{ borderColor: 'var(--line)' }} />
          <span className={`${FIELD_LABEL} whitespace-nowrap`}>
            {t('clients.form.billingAddressLabel')}
          </span>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 16 16"
            fill="currentColor"
            className="w-3.5 h-3.5 shrink-0"
            style={{ transform: showDetails ? 'rotate(180deg)' : 'rotate(0deg)' }}
          >
            <path
              fillRule="evenodd"
              d="M4.22 6.22a.75.75 0 0 1 1.06 0L8 8.94l2.72-2.72a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.28a.75.75 0 0 1 0-1.06Z"
              clipRule="evenodd"
            />
          </svg>
          <hr className="flex-1" style={{ borderColor: 'var(--line)' }} />
        </button>

        {showDetails && (
          <>
            {/* Billing address */}
            <div className="flex flex-col gap-1.5">
              {[
                {
                  value: billingLine1,
                  set: setBillingLine1,
                  placeholder: t('clients.form.billingLine1Placeholder')
                },
                {
                  value: billingLine2,
                  set: setBillingLine2,
                  placeholder: t('clients.form.billingLine2Placeholder')
                },
                {
                  value: billingLine3,
                  set: setBillingLine3,
                  placeholder: t('clients.form.billingLine3Placeholder')
                },
                {
                  value: billingLine4,
                  set: setBillingLine4,
                  placeholder: t('clients.form.billingLine4Placeholder')
                }
              ].map(({ value, set, placeholder }, i) => (
                <input
                  key={i}
                  type="text"
                  value={value ?? ''}
                  onChange={(e) => set(e.target.value)}
                  placeholder={placeholder}
                  className={INPUT}
                />
              ))}
            </div>

            {/* VAT ID */}
            <div className="flex flex-col gap-1.5">
              <label className={FIELD_LABEL}>{t('clients.form.vatIdLabel')}</label>
              <input
                type="text"
                value={vatId ?? ''}
                onChange={(e) => setVatId(e.target.value)}
                placeholder={t('clients.form.vatIdPlaceholder')}
                className={INPUT}
              />
            </div>

            {/* Contact */}
            <div className="flex flex-col gap-1.5">
              <label className={FIELD_LABEL}>{t('clients.form.contactPersonLabel')}</label>
              <input
                type="text"
                value={contactPerson ?? ''}
                onChange={(e) => setContactPerson(e.target.value)}
                placeholder={t('clients.form.contactPersonPlaceholder')}
                className={INPUT}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className={FIELD_LABEL}>{t('clients.form.contactEmailLabel')}</label>
              <input
                type="email"
                value={contactEmail ?? ''}
                onChange={(e) => setContactEmail(e.target.value)}
                placeholder={t('clients.form.contactEmailPlaceholder')}
                className={INPUT}
              />
            </div>
          </>
        )}

        {/* Buttons */}
        <div className="flex gap-3 pt-1">
          <button type="button" onClick={onClose} className={`${KEY} flex-1`}>
            {t('common.cancel')}
          </button>
          <button type="submit" disabled={isSaving || billingBusy} className={`${KEY_INV} flex-1`}>
            {isSaving ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </form>
    </Dialog>
  )
}

function ProjectFormModal({
  project,
  onBillingChanged,
  clientColor,
  onSave,
  onClose
}: {
  project: Project | null
  onBillingChanged: () => void
  clientColor: string
  onSave: (data: {
    name: string
    color: string
    rate_cent?: number | null
    external_project_number: string | null
    start_date: string | null
    end_date: string | null
    budget_minutes: number | null
    status: 'active' | 'paused' | 'archived'
    contact_person: string | null
  }) => Promise<string | null>
  onClose: () => void
}): React.JSX.Element {
  const t = useT()
  const [name, setName] = useState(project?.name ?? '')
  const [color, setColor] = useState(() =>
    project ? project.color : clientColor ? shiftColor(clientColor) : ''
  )
  const [rateInput, setRateInput] = useState(() =>
    project?.rate_cent !== null && project?.rate_cent !== undefined
      ? formatRateInput(project.rate_cent)
      : ''
  )
  // As in the client form; null is the inherited client rate.
  const [rateBase, setRateBase] = useState(project?.rate_cent ?? null)
  const rateTouched = useRef(false)
  const showRate = (rate: number | null): void =>
    setRateInput(rate === null ? '' : formatRateInput(rate) || '0')
  const [isSaving, setIsSaving] = useState(false)
  const [billingBusy, setBillingBusy] = useState(false)
  const [error, setError] = useState('')
  const [rateError, setRateError] = useState('')
  // v1.11 #94 — Stammdaten
  const [status, setStatus] = useState<'active' | 'paused' | 'archived'>(
    (project?.status as 'active' | 'paused' | 'archived') ?? 'active'
  )
  const [externalNumber, setExternalNumber] = useState(project?.external_project_number ?? '')
  const [startDate, setStartDate] = useState(project?.start_date ?? '')
  const [endDate, setEndDate] = useState(project?.end_date ?? '')
  const [budgetInput, setBudgetInput] = useState(() => {
    if (project?.budget_minutes == null) return ''
    const hours = project.budget_minutes / 60
    return hours % 1 === 0 ? String(hours) : hours.toFixed(2)
  })
  // v1.12 #105
  const [contactPerson, setContactPerson] = useState(project?.contact_person ?? '')

  function nullIfEmpty(v: string): string | null {
    return v.trim() === '' ? null : v.trim()
  }

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    if (billingBusy) return
    const trimmed = name.trim()
    if (!trimmed) {
      setError(t('projects.form.nameRequired'))
      return
    }
    let rate_cent: number | null = null
    if (rateInput.trim() !== '') {
      const parsed = parseRateInput(rateInput)
      if (parsed === 'invalid') {
        setRateError(t('projects.form.rateInvalid'))
        return
      }
      if (parsed === 'negative') {
        setRateError(t('projects.form.rateNegative'))
        return
      }
      // An entered 0 is goodwill work billed at 0 €; only an empty field
      // inherits the client rate.
      rate_cent = parsed
    }
    let budget_minutes: number | null = null
    if (budgetInput.trim() !== '') {
      const hours = parseFloat(budgetInput.replace(',', '.'))
      if (!isFinite(hours) || hours <= 0) {
        // silently ignore invalid budget input — treat as no budget
      } else {
        budget_minutes = Math.round(hours * 60)
      }
    }
    setIsSaving(true)
    try {
      const saveError = await onSave({
        name: trimmed,
        color,
        ...(project && rate_cent === rateBase ? {} : { rate_cent }),
        external_project_number: nullIfEmpty(externalNumber),
        start_date: nullIfEmpty(startDate),
        end_date: nullIfEmpty(endDate),
        budget_minutes,
        status,
        contact_person: nullIfEmpty(contactPerson)
      })
      if (saveError === RATE_EDITOR_CONFLICT_ERROR) setRateError(t('rates.conflict'))
      else if (saveError) setError(saveError)
    } catch {
      setError(t('clients.form.saveFailed'))
    } finally {
      setIsSaving(false)
    }
  }

  const STATUS_OPTIONS: Array<{ value: 'active' | 'paused' | 'archived'; label: string }> = [
    { value: 'active', label: t('projects.form.statusActive') },
    { value: 'paused', label: t('projects.form.statusPaused') },
    { value: 'archived', label: t('projects.form.statusArchived') }
  ]

  return (
    <Dialog
      open
      onClose={onClose}
      title={project ? t('projects.form.editTitle') : t('projects.form.createTitle')}
      widthClass="w-[640px]"
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {/* Name */}
        <div className="flex flex-col gap-1.5">
          <label className={FIELD_LABEL}>{t('projects.form.nameLabel')}</label>
          <input
            type="text"
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              setError('')
            }}
            placeholder={t('projects.form.namePlaceholder')}
            className={INPUT}
          />
          {error && (
            <p className="text-xs" style={{ color: 'var(--danger)' }}>
              {error}
            </p>
          )}
        </div>

        {/* Color */}
        <div className="flex flex-col gap-1.5">
          <label className={FIELD_LABEL}>{t('projects.form.colorLabel')}</label>
          <ColorSwatches
            value={color}
            onChange={setColor}
            inheritLabel={t('projects.form.colorInherit')}
            groupLabel={t('projects.form.colorLabel')}
          />
          {color === '' && (
            <p className="text-xs" style={{ color: 'var(--ink3)' }}>
              {t('projects.form.colorInherit')}
            </p>
          )}
        </div>

        {/* Hourly rate override */}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="project-rate" className={FIELD_LABEL}>
            {t('projects.form.rateLabel')}
          </label>
          <div className="relative">
            <input
              id="project-rate"
              aria-invalid={!!rateError}
              aria-describedby="project-rate-hint project-rate-error"
              type="text"
              inputMode="decimal"
              value={rateInput}
              onChange={(e) => {
                rateTouched.current = true
                setRateInput(e.target.value)
                setRateError('')
              }}
              placeholder={t('projects.form.ratePlaceholder')}
              className={`${INPUT} w-full pr-10`}
            />
            <span
              className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm"
              style={{ color: 'var(--ink3)' }}
            >
              €
            </span>
          </div>
          {rateError && (
            <p
              id="project-rate-error"
              role="alert"
              className="text-xs"
              style={{ color: 'var(--danger)' }}
            >
              {rateError}
            </p>
          )}
          {!rateError && (
            <p className="text-xs" style={{ color: 'var(--ink3)' }}>
              {t('projects.form.rateHint')}
            </p>
          )}
        </div>

        <p id="project-rate-hint" className="text-xs text-[var(--ink3)]">
          {t('rates.fromToday')}
        </p>
        <BillingEditors
          target={project ? { kind: 'project', id: project.id } : null}
          disabled={isSaving}
          onBusyChange={setBillingBusy}
          onRateLoaded={(rate) => {
            setRateBase(rate)
            if (!rateTouched.current) showRate(rate)
          }}
          onRateSaved={(rate) => {
            rateTouched.current = false
            setRateBase(rate)
            showRate(rate)
            setRateError('')
          }}
          onChanged={onBillingChanged}
        />

        {/* Divider */}
        <hr style={{ borderColor: 'var(--line)' }} />

        {/* Status */}
        <div className="flex flex-col gap-1.5">
          <label className={FIELD_LABEL}>{t('projects.form.statusLabel')}</label>
          <div className="flex gap-[3px] rounded-[var(--r-key)] border border-[var(--key-edge)] bg-[var(--key)] p-[3px]">
            {STATUS_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setStatus(opt.value)}
                aria-pressed={status === opt.value}
                className={`h-9 flex-1 rounded-[var(--r-fine)] text-sm font-semibold ${FOCUS} ${
                  status === opt.value
                    ? 'bg-[var(--inv)] text-[var(--inv-ink)]'
                    : 'bg-transparent text-[var(--ink2)] hover:text-[var(--ink)]'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* External project number */}
        <div className="flex flex-col gap-1.5">
          <label className={FIELD_LABEL}>{t('projects.form.externalNumberLabel')}</label>
          <input
            type="text"
            value={externalNumber}
            onChange={(e) => setExternalNumber(e.target.value)}
            placeholder={t('projects.form.externalNumberPlaceholder')}
            className={INPUT}
          />
        </div>

        {/* Contact person */}
        <div className="flex flex-col gap-1.5">
          <label className={FIELD_LABEL}>{t('projects.form.contactPersonLabel')}</label>
          <input
            type="text"
            value={contactPerson}
            onChange={(e) => setContactPerson(e.target.value)}
            placeholder={t('projects.form.contactPersonPlaceholder')}
            className={INPUT}
          />
        </div>

        {/* Date range */}
        <div className="flex gap-3">
          <div className="flex flex-col gap-1.5 flex-1">
            <label className={FIELD_LABEL}>{t('projects.form.startDateLabel')}</label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className={INPUT}
            />
          </div>
          <div className="flex flex-col gap-1.5 flex-1">
            <label className={FIELD_LABEL}>{t('projects.form.endDateLabel')}</label>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className={INPUT}
            />
          </div>
        </div>

        {/* Budget */}
        <div className="flex flex-col gap-1.5">
          <label className={FIELD_LABEL}>{t('projects.form.budgetLabel')}</label>
          <input
            type="text"
            inputMode="decimal"
            value={budgetInput}
            onChange={(e) => setBudgetInput(e.target.value)}
            placeholder={t('projects.form.budgetPlaceholder')}
            className={INPUT}
          />
          <p className="text-xs" style={{ color: 'var(--ink3)' }}>
            {t('projects.form.budgetHint')}
          </p>
        </div>

        {/* Buttons */}
        <div className="flex gap-3 pt-1">
          <button type="button" onClick={onClose} className={`${KEY} flex-1`}>
            {t('common.cancel')}
          </button>
          <button type="submit" disabled={isSaving || billingBusy} className={`${KEY_INV} flex-1`}>
            {isSaving ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
