/**
 * A preview reply must say that nothing was written. Before, it returned the
 * planned entry as plain JSON — indistinguishable from a success — so a client
 * could stop after the preview and report an entry the app never showed.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

vi.mock('./writeClient', () => ({
  sendWrite: vi.fn(async (_op: string, _args: unknown, preview: boolean) => ({
    ok: true,
    data: preview ? { preview: true, action: 'create_manual_entry' } : { id: 42 }
  }))
}))

const { buildServer } = await import('./server')

const ARGS = {
  client_id: 1,
  description: 'x',
  started_at: '2026-10-22T09:00:00.000Z',
  stopped_at: '2026-10-22T10:00:00.000Z'
}

function text(res: unknown): string {
  return (res as { content: Array<{ text: string }> }).content[0].text
}

describe('write tool preview replies', () => {
  const client = new Client({ name: 'preview-test', version: '0.0.0' })

  beforeAll(async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await buildServer().connect(serverTransport)
    await client.connect(clientTransport)
  })

  afterAll(async () => {
    await client.close()
  })

  const TOOLS: Record<string, Record<string, unknown>> = {
    create_manual_entry: ARGS,
    update_entry_fields: { id: 1, ...ARGS },
    start_timer: { client_id: 1, description: 'x' },
    stop_running_timer: {}
  }

  for (const [name, args] of Object.entries(TOOLS)) {
    it(`${name}: a preview states that nothing was written and how to execute`, async () => {
      const res = await client.callTool({ name, arguments: { ...args, preview: true } })
      const body = JSON.parse(text(res))
      expect(body.hinweis).toMatch(/nichts angelegt/)
      expect(body.hinweis).toMatch(/ohne preview/)
      expect(body.preview).toBe(true)
    })
  }

  it('a real write carries no preview note', async () => {
    const res = await client.callTool({ name: 'create_manual_entry', arguments: ARGS })
    expect(JSON.parse(text(res))).toEqual({ id: 42 })
  })
})
