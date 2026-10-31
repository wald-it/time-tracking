import type { RendererSettingKey } from '../../../shared/settingKeys'
import { useEffect, useId, useRef, useState } from 'react'
import type { Settings, BackupInfo } from '../../../shared/types'
import { useUpdateStore } from '../store/updateStore'
import { useT, useLocale } from '../contexts/I18nContext'
import type { Locale } from '../../../shared/i18n'
import { AboutDialog } from '../components/AboutDialog'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { useTheme, type ThemeMode } from '../contexts/ThemeContext'
import { useRounding } from '../contexts/RoundingContext'
import { Toggle } from '../components/Toggle'
import { ToggleHintContext, ToggleLabelContext } from '../components/toggleLabelContext'
import { useUiPrefsStore } from '../store/uiPrefsStore'
import TagManagementView from './TagManagementView'
import { GraphAccountSection } from '../components/GraphAccountSection'
import { IcalFeedSection } from '../components/IcalFeedSection'
import {
  FIELD_LABEL,
  FOCUS,
  INPUT,
  INPUT_FRAME,
  KEY,
  KEY_INV,
  LEGEND,
  READOUT,
  READOUT_FRAME,
  SECTION,
  TEXTAREA
} from '../components/instrumentClasses'
import {
  WEBHOOK_EVENTS,
  isValidWebhookUrl,
  newWebhookTargetId,
  parseWebhookTargets,
  serializeWebhookTargets,
  type WebhookEvent,
  type WebhookTarget
} from '../../../shared/webhooks'
import { isUpdateCheckEnabled } from '../../../shared/updateCheck'
import { useFeedbackRules } from './settings/useFeedbackRules'
import {
  DESCRIPTION_FIELD_LIMIT,
  isValidRuleCheck,
  parseRuleCheck
} from '../../../shared/ruleCheck'

const DEFAULT_HOTKEY = 'Alt+Shift+S'
const DEFAULT_MINI_HOTKEY = 'Alt+Shift+M'

type SettingsTab = 'general' | 'timer' | 'export' | 'data' | 'tags' | 'integrations' | 'about'

/** Settings keys that hold a global accelerator string. */
type HotkeyKey = 'hotkey_toggle' | 'mini_hotkey'

function parseAccelerator(e: KeyboardEvent): string | null {
  // Need at least one modifier and a non-modifier key.
  const mods: string[] = []
  if (e.ctrlKey) mods.push('Ctrl')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  if (e.metaKey) mods.push('Super')
  if (mods.length === 0) return null

  const k = e.key
  if (k === 'Control' || k === 'Alt' || k === 'Shift' || k === 'Meta') return null
  // Single letter / digit / function key.
  let key: string
  if (k.length === 1) {
    key = k.toUpperCase()
  } else if (/^F\d{1,2}$/.test(k)) {
    key = k
  } else {
    return null
  }
  return [...mods, key].join('+')
}

