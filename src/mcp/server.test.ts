/**
 * The write tools' parameter descriptions must name every limit the write
 * bridge enforces (#223, #226). Both create_manual_entry and
 * update_entry_fields run through validateManualEntry, so a limit missing from
 * the schema is one an AI client only learns from the rejection — after it has
 * already composed the text.
 *
 * server.ts writes the numbers as literals (the MCP build cannot import from
 * src/main), so this test pins them to the constants that are actually
 * enforced: a change on either side turns it red.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildServer } from './server'
import {
  MAX_DESCRIPTION_LEN,
  MAX_REFERENCE_LEN,
  MAX_NOTE_LEN,
  MAX_DURATION_SECONDS
} from '../main/entryMutations'

type Props = Record<string, { description?: string }>

describe('write tool schemas state the enforced limits', () => {
  const client = new Client({ name: 'schema-test', version: '0.0.0' })
  const schemas = new Map<string, Props>()

  beforeAll(async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await buildServer().connect(serverTransport)
    await client.connect(clientTransport)
    const { tools } = await client.listTools()
    for (const t of tools) schemas.set(t.name, (t.inputSchema.properties ?? {}) as Props)
  })

  afterAll(async () => {
    await client.close()
  })

  const maxHours = MAX_DURATION_SECONDS / 3600

  for (const tool of ['create_manual_entry', 'update_entry_fields']) {
    describe(tool, () => {
      const desc = (field: string): string => schemas.get(tool)?.[field]?.description ?? ''

      it('names the description limit', () => {
        expect(desc('description')).toContain(`Max. ${MAX_DESCRIPTION_LEN} Zeichen.`)
      })

      it('names the reference limit', () => {
        expect(desc('reference')).toContain(`Max. ${MAX_REFERENCE_LEN} Zeichen.`)
      })

      it('names the private_note limit', () => {
        expect(desc('private_note')).toContain(`Max. ${MAX_NOTE_LEN} Zeichen.`)
      })

      it('names the duration cap on stopped_at', () => {
        expect(desc('stopped_at')).toContain(`Max. ${maxHours} Stunden nach der Startzeit.`)
      })
    })
  }
})
