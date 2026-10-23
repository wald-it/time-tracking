/**
 * #297: one rule for the pair a start without a selection uses (hotkey, mini
 * widget play) and the START dialog's prefill.
 */
import { describe, expect, it } from 'vitest'
import { lastStartPair } from './startPair'

const CLIENTS = [
  { id: 1, active: 1 },
  { id: 2, active: 1 },
  { id: 3, active: 0 }
]
const PROJECTS = [
  { id: 20, active: 1 },
  { id: 21, active: 0 }
]

describe('lastStartPair', () => {
  it('is the last entry’s client and project', () => {
    expect(lastStartPair({ client_id: 2, project_id: 20 }, CLIENTS, PROJECTS)).toEqual({
      clientId: 2,
      projectId: 20
    })
  })

  it('keeps "no project" when the last entry had none', () => {
    expect(lastStartPair({ client_id: 2, project_id: null }, CLIENTS, PROJECTS)).toEqual({
      clientId: 2,
      projectId: null
    })
  })

  it('drops an archived project, keeps the client', () => {
    expect(lastStartPair({ client_id: 2, project_id: 21 }, CLIENTS, PROJECTS)).toEqual({
      clientId: 2,
      projectId: null
    })
  })

  it('drops a project it does not know, keeps the client', () => {
    expect(lastStartPair({ client_id: 2, project_id: 99 }, CLIENTS, PROJECTS)).toEqual({
      clientId: 2,
      projectId: null
    })
  })

  it('is null when the last entry’s client is archived', () => {
    expect(lastStartPair({ client_id: 3, project_id: null }, CLIENTS, PROJECTS)).toBeNull()
  })

  it('is null when the client is unknown', () => {
    expect(lastStartPair({ client_id: 9, project_id: null }, CLIENTS, PROJECTS)).toBeNull()
  })

  it('is null without any entry', () => {
    expect(lastStartPair(undefined, CLIENTS, PROJECTS)).toBeNull()
    expect(lastStartPair(null, CLIENTS, PROJECTS)).toBeNull()
  })
})
