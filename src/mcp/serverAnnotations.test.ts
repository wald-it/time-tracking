/**
 * Every MCP tool carries annotations, so a client can tell read tools from
 * write tools without parsing descriptions (#300). The expected table is
 * written out by hand: a new tool that is not listed here, or one that ships
 * without annotations, turns this red.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildServer } from './server'

const READ = { readOnlyHint: true, openWorldHint: false }
// Writes can fire the user's outbound webhooks: openWorldHint true.
const write = (destructiveHint: boolean, idempotentHint: boolean): Record<string, boolean> => ({
  readOnlyHint: false,
  destructiveHint,
  idempotentHint,
  openWorldHint: true
})

const EXPECTED: Record<string, Record<string, boolean>> = {
  list_clients: READ,
  list_projects: READ,
  list_entries: READ,
  get_running_timer: READ,
  get_dashboard: READ,
  get_analytics: READ,
  // Adds an entry; a repeat adds another.
  create_manual_entry: write(false, false),
  // Deletes the row and inserts it again under a new id.
  update_entry_fields: write(true, false),
  // Ends a running entry at the new start, possibly in the past.
  start_timer: write(true, false),
  // A repeat finds nothing running and does nothing.
  stop_running_timer: write(false, true)
}

describe('MCP tool annotations (#300)', () => {
  const client = new Client({ name: 'annotation-test', version: '0.0.0' })
  const annotations = new Map<string, unknown>()

  beforeAll(async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await buildServer().connect(serverTransport)
    await client.connect(clientTransport)
    const { tools } = await client.listTools()
    for (const t of tools) annotations.set(t.name, t.annotations)
  })

  afterAll(async () => {
    await client.close()
  })

  it('lists exactly the expected tools', () => {
    expect([...annotations.keys()].sort()).toEqual(Object.keys(EXPECTED).sort())
  })

  for (const [name, expected] of Object.entries(EXPECTED)) {
    it(`${name} is annotated as a ${expected.readOnlyHint ? 'read' : 'write'} tool`, () => {
      expect(annotations.get(name)).toEqual(expected)
    })
  }
})
