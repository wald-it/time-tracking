import { describe, expect, it } from 'vitest'
import type { EntryVersion } from './types'
import { collapseEntryVersions, diffEntryVersions } from './entryHistory'

function version(version_no: number, patch: Partial<EntryVersion> = {}): EntryVersion {
  return {
    version_id: version_no,
    version_no,
    state: 'sealed',
    deleted: false,
    written_at: '2026-10-28T10:00:00.000Z',
    source: 'app',
    reason: null,
    client_id: 1,
    project_id: null,
    description: '',
    started_at: '2026-10-28T09:00:00.000Z',
    stopped_at: '2026-10-28T10:00:00.000Z',
    tags: '',
    reference: '',
    billable: 1,
    private_note: '',
    segments: [],
    ...patch
  }
}

describe('entry history', () => {
  it('includes exactly five minutes, excludes later writes and keeps version order', () => {
    const first = version(1)
    const note = version(2, { written_at: '2026-10-28T10:05:00.000Z', source: 'quicknote' })
    const later = version(3, { written_at: '2026-10-28T10:05:00.001Z' })
    expect(collapseEntryVersions([later, first, note])).toEqual([
      { capture: true, versions: [first, note] },
      { capture: false, versions: [later] }
    ])
  })

  it('does not collapse running entries or writes before the stop', () => {
    const open = version(1, { state: 'open', stopped_at: null })
    expect(collapseEntryVersions([open, version(2)])).toHaveLength(2)
    expect(
      collapseEntryVersions([
        version(1),
        version(2, {
          written_at: '2026-10-28T09:59:59.000Z'
        })
      ])
    ).toHaveLength(2)
  })

  it('anchors the window to the moment of the stop, not to a backdated stop time', () => {
    // Idle prompt: stopped at 10:00 back to the idle start 09:40, quick note at 10:02.
    const first = version(1, { stopped_at: '2026-10-28T09:40:00.000Z' })
    const note = version(2, { written_at: '2026-10-28T10:02:00.000Z', source: 'quicknote' })
    expect(collapseEntryVersions([first, note])).toEqual([
      { capture: true, versions: [first, note] }
    ])
  })

  it('anchors the window to capture, without chaining later time corrections', () => {
    const first = version(1)
    const correction = version(2, { stopped_at: '2026-10-28T10:04:00.000Z' })
    const later = version(3, { written_at: '2026-10-28T10:08:00.000Z' })
    expect(collapseEntryVersions([first, correction, later]).map((g) => g.versions.length)).toEqual(
      [2, 1]
    )
  })

  it('reports delete and restore, including their versions in the capture window', () => {
    const first = version(1)
    const deleted = version(2, { deleted: true })
    const restored = version(3)
    expect(diffEntryVersions(first, deleted)).toEqual(['deleted'])
    expect(diffEntryVersions(deleted, restored)).toEqual(['restored'])
    expect(collapseEntryVersions([first, deleted, restored])).toEqual([
      { capture: true, versions: [first, deleted, restored] }
    ])
  })

  it('diffs all content fields and both midnight segments, ignoring metadata', () => {
    const segments = [
      {
        seq: 0,
        segment_date: '2026-10-28',
        started_at: '2026-10-28T23:00:00+01:00',
        stopped_at: '2026-10-29T00:00:00+01:00'
      },
      {
        seq: 1,
        segment_date: '2026-10-29',
        started_at: '2026-10-29T00:00:00+01:00',
        stopped_at: '2026-10-29T01:00:00+01:00'
      }
    ]
    const first = version(1, { segments })
    expect(diffEntryVersions(first, version(2, { segments }))).toEqual([])
    expect(
      diffEntryVersions(
        first,
        version(2, {
          segments: segments.map((s) => ({
            stopped_at: s.stopped_at,
            started_at: s.started_at,
            segment_date: s.segment_date,
            seq: s.seq
          }))
        })
      )
    ).toEqual([])
    expect(
      diffEntryVersions(
        first,
        version(2, {
          segments: [segments[0], { ...segments[1], stopped_at: '2026-10-29T02:00:00+01:00' }],
          client_id: 2,
          project_id: 3,
          description: 'new',
          billable: 0,
          tags: ',work,',
          reference: 'TASK-1',
          private_note: 'internal'
        })
      )
    ).toEqual([
      'times',
      'client',
      'project',
      'description',
      'billable',
      'tags',
      'reference',
      'private_note'
    ])
  })
})
