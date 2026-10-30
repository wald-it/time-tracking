/**
 * Q8, 2.2: "Fortsetzen" on a row of Heute's entry table starts that
 * entry's client, project and description again. What it may start follows
 * the same rule as the last pair (shared/startPair): no archived client, and
 * an archived project is left out.
 */
import { describe, expect, it } from 'vitest'
import type { Client, Entry, Project } from '../../../../shared/types'
import { resumeTarget } from './resumeTarget'

const client = (active: number): Client => ({
  short_code: null,
  id: 2,
  name: 'Beta',
  color: '#222222',
  active,
  rate_cent: 0,
  created_at: ''
})
const project = (active: number): Project => ({
  id: 20,
  client_id: 2,
  name: 'Audit',
  color: '',
  rate_cent: null,
  active,
  created_at: ''
})
const entry = (over: Partial<Entry> = {}): Entry => ({
  id: 7,
  client_id: 2,
  project_id: 20,
  description: 'Review',
  started_at: '2026-10-23T08:00:00.000Z',
  stopped_at: '2026-10-23T09:00:00.000Z',
  heartbeat_at: null,
  rounded_min: null,
  deleted_at: null,
  created_at: '',
  link_id: null,
  tags: '',
  reference: '',
  billable: 1,
  private_note: '',
  ...over
})

describe('resumeTarget', () => {
  it('is the entry’s client, project and description', () => {
    expect(resumeTarget(entry(), client(1), project(1))).toEqual({
      clientId: 2,
      projectId: 20,
      description: 'Review'
    })
  })

  it('leaves an archived project out', () => {
    expect(resumeTarget(entry(), client(1), project(0))).toEqual({
      clientId: 2,
      projectId: null,
      description: 'Review'
    })
  })

  it('keeps "no project"', () => {
    expect(resumeTarget(entry({ project_id: null }), client(1), undefined)).toEqual({
      clientId: 2,
      projectId: null,
      description: 'Review'
    })
  })

  it('is null for an archived or unknown client', () => {
    expect(resumeTarget(entry(), client(0), project(1))).toBeNull()
    expect(resumeTarget(entry(), undefined, project(1))).toBeNull()
  })

  it('is null for a running entry: it already runs', () => {
    expect(resumeTarget(entry({ stopped_at: null }), client(1), project(1))).toBeNull()
  })
})
