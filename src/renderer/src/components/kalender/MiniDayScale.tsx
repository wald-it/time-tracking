import type { Client, Entry, Project } from '../../../../shared/types'
import { clockSeconds, pctOf, type DayRange } from '../heute/dayScaleLayout'
import { miniBar, miniTicks } from './monthScale'

/**
 * MiniDayScale — the time-of-day ruler at the bottom of every calendar cell
 * (HANDOFF §3.9). 14 px tall: bars 8 px at the top, a 1 px `--line` baseline
 * at 9 px, 4 px ticks below it. `range` is the month's shared range from
 * `monthRange()`, so the cells compare. On today's cell the running entry is
 * hatched and a 2 px `--sig` needle marks now.
 *
 * Purely decorative for assistive tech: the cell's `aria-label` carries the
 * day total. `nowMs` comes from the shared clock (`useNow()`) — no interval.
 */
export function MiniDayScale({
  entries,
  range,
  nowMs,
  isToday,
  projectsById,
  clientsById
}: {
  entries: Entry[]
  range: DayRange
  nowMs: number
  isToday: boolean
  projectsById: Map<number, Project>
  clientsById: Map<number, Client>
}): React.JSX.Element {
  const ticks = miniTicks(range)
  return (
    <span aria-hidden="true" className="relative block h-[14px] w-full">
      {entries.map((e) => {
        const bar = miniBar(e, range, nowMs)
        const project = e.project_id != null ? projectsById.get(e.project_id) : undefined
        const color = project?.color || clientsById.get(e.client_id)?.color || 'var(--tick)'
        return (
          <span
            key={e.id}
            data-testid="mini-bar"
            data-running={bar.running ? 'true' : undefined}
            className="absolute top-0 h-[8px]"
            style={{
              left: `${bar.left.toFixed(3)}%`,
              width: `${bar.width.toFixed(3)}%`,
              background: bar.running
                ? `repeating-linear-gradient(135deg, ${color} 0 3px, transparent 3px 5px)`
                : color,
              boxShadow: bar.running ? `inset 0 0 0 1px ${color}` : 'none'
            }}
          />
        )
      })}
      <span
        className="absolute right-0 left-0 h-px"
        style={{ top: 9, background: 'var(--line)' }}
      />
      {ticks.map((left) => (
        <span
          key={left}
          className="absolute w-px"
          style={{ top: 10, height: 4, left: `${left.toFixed(3)}%`, background: 'var(--tick)' }}
        />
      ))}
      {isToday && (
        <span
          data-testid="mini-needle"
          className="absolute w-[2px]"
          style={{
            top: -3,
            height: 17,
            left: `${pctOf(clockSeconds(nowMs, nowMs), range).toFixed(3)}%`,
            background: 'var(--sig)'
          }}
        />
      )}
    </span>
  )
}
