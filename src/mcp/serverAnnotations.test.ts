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
const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false
}

const EXPECTED: Record<string, Record<string, boolean>> = {
  list_clients: READ,
  list_projects: READ,
  list_entries: READ,
  get_running_timer: READ,
  get_dashboard: READ,
  get_analytics: READ,
  create_manual_entry: WRITE,
  update_entry_fields: WRITE,
  start_timer: WRITE,
  stop_running_timer: WRITE
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
