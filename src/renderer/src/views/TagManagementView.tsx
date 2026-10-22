import { useCallback, useEffect, useState } from 'react'
import { useT } from '../contexts/I18nContext'
import { ConfirmDialog } from '../components/ConfirmDialog'
import * as Icons from '../components/Icons'
import { useToastStore } from '../store/toastStore'
import { ICON_BTN, INPUT, KEY, LEGEND, SECTION } from '../components/instrumentClasses'

interface TagRow {
  name: string
  count: number
}

interface MergeConfirm {
  source: string
  target: string
  count: number
}

const inputClass = INPUT

const btnClass = KEY

export default function TagManagementView(): React.JSX.Element {
  const t = useT()
  const showToast = useToastStore((s) => s.show)

  const [tags, setTags] = useState<TagRow[]>([])
  const [loading, setLoading] = useState(true)

  // Create form
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)

  // Per-row rename state
  const [renamingTag, setRenamingTag] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  // Merge confirm
  const [mergeConfirm, setMergeConfirm] = useState<MergeConfirm | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    const res = await window.api.tags.getAllWithCount()
    if (res.ok) setTags(res.data)
    setLoading(false)
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- #142: dauerhaft — Laden beim Mount, kein dedizierter Store für Tags
    void reload()
  }, [reload])

  async function handleCreate(): Promise<void> {
    const trimmed = newName.trim()
    if (!trimmed) return
    setCreating(true)
    const res = await window.api.tags.create(trimmed)
    setCreating(false)
    if (!res.ok) {
      showToast(res.error)
    } else {
      setNewName('')
      void reload()
    }
  }

  function startRename(tag: string): void {
    setRenamingTag(tag)
    setRenameValue(tag)
  }

  async function commitRename(oldName: string): Promise<void> {
    const trimmed = renameValue.trim()
    if (!trimmed || trimmed === oldName) {
      setRenamingTag(null)
      return
    }
    const res = await window.api.tags.rename(oldName, trimmed)
    setRenamingTag(null)
    if (!res.ok) {
      showToast(res.error)
    } else {
      void reload()
    }
  }

  async function handleMergeSelect(source: string, target: string): Promise<void> {
    if (!target || target === source) return
    const row = tags.find((t) => t.name === source)
    setMergeConfirm({ source, target, count: row?.count ?? 0 })
  }

  async function confirmMerge(): Promise<void> {
    if (!mergeConfirm) return
    const { source, target } = mergeConfirm
    setMergeConfirm(null)
    const res = await window.api.tags.merge(source, target)
    if (!res.ok) {
      showToast(res.error)
    } else {
      void reload()
    }
  }

  async function handleDelete(name: string): Promise<void> {
    const res = await window.api.tags.delete(name)
    if (!res.ok) {
      showToast(res.error)
    } else {
      void reload()
    }
  }

  function entryLabel(count: number): string {
    if (count === 0) return t('settings.tags.noEntries')
    if (count === 1) return t('settings.tags.entry')
    return t('settings.tags.entries', { count: String(count) })
  }

  return (
    // Section pattern (HANDOFF §2.3): 2 px ink rule, legend, content.
    <section className={`${SECTION} gap-3`}>
      <h2 className={LEGEND}>{t('settings.tags.title')}</h2>

      {/* Create new tag */}
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void handleCreate()
        }}
        className="flex flex-wrap items-center gap-2"
      >
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder={t('settings.tags.newPlaceholder')}
          className={`${inputClass} min-w-0 flex-[1_1_12rem]`}
          maxLength={50}
          disabled={creating}
        />
        <button type="submit" disabled={creating || !newName.trim()} className={btnClass}>
          {t('settings.tags.add')}
        </button>
      </form>

      {/* Tag list */}
      <div className="flex flex-col border-b border-[var(--line)]">
        {loading && (
          <div className="px-4 py-8 text-center text-sm" style={{ color: 'var(--ink3)' }}>
            …
          </div>
        )}

        {!loading && tags.length === 0 && (
          <div className="px-4 py-8 text-center text-sm" style={{ color: 'var(--ink3)' }}>
            {t('settings.tags.empty')}
          </div>
        )}

        {!loading &&
          tags.map((tag, idx) => (
            <div
              key={tag.name}
              className="flex min-h-14 flex-wrap items-center gap-3 border-t py-1.5 hover:bg-[var(--key)]"
              style={{
                borderColor: idx === 0 ? 'transparent' : 'var(--line)'
              }}
            >
              {/* Tag chip */}
              <span
                className="font-num inline-flex items-center rounded-[var(--r-fine)] border px-2 py-0.5 text-xs font-medium"
                style={{
                  borderColor: 'var(--ink3)',
                  color: 'var(--ink)',
                  minWidth: 80
                }}
              >
                #{tag.name}
              </span>

              {/* Entry count */}
              <span className="font-num w-24 shrink-0 text-xs" style={{ color: 'var(--ink3)' }}>
                {entryLabel(tag.count)}
              </span>

              {/* Rename inline */}
              <div className="flex flex-1 items-center gap-2 min-w-0">
                {renamingTag === tag.name ? (
                  <>
                    <input
                      type="text"
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void commitRename(tag.name)
                        if (e.key === 'Escape') setRenamingTag(null)
                      }}
                      placeholder={t('settings.tags.renamePlaceholder')}
                      className={`${inputClass} flex-1`}
                      maxLength={50}
                      autoFocus
                    />
                    <button
                      type="button"
                      onClick={() => void commitRename(tag.name)}
                      disabled={!renameValue.trim() || renameValue.trim() === tag.name}
                      className={btnClass}
                    >
                      {t('settings.tags.renameConfirm')}
                    </button>
                    <button type="button" onClick={() => setRenamingTag(null)} className={btnClass}>
                      {t('settings.tags.renameCancel')}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => startRename(tag.name)}
                    className={ICON_BTN}
                    aria-label={t('settings.tags.rename')}
                    title={t('settings.tags.rename')}
                  >
                    <Icons.Edit />
                  </button>
                )}
              </div>

              {/* Merge select */}
              {renamingTag !== tag.name && (
                <select
                  className={`${inputClass} shrink-0`}
                  value=""
                  onChange={(e) => void handleMergeSelect(tag.name, e.target.value)}
                  title={t('settings.tags.mergeLabel')}
                >
                  <option value="">{t('settings.tags.mergeLabel')}</option>
                  {tags
                    .filter((other) => other.name !== tag.name)
                    .map((other) => (
                      <option key={other.name} value={other.name}>
                        {other.name}
                      </option>
                    ))}
                </select>
              )}

              {/* Delete */}
              {renamingTag !== tag.name && (
                <button
                  type="button"
                  disabled={tag.count > 0}
                  onClick={() => void handleDelete(tag.name)}
                  title={
                    tag.count > 0
                      ? t('settings.tags.deleteCannotHint', { count: String(tag.count) })
                      : t('settings.tags.deleteTitle')
                  }
                  className={ICON_BTN}
                  style={{ color: 'var(--danger)' }}
                  aria-label={t('settings.tags.delete')}
                >
                  <Icons.Trash />
                </button>
              )}
            </div>
          ))}
      </div>

      {/* Merge confirm dialog */}
      <ConfirmDialog
        open={mergeConfirm !== null}
        title={t('settings.tags.mergeConfirmTitle')}
        message={
          mergeConfirm
            ? t('settings.tags.mergeConfirmBody', {
                count: String(mergeConfirm.count),
                source: mergeConfirm.source,
                target: mergeConfirm.target
              })
            : ''
        }
        confirmLabel={t('settings.tags.mergeConfirmOk')}
        variant="primary"
        onConfirm={() => void confirmMerge()}
        onCancel={() => setMergeConfirm(null)}
      />
    </section>
  )
}