export default function SettingsView(): React.JSX.Element {
  const t = useT()
  const { locale, setLocale } = useLocale()
  const { themeMode, setThemeMode } = useTheme()
  const { setRoundMinutes } = useRounding()
  const [settings, setSettings] = useState<Settings | null>(null)
  const [paths, setPaths] = useState<{
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
  } | null>(null)
  const [version, setVersion] = useState<string>('')
  const [backups, setBackups] = useState<BackupInfo[]>([])
  const [backupPathInfo, setBackupPathInfo] = useState<{
    dir: string
    isCustom: boolean
    isReachable: boolean
  } | null>(null)
  const [selectedRestoreFile, setSelectedRestoreFile] = useState<string>('')
  const [showRestoreConfirm, setShowRestoreConfirm] = useState(false)
  const [capturingHotkey, setCapturingHotkey] = useState<HotkeyKey | null>(null)
  const [hotkeyError, setHotkeyError] = useState<string | null>(null)
  const [statusMsg, setStatusMsg] = useState<string | null>(null)
  const [showAbout, setShowAbout] = useState(false)
  const [tab, setTab] = useState<SettingsTab>('general')

  async function loadAll(): Promise<void> {
    const [s, p, v, b, pi] = await Promise.all([
      window.api.settings.getAll(),
      window.api.paths.get(),
      window.api.app.getVersion(),
      window.api.backups.list(),
      window.api.backups.getPathInfo()
    ])
    if (s.ok) setSettings(s.data)
    if (p.ok) setPaths(p.data)
    if (v.ok) setVersion(v.data)
    if (b.ok) {
      setBackups(b.data)
      if (b.data.length > 0) setSelectedRestoreFile(b.data[0].filename)
    }
    if (pi.ok) setBackupPathInfo(pi.data)
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- #142: dauerhaft — fünf asynchrone Quellen beim Mount
    loadAll()
  }, [])

  // Capture next key combo for hotkey change.
  useEffect(() => {
    if (!capturingHotkey) return
    const targetKey = capturingHotkey
    // Pause registered global shortcuts while we capture, otherwise pressing
    // an already-bound combo (e.g. Alt+Shift+S) fires its handler instead of
    // reaching this listener.
    window.api.hotkeyCapture.begin()
    const handler = async (e: KeyboardEvent): Promise<void> => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setCapturingHotkey(null)
        setHotkeyError(null)
        return
      }
      const accel = parseAccelerator(e)
      if (!accel) return // wait for valid combo
      const res = await window.api.settings.set(targetKey, accel)
      if (res.ok) {
        setSettings((prev) => (prev ? { ...prev, [targetKey]: accel } : prev))
        setHotkeyError(null)
        setCapturingHotkey(null)
      } else {
        setHotkeyError(res.error)
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => {
      window.removeEventListener('keydown', handler, true)
      // Re-register the previously-bound shortcuts. Safe to call even if
      // the capture succeeded — settings:set will have already re-registered
      // the new accelerator via its hook side-effect, and resume only
      // re-binds whatever the main process currently has stored.
      window.api.hotkeyCapture.end()
    }
  }, [capturingHotkey])

  async function update<K extends RendererSettingKey>(key: K, value: Settings[K]): Promise<void> {
    if (!settings) return
    setSettings({ ...settings, [key]: value })
    const res = await window.api.settings.set(key, String(value))
    if (!res.ok) {
      // A declined native confirmation (#272) needs no message of its own.
      if (res.code !== 'cancelled') setStatusMsg(t('common.error', { error: res.error }))
      // revert by reloading
      await loadAll()
    }
  }

  async function createBackupNow(): Promise<void> {
    setStatusMsg(t('settings.data.backupCreating'))
    const res = await window.api.backups.create()
    if (res.ok) {
      setStatusMsg(t('settings.data.backupCreated'))
      const list = await window.api.backups.list()
      if (list.ok) {
        setBackups(list.data)
        if (list.data.length > 0 && !selectedRestoreFile) {
          setSelectedRestoreFile(list.data[0].filename)
        }
      }
    } else {
      setStatusMsg(t('common.error', { error: res.error }))
    }
  }

  async function changeBackupPath(): Promise<void> {
    setStatusMsg(t('settings.data.backupPathChanging'))
    const res = await window.api.backups.setPath()
    if (!res.ok) {
      setStatusMsg(t('common.error', { error: res.error }))
      return
    }
    if (res.data === '') {
      // User cancelled the folder dialog
      setStatusMsg(null)
      return
    }
    setStatusMsg(t('settings.data.backupPathChanged'))
    await loadAll()
  }

  async function resetBackupPath(): Promise<void> {
    const res = await window.api.backups.resetPath()
    if (res.ok) {
      setStatusMsg(t('settings.data.backupPathReset'))
      await loadAll()
    } else {
      setStatusMsg(t('common.error', { error: res.error }))
    }
  }

  async function restoreFromBackup(): Promise<void> {
    if (!selectedRestoreFile) return
    setShowRestoreConfirm(false)
    setStatusMsg(t('settings.data.restoring'))
    const res = await window.api.backups.restore(selectedRestoreFile)
    if (!res.ok) {
      // A failure after the snapshot leaves the DB closed in the main process,
      // so relaunch unconditionally; the main process has already shown the
      // reason as a native dialog.
      setStatusMsg(t('common.error', { error: res.error }))
    }
    await window.api.app.relaunch()
  }

  async function exportJson(): Promise<void> {
    setStatusMsg(t('settings.data.jsonExporting'))
    const res = await window.api.exporter.json()
    if (res.ok) {
      const kb = (res.data.bytes / 1024).toFixed(1)
      setStatusMsg(t('settings.data.jsonExportSaved', { kb }))
    } else if (res.code === 'cancelled') {
      setStatusMsg(null)
    } else {
      setStatusMsg(t('settings.data.jsonExportFailed', { error: res.error }))
    }
  }

  async function pickLogo(): Promise<void> {
    setStatusMsg(t('settings.pdf.logoPicking'))
    const res = await window.api.logo.set()
    if (res.ok) {
      setSettings((prev) => (prev ? { ...prev, pdf_logo_path: res.data.path } : prev))
      setStatusMsg(t('settings.pdf.logoSaved'))
    } else if (res.code === 'cancelled') {
      setStatusMsg(null)
    } else {
      setStatusMsg(t('settings.pdf.logoError', { error: res.error }))
    }
  }

  async function clearLogo(): Promise<void> {
    const res = await window.api.logo.clear()
    if (res.ok) {
      setSettings((prev) => (prev ? { ...prev, pdf_logo_path: '' } : prev))
      setStatusMsg(t('settings.pdf.logoRemoved'))
    } else {
      setStatusMsg(`${t('settings.update.idle')}: ${res.error}`)
    }
  }

  if (!settings || !paths) {
    return <div style={{ color: 'var(--ink2)' }}>{t('settings.loading')}</div>
  }

  const latestBackup = backups[0] ?? null

  const NAV_ITEMS: { id: SettingsTab; label: string }[] = [
    { id: 'general', label: t('settings.nav.general') },
    { id: 'timer', label: t('settings.nav.timer') },
    { id: 'export', label: t('settings.nav.export') },
    { id: 'data', label: t('settings.nav.data') },
    { id: 'tags', label: t('settings.nav.tags') },
    { id: 'integrations', label: t('settings.nav.integrations') },
    { id: 'about', label: t('settings.nav.about') }
  ]

  // Ready-to-paste Claude Code registration, resolved by the main process.
  // The server runs on the app's own Electron binary in Node mode, so the
  // native-module ABI always matches — no system Node, no rebuild.
  const mcpConfigSnippet = JSON.stringify(
    {
      mcpServers: {
        timetrack: {
          command: paths.mcp.command,
          args: paths.mcp.args,
          env: paths.mcp.env
        }
      }
    },
    null,
    2
  )

  async function copyMcpConfig(): Promise<void> {
    try {
      await navigator.clipboard.writeText(mcpConfigSnippet)
      setStatusMsg(t('settings.mcp.copied'))
    } catch (e) {
      setStatusMsg(t('common.error', { error: String(e) }))
    }
  }

  return (
    <div className="flex w-full min-w-0 flex-row gap-8 pb-12">
      {/* Sidebar navigation */}
      <nav className="flex w-44 shrink-0 flex-col gap-1">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => {
              setTab(item.id)
              setStatusMsg(null)
            }}
            className={`flex min-h-11 w-full items-center rounded-[var(--r-key)] px-4 text-left text-sm ${FOCUS} ${
              tab === item.id
                ? 'bg-[var(--inv)] font-semibold text-[var(--inv-ink)]'
                : 'font-medium text-[var(--ink2)] hover:bg-[var(--key)] hover:text-[var(--ink)]'
            }`}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {/* Content */}
      <div className="flex min-w-0 flex-1 flex-col gap-10">
        {statusMsg && (
          <div className="rounded-[var(--r-key)] border border-[var(--line)] px-3 py-2 text-sm text-[var(--ink)]">
            {statusMsg}
          </div>
        )}

        {/* Allgemein */}
        {tab === 'general' && (
          <Section title={t('settings.section.general')}>
            <Row label={t('settings.theme.title')}>
              <SegmentedPicker
                options={[
                  { value: 'light' as ThemeMode, label: t('settings.theme.light') },
                  { value: 'dark' as ThemeMode, label: t('settings.theme.dark') },
                  { value: 'system' as ThemeMode, label: t('settings.theme.system') }
                ]}
                value={themeMode}
                onChange={setThemeMode}
              />
            </Row>
            <Row label={t('settings.language.title')}>
              <select
                aria-label={t('settings.language.title')}
                value={locale}
                onChange={(e) => void setLocale(e.target.value as Locale)}
                className={inputClass}
              >
                <option value="de">{t('settings.language.de')}</option>
                <option value="en">{t('settings.language.en')}</option>
              </select>
            </Row>
            <Row label={t('settings.general.weekStart')} hint={t('settings.general.weekStartHint')}>
              <SegmentedPicker
                options={[
                  { value: 'monday', label: t('settings.general.weekStartMonday') },
                  { value: 'sunday', label: t('settings.general.weekStartSunday') }
                ]}
                value={settings.week_start === 'sunday' ? 'sunday' : 'monday'}
                onChange={(v) => void update('week_start', v)}
              />
            </Row>
            <Row label={t('settings.general.onboarding')}>
              <button
                type="button"
                onClick={async () => {
                  await window.api.settings.set('onboarding_completed', '0')
                  setStatusMsg(t('settings.general.onboardingReset'))
                }}
                className={btnSecondaryClass}
              >
                {t('settings.onboarding.retrigger')}
              </button>
            </Row>
            <Row
              label={t('settings.general.autoStart')}
              hint={t('settings.general.autoStartLabel')}
            >
              <Toggle
                checked={settings.auto_start === '1'}
                onChange={(v) => update('auto_start', v ? '1' : '0')}
              />
            </Row>
            <Row
              label={t('settings.general.showProjectNumber')}
              hint={t('settings.general.showProjectNumberHint')}
            >
              <Toggle
                checked={settings.show_project_number === '1'}
                onChange={(v) => {
                  void update('show_project_number', v ? '1' : '0')
                  useUiPrefsStore.getState().setShowProjectNumber(v)
                }}
              />
            </Row>
            <Row label={t('settings.general.company')}>
              <input
                type="text"
                value={settings.company_name}
                onChange={(e) => update('company_name', e.target.value)}
                className={inputClass}
                placeholder={t('settings.general.companyPlaceholder')}
              />
            </Row>
          </Section>
        )}

        {/* Timer & Hotkeys */}
        {tab === 'timer' && (
          <>
            <Section title={t('settings.section.timer')}>
              <Row label={t('settings.timer.idle')} hint={t('settings.timer.idleHint')}>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    aria-label={t('settings.timer.idleAria')}
                    type="number"
                    min={1}
                    max={60}
                    value={settings.idle_threshold_minutes}
                    onChange={(e) => update('idle_threshold_minutes', e.target.value)}
                    className={`${inputClass} w-24`}
                  />
                  <span className="text-sm" style={{ color: 'var(--ink2)' }}>
                    {t('settings.timer.idleUnit')}
                  </span>
                </div>
              </Row>
              <Row label={t('settings.timer.hotkey')} hint={t('settings.timer.hotkeyHint')}>
                <div className="flex flex-wrap items-center gap-2">
                  <code className={`${READOUT_FRAME} text-[13px] text-[var(--ink)]`}>
                    {capturingHotkey === 'hotkey_toggle'
                      ? t('settings.timer.hotkeyCapturing')
                      : settings.hotkey_toggle}
                  </code>
                  <button
                    type="button"
                    onClick={() => {
                      setCapturingHotkey((v) => (v === 'hotkey_toggle' ? null : 'hotkey_toggle'))
                      setHotkeyError(null)
                    }}
                    className={btnSecondaryClass}
                  >
                    {capturingHotkey === 'hotkey_toggle'
                      ? t('common.cancel')
                      : t('settings.timer.hotkeyChange')}
                  </button>
                  {settings.hotkey_toggle !== DEFAULT_HOTKEY && (
                    <button
                      type="button"
                      onClick={() => update('hotkey_toggle', DEFAULT_HOTKEY)}
                      className={btnSecondaryClass}
                    >
                      {t('settings.timer.hotkeyReset')}
                    </button>
                  )}
                </div>
                {hotkeyError && capturingHotkey === 'hotkey_toggle' && (
                  <p className="mt-1 text-xs text-[var(--danger)]">{hotkeyError}</p>
                )}
              </Row>
            </Section>

            {/* Mini-Widget (v1.4) */}
            <Section title={t('settings.section.miniWidget')}>
              <Row label={t('settings.mini.enable')} hint={t('settings.mini.enableHint')}>
                <Toggle
                  checked={settings.mini_enabled === '1'}
                  onChange={(v) => update('mini_enabled', v ? '1' : '0')}
                />
              </Row>
              <Row label={t('settings.mini.hotkey')} hint={t('settings.mini.hotkeyHint')}>
                <div className="flex flex-wrap items-center gap-2">
                  <code className={`${READOUT_FRAME} text-[13px] text-[var(--ink)]`}>
                    {capturingHotkey === 'mini_hotkey'
                      ? t('settings.timer.hotkeyCapturing')
                      : settings.mini_hotkey}
                  </code>
                  <button
                    type="button"
                    onClick={() => {
                      setCapturingHotkey((v) => (v === 'mini_hotkey' ? null : 'mini_hotkey'))
                      setHotkeyError(null)
                    }}
                    className={btnSecondaryClass}
                  >
                    {capturingHotkey === 'mini_hotkey'
                      ? t('common.cancel')
                      : t('settings.timer.hotkeyChange')}
                  </button>
                  {settings.mini_hotkey !== DEFAULT_MINI_HOTKEY && (
                    <button
                      type="button"
                      onClick={() => update('mini_hotkey', DEFAULT_MINI_HOTKEY)}
                      className={btnSecondaryClass}
                    >
                      {t('settings.timer.hotkeyReset')}
                    </button>
                  )}
                </div>
                {hotkeyError && capturingHotkey === 'mini_hotkey' && (
                  <p className="mt-1 text-xs text-[var(--danger)]">{hotkeyError}</p>
                )}
              </Row>
              <Row label={t('settings.mini.position')} hint={t('settings.mini.positionHint')}>
                <button
                  type="button"
                  onClick={async () => {
                    await window.api.settings.set('mini_x', '-1')
                    await window.api.settings.set('mini_y', '-1')
                    setSettings((prev) => (prev ? { ...prev, mini_x: '-1', mini_y: '-1' } : prev))
                    setStatusMsg(t('settings.mini.positionResetDone'))
                  }}
                  className={btnSecondaryClass}
                >
                  {t('settings.mini.positionReset')}
                </button>
              </Row>
            </Section>
          </>
        )}

        {/* PDF & Export */}
        {tab === 'export' && (
          <Section title={t('settings.section.pdf')}>
            <Row label={t('settings.pdf.logo')} hint={t('settings.pdf.logoHint')} stacked>
              <div className="flex flex-wrap items-center gap-3">
                {settings.pdf_logo_path ? (
                  <code className={`${READOUT} min-w-0 flex-[1_1_12rem] truncate`}>
                    {settings.pdf_logo_path}
                  </code>
                ) : (
                  <span className="flex-1 text-sm" style={{ color: 'var(--ink3)' }}>
                    {t('settings.pdf.noLogo')}
                  </span>
                )}
                <button type="button" onClick={pickLogo} className={btnSecondaryClass}>
                  {t('settings.pdf.chooseLogo')}
                </button>
                {settings.pdf_logo_path && (
                  <button type="button" onClick={clearLogo} className={btnSecondaryClass}>
                    {t('settings.pdf.removeLogo')}
                  </button>
                )}
              </div>
            </Row>
            <Row label={t('settings.pdf.sender')} hint={t('settings.pdf.senderHint')} stacked>
              <textarea
                rows={4}
                value={settings.pdf_sender_address}
                onChange={(e) => update('pdf_sender_address', e.target.value)}
                placeholder={'Robin GmbH\nMusterstr. 1\n12345 Berlin'}
                className={`${TEXTAREA} w-full resize-y`}
              />
            </Row>
            <Row label={t('settings.pdf.taxId')}>
              <input
                type="text"
                value={settings.pdf_tax_id}
                onChange={(e) => update('pdf_tax_id', e.target.value)}
                placeholder="DE123456789"
                className={inputClass}
              />
            </Row>
            <Row label={t('settings.pdf.accentColor')} hint={t('settings.pdf.accentColorHint')}>
              <div className="flex flex-wrap items-center gap-3">
                <input
                  type="color"
                  value={
                    /^#[0-9a-fA-F]{6}$/.test(settings.pdf_accent_color)
                      ? settings.pdf_accent_color
                      : '#4f46e5'
                  }
                  onChange={(e) => update('pdf_accent_color', e.target.value)}
                  className={`h-11 w-16 cursor-pointer rounded-[var(--r-key)] border border-[var(--key-edge)] bg-[var(--key)] p-1 ${FOCUS}`}
                  aria-label={t('settings.pdf.accentColorAria')}
                />
                <code className={READOUT}>{settings.pdf_accent_color || '#4f46e5'}</code>
              </div>
            </Row>
            <Row label={t('settings.pdf.footer')} hint={t('settings.pdf.footerHint')} stacked>
              <textarea
                rows={3}
                value={settings.pdf_footer_text}
                onChange={(e) => update('pdf_footer_text', e.target.value)}
                placeholder="Bitte überweisen Sie bis zum 15. des Folgemonats."
                className={`${TEXTAREA} w-full resize-y`}
              />
            </Row>
            <Row label={t('settings.pdf.roundMinutes')} hint={t('settings.pdf.roundMinutesHint')}>
              <SegmentedPicker
                options={[
                  { value: '0', label: t('settings.pdf.roundNone') },
                  { value: '5', label: '5 min' },
                  { value: '10', label: '10 min' },
                  { value: '15', label: '15 min' },
                  { value: '30', label: '30 min' }
                ]}
                value={settings.pdf_round_minutes || '0'}
                onChange={(v) => {
                  void update('pdf_round_minutes', v)
                  void setRoundMinutes(parseInt(v, 10) || 0)
                }}
              />
            </Row>
          </Section>
        )}

        {tab === 'export' && (
          <FeedbackRulesSection
            raw={settings.feedback_rules}
            onChange={(raw) => void update('feedback_rules', raw)}
          />
        )}

        {tab === 'export' && (
          <RuleCheckSection
            raw={settings.rule_check}
            onChange={(raw) => void update('rule_check', raw)}
          />
        )}

        {/* Daten */}
        {tab === 'data' && (
          <>
            <Section title={t('settings.section.data')}>
              <Row label={t('settings.data.database')} stacked>
                <div className="flex flex-wrap items-center gap-2">
                  <code className={`${READOUT} min-w-0 flex-[1_1_12rem] truncate`}>{paths.db}</code>
                  <button
                    type="button"
                    onClick={() => window.api.shell.showItemInFolder(paths.db)}
                    className={btnSecondaryClass}
                  >
                    {t('settings.data.openInExplorer')}
                  </button>
                </div>
              </Row>

              {/* T2: Offline-Warnung */}
              {backupPathInfo?.isCustom && !backupPathInfo.isReachable && (
                <div className="my-3 rounded-[var(--r-key)] border border-[var(--danger)] px-3 py-2 text-sm text-[var(--ink)]">
                  ⚠️ {t('settings.data.backupPathUnreachable')}
                </div>
              )}

              <Row
                label={t('settings.data.backupPath')}
                hint={t('settings.data.backupPathHint')}
                stacked
              >
                <div className="flex flex-wrap items-center gap-2">
                  <code className={`${READOUT} min-w-0 flex-[1_1_12rem] truncate`}>
                    {backupPathInfo?.dir ?? paths.backups}
                  </code>
                  <button
                    type="button"
                    onClick={() => window.api.shell.openPath(backupPathInfo?.dir ?? paths.backups)}
                    className={btnSecondaryClass}
                  >
                    {t('settings.data.open')}
                  </button>
                  <button
                    type="button"
                    onClick={() => void changeBackupPath()}
                    className={btnSecondaryClass}
                  >
                    {t('settings.data.changeBackupPath')}
                  </button>
                  {backupPathInfo?.isCustom && (
                    <button
                      type="button"
                      onClick={() => void resetBackupPath()}
                      className={btnSecondaryClass}
                    >
                      {t('settings.data.resetBackupPath')}
                    </button>
                  )}
                </div>
              </Row>

              <Row
                label={t('settings.data.lastBackup')}
                hint={
                  latestBackup
                    ? `${new Date(latestBackup.createdAt).toLocaleString('de-DE')} (${latestBackup.reason})${backups.length > 1 ? ` · ${backups.length} Backups` : ''}`
                    : t('settings.data.noBackup')
                }
              >
                <button type="button" onClick={createBackupNow} className={btnSecondaryClass}>
                  {t('settings.data.createBackup')}
                </button>
              </Row>

              <Row
                label={t('settings.data.restoreBackup')}
                hint={t('settings.data.restoreBackupHint')}
                stacked
              >
                {backups.length === 0 ? (
                  <p className="text-sm" style={{ color: 'var(--ink3)' }}>
                    {t('settings.data.noBackupToRestore')}
                  </p>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      aria-label={t('settings.data.restoreBackup')}
                      value={selectedRestoreFile}
                      onChange={(e) => setSelectedRestoreFile(e.target.value)}
                      className={`${INPUT_FRAME} font-num min-w-0 flex-1 text-xs`}
                    >
                      {backups.map((b) => (
                        <option key={b.filename} value={b.filename}>
                          {new Date(b.createdAt).toLocaleString('de-DE')} · {b.reason} ·{' '}
                          {(b.sizeBytes / 1024).toFixed(0)} KB
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => setShowRestoreConfirm(true)}
                      className={btnSecondaryClass}
                      disabled={!selectedRestoreFile}
                    >
                      {t('settings.data.restoreBtn')}
                    </button>
                  </div>
                )}
              </Row>

              <ConfirmDialog
                open={showRestoreConfirm}
                title={t('settings.data.restoreConfirmTitle')}
                message={t('settings.data.restoreConfirmBody')}
                confirmLabel={t('settings.data.restoreConfirmOk')}
                variant="danger"
                onConfirm={() => void restoreFromBackup()}
                onCancel={() => setShowRestoreConfirm(false)}
              />

              <Row
                label={t('settings.data.jsonExport')}
                hint={`${t('settings.data.jsonExportDesc')} — ${t('settings.data.jsonExportHint')}`}
              >
                <button type="button" onClick={exportJson} className={btnSecondaryClass}>
                  {t('settings.data.jsonExportBtn')}
                </button>
              </Row>
            </Section>

            {/* Diagnose (v1.5 PR A, issue #34) */}
            <Section title={t('settings.diagnose.title')}>
              <Row label="Log-Datei" hint={t('settings.diagnose.hint')} stacked>
                <div className="flex flex-wrap items-center gap-2">
                  <code className={`${READOUT} min-w-0 flex-[1_1_12rem] truncate`}>
                    {paths.logFile}
                  </code>
                  <button
                    type="button"
                    onClick={() => window.api.shell.showItemInFolder(paths.logFile)}
                    className={btnSecondaryClass}
                  >
                    {t('settings.diagnose.reveal')}
                  </button>
                  <button
                    type="button"
                    onClick={() => window.api.shell.openPath(paths.logs)}
                    className={btnSecondaryClass}
                  >
                    {t('settings.diagnose.open')}
                  </button>
                </div>
                <p className="mt-1 text-xs" style={{ color: 'var(--ink3)' }}>
                  Rotiert automatisch bei 5 MB. Enthält App-Ereignisse und Fehler aus Main- und
                  Renderer-Process.
                </p>
              </Row>
            </Section>
          </>
        )}

        {/* Über */}
        {tab === 'about' && (
          <>
            {/* Updates (v1.5 PR B, issue #28) */}
            <UpdatesSection
              autoCheck={isUpdateCheckEnabled(settings.update_check_enabled)}
              onAutoCheckChange={(v) => void update('update_check_enabled', v ? '1' : '0')}
            />

            <Section title={t('settings.section.about')}>
              <Row label={t('settings.about.version')}>
                <span className="font-num text-sm" style={{ color: 'var(--ink)' }}>
                  {version || '—'}
                </span>
              </Row>
              <Row label={t('about.open')}>
                <button
                  type="button"
                  onClick={() => setShowAbout(true)}
                  className={btnSecondaryClass}
                >
                  {t('about.open')}
                </button>
              </Row>
            </Section>
          </>
        )}

        {/* Tags */}
        {tab === 'tags' && <TagManagementView />}

        {/* Integrationen — Microsoft-Konto (#130) + MCP (v1.14 #128) */}
        {tab === 'integrations' && (
          <>
            <Section title={t('settings.graph.section')}>
              <GraphAccountSection />
            </Section>

            <Section title={t('settings.mcp.section')}>
              <Row label={t('settings.mcp.section')} hint={t('settings.mcp.desc')} stacked>
                <span
                  className={`inline-flex w-fit items-center rounded-[var(--r-fine)] border border-[var(--ink3)] px-2 py-0.5 ${FIELD_LABEL}`}
                >
                  {t('settings.mcp.readonlyBadge')}
                </span>
              </Row>
              <Row label={t('settings.mcp.dbPath')} stacked>
                <div className="flex flex-wrap items-center gap-2">
                  <code className={`${READOUT} min-w-0 flex-[1_1_12rem] truncate`}>{paths.db}</code>
                  <button
                    type="button"
                    onClick={() => window.api.shell.showItemInFolder(paths.db)}
                    className={btnSecondaryClass}
                  >
                    {t('settings.data.openInExplorer')}
                  </button>
                </div>
              </Row>
              <Row
                label={t('settings.mcp.registration')}
                hint={t('settings.mcp.registrationHint')}
                stacked
              >
                <div className="flex flex-col gap-2">
                  {!paths.mcp.available && (
                    <p className="text-xs text-[var(--ink)]">{t('settings.mcp.unavailable')}</p>
                  )}
                  <pre className={`${READOUT} overflow-x-auto`}>{mcpConfigSnippet}</pre>
                  <button
                    type="button"
                    onClick={() => void copyMcpConfig()}
                    className={`${btnSecondaryClass} w-fit`}
                  >
                    {t('settings.mcp.copy')}
                  </button>
                </div>
              </Row>
            </Section>

            <Section title={t('settings.mcp.privacyTitle')}>
              <Row label={t('settings.mcp.exposeRates')} hint={t('settings.mcp.exposeRatesHint')}>
                <Toggle
                  checked={settings.mcp_expose_rates === '1'}
                  onChange={(v) => void update('mcp_expose_rates', v ? '1' : '0')}
                />
              </Row>
              <Row
                label={t('settings.mcp.exposePrivateNotes')}
                hint={t('settings.mcp.exposePrivateNotesHint')}
              >
                <Toggle
                  checked={settings.mcp_expose_private_notes === '1'}
                  onChange={(v) => void update('mcp_expose_private_notes', v ? '1' : '0')}
                />
              </Row>
            </Section>

            <Section title={t('settings.mcp.writeTitle')}>
              <Row label={t('settings.mcp.writeEnable')} hint={t('settings.mcp.writeEnableHint')}>
                <Toggle
                  checked={settings.mcp_write_enabled === '1'}
                  onChange={(v) => void update('mcp_write_enabled', v ? '1' : '0')}
                />
              </Row>
              {settings.mcp_write_enabled === '1' && (
                <>
                  <Row
                    label={t('settings.mcp.confirmMode')}
                    hint={
                      settings.mcp_write_confirm_mode === 'session'
                        ? t('settings.mcp.confirmSessionHint')
                        : t('settings.mcp.confirmModeHint')
                    }
                  >
                    <select
                      aria-label={t('settings.mcp.confirmMode')}
                      value={settings.mcp_write_confirm_mode ?? 'per-write'}
                      onChange={(e) => void update('mcp_write_confirm_mode', e.target.value)}
                      className={inputClass}
                    >
                      <option value="per-write">{t('settings.mcp.confirmPerWrite')}</option>
                      <option value="session">{t('settings.mcp.confirmSession')}</option>
                      <option value="silent">{t('settings.mcp.confirmSilent')}</option>
                    </select>
                  </Row>
                  <Row label={t('settings.mcp.auditLog')} hint={t('settings.mcp.auditLogHint')}>
                    <button
                      type="button"
                      onClick={() => window.api.shell.openPath(paths.logs)}
                      className={btnSecondaryClass}
                    >
                      {t('settings.mcp.openAuditLog')}
                    </button>
                  </Row>
                </>
              )}
            </Section>

            {/* Hardware keys (v1.17 #133) — controller scope of the local bridge */}
            <Section title={t('settings.controller.title')}>
              <Row
                label={t('settings.controller.enable')}
                hint={t('settings.controller.enableHint')}
              >
                <Toggle
                  checked={settings.controller_enabled === '1'}
                  onChange={(v) => void update('controller_enabled', v ? '1' : '0')}
                />
              </Row>
              {/* #192: the switch alone does nothing until the plugin is
                  installed, and nothing in the app said where it comes from.
                  The release ships an installable .streamDeckPlugin. */}
              <Row
                label={t('settings.controller.plugin')}
                hint={t('settings.controller.pluginHint')}
              >
                <button
                  type="button"
                  onClick={() =>
                    void window.api.shell.openExternal(
                      'https://github.com/wald-it/time-tracking/releases/latest'
                    )
                  }
                  className={btnSecondaryClass}
                >
                  {t('settings.controller.pluginButton')}
                </button>
              </Row>
            </Section>

            {/* Subscribable iCal feed (v1.17 #169) */}
            <Section title={t('settings.icalFeed.title')}>
              <IcalFeedSection
                enabled={settings.ical_feed_enabled === '1'}
                port={settings.ical_feed_port ?? ''}
                onEnabledChange={(v) => void update('ical_feed_enabled', v ? '1' : '0')}
                onPortChange={(v) => void update('ical_feed_port', v)}
              />
            </Section>

            {/* Outbound-Webhooks (v1.15 #134) — own contiguous block below MCP */}
            <WebhooksSection initialRaw={settings.webhook_targets} logsPath={paths.logs} />
          </>
        )}

        <AboutDialog open={showAbout} onClose={() => setShowAbout(false)} version={version} />
      </div>
    </div>
  )
}

