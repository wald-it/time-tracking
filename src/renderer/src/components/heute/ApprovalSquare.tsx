import { useEffect, useState } from 'react'
import type { McpApprovalState } from '../../../../shared/types'
import { useNow } from '../../contexts/NowContext'
import { useT } from '../../contexts/I18nContext'

/**
 * Q16b (#409): a static `--sig` square while an MCP write approval is open or
 * silent mode is on. Kept out of AppHeader so the rounding guard's allowlist
 * entry covers only this countdown, not the header's running-time readout.
 */
export function ApprovalSquare(): React.JSX.Element | null {
  const t = useT()
  const now = useNow()
  const [approval, setApproval] = useState<McpApprovalState>({ state: 'off' })
  const [receivedAt, setReceivedAt] = useState(() => Date.now())
  useEffect(() => {
    let disposed = false
    let pushed = false
    const remove = window.api.mcpApproval.onChanged((state) => {
      pushed = true
      if (!disposed) {
        setReceivedAt(Date.now())
        setApproval(state)
      }
    })
    void window.api.mcpApproval
      .get()
      .then((result) => {
        if (!disposed && !pushed && result.ok) {
          setReceivedAt(Date.now())
          setApproval(result.data)
        }
      })
      .catch(() => {
        /* A later push can still supply the state. */
      })
    return () => {
      disposed = true
      remove()
    }
  }, [])
  // Hide at the deadline even if a main-process expiry event is delayed.
  useEffect(() => {
    if (approval.state !== 'window') return
    const timer = setTimeout(
      () => setApproval({ state: 'off' }),
      Math.max(0, approval.until - Date.now())
    )
    return () => clearTimeout(timer)
  }, [approval])
  if (approval.state === 'off') return null
  const remaining = approval.state === 'window' ? approval.until - Math.max(now, receivedAt) : 0
  if (approval.state === 'window' && remaining <= 0) return null
  const label =
    approval.state === 'silent'
      ? t('header.approval.silent')
      : t('header.approval.window', {
          minutes: Math.ceil(remaining / 60000),
          writes: approval.writesLeft
        })
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className="h-[6px] w-[6px] shrink-0 bg-[var(--sig)]"
    />
  )
}
