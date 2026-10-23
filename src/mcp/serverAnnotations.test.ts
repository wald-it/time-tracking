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
// Writes can fire the user's outbound webhooks: openWorldHint true. None is
// marked idempotent, so no client retries a write on its own.
const write = (destructiveHint: boolean): Record<string, boolean> => ({
  readOnlyHint: false,
  destructiveHint,
  idempotentHint: false,
  openWorldHint: true
})

const EXPECTED: Record<string, Record<string, boolean>> = {
  list_clients: READ,
  list_projects: READ,
  list_entries: READ,
  get_running_timer: READ,
  get_dashboard: READ,
  get_analytics: READ,
  get_report: READ,
  // Only adds a new entry.
  create_manual_entry: write(false),
  // Deletes the entry's rows and inserts the edited range under a new id.
  update_entry_fields: write(true),
  // Ends every entry without a stop time at the new start.
  start_timer: write(true),
  // Ends whatever runs when the write executes; it takes no id.
  stop_running_timer: write(true)
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