const inputClass = `${INPUT} w-full`

const btnSecondaryClass = KEY

function FeedbackRulesSection({
  raw,
  onChange
}: {
  raw: string | undefined
  onChange: (raw: string) => void
}): React.JSX.Element {
  const t = useT()
  const { fields, change, names, namesError } = useFeedbackRules(raw, onChange)
  return (
    <Section title={t('settings.feedback.title')}>
      <Row label={t('settings.feedback.prefixes')} hint={t('settings.feedback.prefixesHint')}>
        <input
          type="text"
          aria-label={t('settings.feedback.prefixes')}
          value={fields.prefixes}
          onChange={(e) => change('prefixes', e.target.value)}
          className={inputClass}
        />
      </Row>
      <Row label={t('settings.feedback.separator')} hint={t('settings.feedback.separatorHint')}>
        <input
          type="text"
          aria-label={t('settings.feedback.separator')}
          value={fields.separator}
          onChange={(e) => change('separator', e.target.value)}
          className={`${INPUT} w-20`}
        />
      </Row>
      <Row label={t('settings.feedback.forbidden')} hint={t('settings.feedback.forbiddenHint')}>
        <input
          type="text"
          aria-label={t('settings.feedback.forbidden')}
          value={fields.forbidden}
          onChange={(e) => change('forbidden', e.target.value)}
          className={inputClass}
        />
      </Row>
      <div className="py-3 text-sm text-[var(--ink2)]">
        <p>{t('settings.feedback.namesHint')}</p>
        {namesError ? (
          <p role="alert">{t('common.error', { error: namesError })}</p>
        ) : (
          <ul aria-label={t('settings.feedback.names')} className="mt-2 space-y-1">
            {names.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  )
}

function RuleCheckSection({
  raw,
  onChange
}: {
  raw: string | undefined
  onChange: (raw: string) => void
}): React.JSX.Element {
  const t = useT()
  const fromRaw = (value: string | undefined): Record<string, string | boolean> => {
    const rules = parseRuleCheck(value)
    return Object.fromEntries(
      Object.entries(rules).map(([key, field]) => [
        key,
        typeof field === 'number' ? String(field) : field
      ])
    )
  }
  const [draft, setDraft] = useState(() => ({ raw, fields: fromRaw(raw) }))
  const fields = draft.raw === raw ? draft.fields : fromRaw(raw)
  const parsed = (next: typeof fields): ReturnType<typeof parseRuleCheck> => ({
    entryMaxHours: Number(next.entryMaxHours),
    dayMaxHours: Number(next.dayMaxHours),
    windowStart: String(next.windowStart),
    windowEnd: String(next.windowEnd),
    weekend: next.weekend === true,
    maxDescriptionLength: Number(next.maxDescriptionLength)
  })
  const valid = isValidRuleCheck(parsed(fields))
  function change(key: string, value: string | boolean): void {
    const next = { ...fields, [key]: value }
    const rules = parsed(next)
    if (!isValidRuleCheck(rules)) {
      setDraft({ raw, fields: next })
      return
    }
    const serialized = JSON.stringify(rules)
    setDraft({ raw: serialized, fields: next })
    onChange(serialized)
  }
  return (
    <Section title={t('settings.ruleCheck.title')}>
      <p className="py-3 text-sm text-[var(--ink2)]">{t('settings.ruleCheck.hint')}</p>
      {(
        [
          'entryMaxHours',
          'dayMaxHours',
          'windowStart',
          'windowEnd',
          'maxDescriptionLength'
        ] as const
      ).map((key) => (
        <Row
          key={key}
          label={t(`settings.ruleCheck.${key}`)}
          hint={
            key === 'dayMaxHours'
              ? t('settings.ruleCheck.dayHint')
              : key === 'maxDescriptionLength'
                ? t('settings.ruleCheck.maxDescriptionHint')
                : undefined
          }
        >
          <input
            type={key.startsWith('window') ? 'time' : 'number'}
            step={key === 'maxDescriptionLength' ? '1' : key.startsWith('window') ? '60' : 'any'}
            min={key === 'maxDescriptionLength' ? '1' : undefined}
            max={key === 'maxDescriptionLength' ? DESCRIPTION_FIELD_LIMIT : undefined}
            aria-label={t(`settings.ruleCheck.${key}`)}
            value={String(fields[key])}
            onChange={(e) => change(key, e.target.value)}
            className={inputClass}
          />
        </Row>
      ))}
      <Row label={t('settings.ruleCheck.weekend')}>
        <Toggle checked={fields.weekend === true} onChange={(value) => change('weekend', value)} />
      </Row>
      {!valid && (
        <p role="alert" className="py-3 text-sm">
          {t('settings.ruleCheck.invalid')}
        </p>
      )}
    </Section>
  )
}

function Section({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className={SECTION}>
      <h2 className={`${LEGEND} pb-1`}>{title}</h2>
      <div className="flex flex-col [&>*:last-child]:border-b-0">{children}</div>
    </section>
  )
}

function Row({
  label,
  hint,
  children,
  stacked
}: {
  label: string
  hint?: string
  children: React.ReactNode
  stacked?: boolean
}): React.JSX.Element {
  // Names and describes a switch in this row (Toggle reads both from context, §8).
  const labelId = useId()
  const hintId = useId()
  return (
    <div
      className={`flex ${stacked ? 'flex-col gap-2.5' : 'items-center justify-between gap-4'} border-b border-[var(--line)] py-3`}
    >
      <div
        className="flex min-w-0 max-w-[40rem] flex-col gap-0.5 [overflow-wrap:anywhere]"
        style={{ flex: stacked ? undefined : '1 1 0%' }}
      >
        <span id={labelId} className="text-sm font-medium" style={{ color: 'var(--ink)' }}>
          {label}
        </span>
        {hint && (
          <span id={hintId} className="text-xs" style={{ color: 'var(--ink3)' }}>
            {hint}
          </span>
        )}
      </div>
      <div
        className={
          stacked
            ? 'w-full min-w-0 max-w-[40rem]'
            : 'flex min-w-0 max-w-[28rem] flex-[0_1_50%] flex-col items-end [&>*]:max-w-full [&>input]:w-full'
        }
      >
        <ToggleLabelContext.Provider value={labelId}>
          <ToggleHintContext.Provider value={hint ? hintId : undefined}>
            {children}
          </ToggleHintContext.Provider>
        </ToggleLabelContext.Provider>
      </div>
    </div>
  )
}

/**
 * Outbound-webhooks configuration (v1.15 #134). Self-contained: holds its own
 * copy of the target list (parsed from the `webhook_targets` settings blob) and
 * persists every change via `settings.set`, mirroring the local-state pattern
 * of the surrounding SettingsView rather than the global settings store.
 *
 * An in-progress target with an empty/invalid URL is kept in the editor but is
 * dropped by `parseWebhookTargets` on the delivery side, so it never fires.
 */
export function WebhooksSection({
  initialRaw,
  logsPath
}: {
  initialRaw: string | undefined
  logsPath: string
}): React.JSX.Element {
  const t = useT()
  const [targets, setTargets] = useState<WebhookTarget[]>(() => parseWebhookTargets(initialRaw))

  const eventLabels: Record<WebhookEvent, string> = {
    'timer.started': t('settings.webhooks.event.timerStarted'),
    'timer.stopped': t('settings.webhooks.event.timerStopped'),
    'entry.created': t('settings.webhooks.event.entryCreated'),
    'entry.updated': t('settings.webhooks.event.entryUpdated')
  }

  const [saveError, setSaveError] = useState<string | null>(null)

  // Saves run one after another. A new address asks natively first (#272),
  // so a save can be declined while later edits wait behind it; those were
  // built on the declined list and may themselves be confirmed. Once the
  // queue has drained after any declined or failed save, the list is read
  // back from what is stored, so the editor never shows something else.
  const saving = useRef<Promise<void>>(Promise.resolve())
  const pendingSaves = useRef(0)
  const saveFailed = useRef(false)

  function persist(next: WebhookTarget[]): Promise<void> {
    const before = targets
    setTargets(next)
    setSaveError(null)
    pendingSaves.current++
    const run = saving.current
      .then(async () => {
        const res = await window.api.settings.set('webhook_targets', serializeWebhookTargets(next))
        if (!res.ok) {
          saveFailed.current = true
          // Only a failure needs a message, not a declined confirmation.
          if (res.code !== 'cancelled') setSaveError(t('common.error', { error: res.error }))
        }
      })
      .finally(async () => {
        pendingSaves.current--
        if (pendingSaves.current > 0 || !saveFailed.current) return
        saveFailed.current = false
        const stored = await window.api.settings.getAll()
        // An edit made while this read was pending is newer than what it
        // returned: leave its state and reconcile again once that save drains.
        if (pendingSaves.current > 0) {
          saveFailed.current = true
          return
        }
        setTargets(stored.ok ? parseWebhookTargets(stored.data.webhook_targets) : before)
      })
    saving.current = run.catch(() => undefined)
    return run
  }

  // The address is saved when the field is left, not per keystroke: a new
  // address asks for confirmation, and that must happen once, for the whole URL.
  const [urlDrafts, setUrlDrafts] = useState<Record<string, string>>({})
  function commitUrl(id: string): void {
    const draft = urlDrafts[id]
    setUrlDrafts((d) => {
      const rest = { ...d }
      delete rest[id]
      return rest
    })
    const current = targets.find((tg) => tg.id === id)
    if (draft !== undefined && current && draft !== current.url) patch(id, { url: draft })
  }

  function patch(id: string, fields: Partial<WebhookTarget>): void {
    void persist(targets.map((tg) => (tg.id === id ? { ...tg, ...fields } : tg)))
  }

  function toggleEvent(tg: WebhookTarget, ev: WebhookEvent, on: boolean): void {
    const events = on ? [...tg.events, ev] : tg.events.filter((e) => e !== ev)
    patch(tg.id, { events })
  }

  function addTarget(): void {
    void persist([
      ...targets,
      { id: newWebhookTargetId(), url: '', secret: '', events: [...WEBHOOK_EVENTS], enabled: true }
    ])
  }

  function removeTarget(id: string): void {
    setUrlDrafts((d) => {
      const rest = { ...d }
      delete rest[id]
      return rest
    })
    void persist(targets.filter((tg) => tg.id !== id))
  }

  return (
    <Section title={t('settings.webhooks.section')}>
      <Row label={t('settings.webhooks.section')} hint={t('settings.webhooks.desc')} stacked>
        <div className="flex flex-col gap-4">
          {targets.length === 0 && (
            <p className="text-xs" style={{ color: 'var(--ink3)' }}>
              {t('settings.webhooks.empty')}
            </p>
          )}
          {saveError && (
            <p role="alert" className="text-xs text-[var(--danger)]">
              {saveError}
            </p>
          )}
          {targets.map((tg, i) => {
            const shownUrl = urlDrafts[tg.id] ?? tg.url
            const urlInvalid = shownUrl !== '' && !isValidWebhookUrl(shownUrl)
            return (
              <div key={tg.id} className="flex flex-col gap-2.5 border-t border-[var(--line)] pt-3">
                <div className="flex items-center justify-between">
                  <span className={LEGEND}>{t('settings.webhooks.target', { n: i + 1 })}</span>
                  <div className="flex flex-wrap items-center gap-3">
                    <label
                      className="flex items-center gap-1.5 text-xs"
                      style={{ color: 'var(--ink2)' }}
                    >
                      <span id={`webhook-enabled-${tg.id}`}>{t('settings.webhooks.enabled')}</span>
                      <Toggle
                        checked={tg.enabled}
                        onChange={(v) => patch(tg.id, { enabled: v })}
                        labelledBy={`webhook-enabled-${tg.id}`}
                      />
                    </label>
                    <button
                      type="button"
                      // Keep the focus in the address field: its blur would save
                      // (and ask about) the address the user is removing.
                      onMouseDown={(e) => e.preventDefault()}
                      data-webhook-remove={tg.id}
                      onClick={() => removeTarget(tg.id)}
                      className={btnSecondaryClass}
                    >
                      {t('settings.webhooks.remove')}
                    </button>
                  </div>
                </div>

                <label className="flex flex-col gap-1 text-xs" style={{ color: 'var(--ink3)' }}>
                  {t('settings.webhooks.url')}
                  <input
                    type="url"
                    value={urlDrafts[tg.id] ?? tg.url}
                    placeholder="https://…"
                    onChange={(e) => {
                      const v = e.target.value
                      setUrlDrafts((d) => ({ ...d, [tg.id]: v }))
                    }}
                    onBlur={(e) => {
                      // Focus moving to this target's Remove (Shift+Tab) must
                      // not save the address that is about to go. The draft
                      // is dropped, so the field shows what is stored and
                      // nothing unsaved looks saved.
                      const to = e.relatedTarget as HTMLElement | null
                      if (to?.dataset.webhookRemove === tg.id) {
                        setUrlDrafts((d) => {
                          const rest = { ...d }
                          delete rest[tg.id]
                          return rest
                        })
                        return
                      }
                      commitUrl(tg.id)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur()
                    }}
                    className={inputClass}
                  />
                  {urlInvalid && (
                    <span className="text-xs text-[var(--ink)]">
                      {t('settings.webhooks.urlInvalid')}
                    </span>
                  )}
                </label>

                <label className="flex flex-col gap-1 text-xs" style={{ color: 'var(--ink3)' }}>
                  {t('settings.webhooks.secret')}
                  <input
                    type="password"
                    value={tg.secret}
                    autoComplete="off"
                    onChange={(e) => patch(tg.id, { secret: e.target.value })}
                    className={inputClass}
                  />
                  <span className="text-xs" style={{ color: 'var(--ink3)' }}>
                    {t('settings.webhooks.secretHint')}
                  </span>
                </label>

                <div className="flex flex-col gap-1.5 text-xs" style={{ color: 'var(--ink3)' }}>
                  {t('settings.webhooks.events')}
                  <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                    {WEBHOOK_EVENTS.map((ev) => (
                      <label
                        key={ev}
                        className="flex items-center gap-1.5 text-sm"
                        style={{ color: 'var(--ink)' }}
                      >
                        <input
                          type="checkbox"
                          className={`h-4 w-4 accent-[var(--ink)] ${FOCUS}`}
                          checked={tg.events.includes(ev)}
                          onChange={(e) => toggleEvent(tg, ev, e.target.checked)}
                        />
                        {eventLabels[ev]}
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            )
          })}

          <button type="button" onClick={addTarget} className={`${btnSecondaryClass} w-fit`}>
            {t('settings.webhooks.addTarget')}
          </button>
        </div>
      </Row>
      <Row label={t('settings.webhooks.deliveryLog')} hint={t('settings.webhooks.deliveryLogHint')}>
        <button
          type="button"
          onClick={() => window.api.shell.openPath(logsPath)}
          className={btnSecondaryClass}
        >
          {t('settings.webhooks.openLog')}
        </button>
      </Row>
    </Section>
  )
}

function SegmentedPicker<T extends string>({
  options,
  value,
  onChange
}: {
  options: { value: T; label: string }[]
  value: T
  onChange: (v: T) => void
}): React.JSX.Element {
  return (
    // Segmented control (HANDOFF §3.5): one --key well, the active segment inverse.
    <div className="flex flex-wrap gap-[3px] rounded-[var(--r-key)] border border-[var(--key-edge)] bg-[var(--key)] p-[3px]">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          aria-pressed={value === opt.value}
          className={`h-9 cursor-pointer rounded-[var(--r-fine)] px-3 text-xs font-semibold ${FOCUS} ${
            value === opt.value
              ? 'bg-[var(--inv)] text-[var(--inv-ink)]'
              : 'bg-transparent text-[var(--ink2)] hover:text-[var(--ink)]'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

/**
 * v1.5 PR B — Updates section. Reads + drives state from useUpdateStore.
 * The store auto-initializes on first mount via UpdateBanner; we still call
 * `init()` here defensively in case Settings is opened before the banner
 * has appeared in some future layout change.
 *
 * The automatic-check switch (#273) is a settings row like the others, so
 * its value and writer come from SettingsView; the store only mirrors the
 * main-process updater.
 */
export function UpdatesSection({
  autoCheck,
  onAutoCheckChange
}: {
  autoCheck: boolean
  onAutoCheckChange: (v: boolean) => void
}): React.JSX.Element {
  const { status, lastCheckedAt, checkNow, installNow, init } = useUpdateStore()
  const t = useT()
  useEffect(() => {
    void init()
  }, [init])

  const busy = status.status === 'checking' || status.status === 'downloading'
  const lastCheckedLabel = lastCheckedAt
    ? new Date(lastCheckedAt).toLocaleString('de-DE')
    : t('settings.update.never')

  let statusLabel = ''
  switch (status.status) {
    case 'idle':
      statusLabel = t('settings.update.idle')
      break
    case 'checking':
      statusLabel = t('settings.update.checking')
      break
    case 'available':
      statusLabel = t('update.available', { version: status.version ?? '' })
      break
    case 'downloading':
      statusLabel = t('update.downloading', {
        version: status.version ?? '…',
        progress: status.progress ?? 0
      })
      break
    case 'ready':
      statusLabel = t('update.ready.text', { version: status.version ?? '' })
      break
    case 'not-available':
      statusLabel = t('settings.update.upToDate')
      break
    case 'error':
      statusLabel = t('update.error.text', { message: status.message ?? '' })
      break
  }

  return (
    <Section title={t('settings.update.title')}>
      <Row
        label={t('settings.update.status')}
        hint={`${t('settings.update.lastCheck')}: ${lastCheckedLabel}`}
      >
        <p className={`text-sm ${status.status === 'error' ? 'text-[var(--ink)]' : ''}`}>
          {statusLabel}
        </p>
      </Row>
      <Row label={t('settings.update.autoCheck')} hint={t('settings.update.autoCheckHint')}>
        <Toggle checked={autoCheck} onChange={onAutoCheckChange} />
      </Row>
      <Row label={t('settings.update.actions')} hint={t('settings.update.autoInfo')}>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void checkNow()}
            disabled={busy}
            className={btnSecondaryClass}
          >
            {t('settings.update.checkNow')}
          </button>
          {status.status === 'ready' && (
            <button type="button" onClick={() => void installNow()} className={KEY_INV}>
              {t('update.ready.install')}
            </button>
          )}
        </div>
      </Row>
    </Section>
  )
}
