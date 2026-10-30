/**
 * Q17 — the recipes are tested prompts: the server offers each as an MCP
 * prompt, each names only tools the server has, every write runs as a
 * preview first and says that a preview creates nothing, the monthly close
 * carries no house format, and docs/mcp-recipes.md shows the same texts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildServer } from './server'
import { RECIPES, renderRecipeDoc } from './recipes'

const WRITE_TOOLS = [
  'create_manual_entry',
  'update_entry_fields',
  'start_timer',
  'stop_running_timer'
]

/** Every snake_case word that looks like a tool name. */
const toolNames = (text: string): string[] =>
  [...text.matchAll(/\b(?:list|get|check|create|update|start|stop)_[a-z_]+\b/g)].map((m) => m[0])

/** A recipe's text with every argument filled in. */
const filled = (r: (typeof RECIPES)[number]): string =>
  r.text(Object.fromEntries(r.args.map((a) => [a.name, `«${a.name}»`])))

describe('MCP recipes (Q17)', () => {
  const client = new Client({ name: 'recipe-test', version: '0.0.0' })
  const tools = new Set<string>()

  beforeAll(async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await buildServer().connect(serverTransport)
    await client.connect(clientTransport)
    for (const t of (await client.listTools()).tools) tools.add(t.name)
  })

  afterAll(async () => {
    await client.close()
  })

  it('the server lists every recipe as a prompt, with its arguments', async () => {
    const { prompts } = await client.listPrompts()
    expect(prompts.map((p) => p.name).sort()).toEqual(RECIPES.map((r) => r.name).sort())
    for (const r of RECIPES) {
      const p = prompts.find((x) => x.name === r.name)!
      expect(p.title).toBe(r.title)
      expect(p.description).toBe(r.description)
      expect((p.arguments ?? []).map((a) => [a.name, a.required ?? false])).toEqual(
        r.args.map((a) => [a.name, a.required])
      )
    }
  })

  it('a prompt returns the recipe text with the arguments filled in', async () => {
    for (const r of RECIPES) {
      const args = Object.fromEntries(r.args.map((a) => [a.name, `«${a.name}»`]))
      const res = await client.getPrompt({ name: r.name, arguments: args })
      expect(res.messages).toEqual([{ role: 'user', content: { type: 'text', text: filled(r) } }])
    }
  })

  it('nachtrag lists was as optional (#455)', async () => {
    const { prompts } = await client.listPrompts()
    expect(prompts.find((p) => p.name === 'nachtrag')?.arguments).toEqual([
      expect.objectContaining({ name: 'was', required: false })
    ])
  })

  it.each([undefined, '', ' \t\n '])(
    'nachtrag asks for the sentence in chat when was is %j (#455)',
    async (was) => {
      const res = await client.getPrompt({
        name: 'nachtrag',
        ...(was === undefined ? {} : { arguments: { was } })
      })
      expect(res.messages[0].content).toEqual({
        type: 'text',
        text: expect.stringContaining('frag mich im Chat nach dem ganzen Satz')
      })
    }
  )

  it('nachtrag quotes the received text and confirms completeness before any other step (#455)', () => {
    const text = RECIPES.find((r) => r.name === 'nachtrag')!.text({ was: '  gestern 14 Uhr  ' })
    const opening = text.split('\n')[0]
    expect.soft(opening).toContain('„gestern 14 Uhr“')
    expect
      .soft(opening)
      .toContain(
        'Bevor du etwas anderes tust, lass dir von mir bestätigen, dass das der ganze Satz ist'
      )
    expect.soft(opening).toContain('der Client könnte ihn abgeschnitten haben')
  })

  it.each([undefined, 'Projekt: Tätigkeit'])(
    'the monthly close marks billed findings and excludes them from proposals and writes (format %j, #456)',
    (format) => {
      const text = RECIPES.find((r) => r.name === 'monatsabschluss')!.text({
        monat: '2026-10',
        format
      })
      const step = (n: number): string | undefined =>
        text.split('\n').find((line) => line.startsWith(`${n}.`))
      expect
        .soft(step(3))
        .toContain('Einträgen mit billed als abgerechnet und nenne die Laufnummern')
      expect.soft(step(4)).toContain('nur für Einträge mit billed null')
      expect.soft(step(5)).toContain('Ändere nur Einträge mit billed null')
    }
  )

  it('plausibility checks empty days with one period query and handles truncation (#457)', () => {
    const text = RECIPES.find((r) => r.name === 'plausibilitaet')!.text({
      von: '2026-10-01',
      bis: '2026-10-31'
    })
    const step = text.split('\n').find((line) => line.startsWith('5.'))!
    expect.soft(step).toContain('Hol einmal list_entries mit from/to über den ganzen Zeitraum')
    expect
      .soft(step)
      .toContain('bis zur lokalen Mitternacht nach dem letzten Tag, jeweils mit Zeitzone')
    expect.soft(step).toContain('limit:10000')
    expect.soft(step).toContain('count größer als entries.length')
    expect.soft(step).toContain('kleinere Abschnitte, bis alle Einträge vorliegen')
    expect.soft(step).toContain('Vergleiche die belegten Tage mit den Tagen aus get_report')
  })

  it('plausibility excludes public holidays before asking about empty working days (#457)', () => {
    const text = RECIPES.find((r) => r.name === 'plausibilitaet')!.text({
      von: '2026-10-01',
      bis: '2026-10-31'
    })
    const step = text.split('\n').find((line) => line.startsWith('6.'))!
    expect
      .soft(step)
      .toContain('Lass gesetzliche Feiertage aus, bevor du nach Werktagen ohne Eintrag fragst')
    expect
      .soft(step)
      .toContain('kennst du mein Bundesland oder meine Region nicht, frag mich einmal danach')
    expect.soft(step).toContain('TimeTrack hat keine Feiertagsdaten')
  })

  it.each(RECIPES.map((r) => [r.name, r] as const))(
    '%s names only tools the server has',
    (_name, r) => {
      const named = toolNames(filled(r))
      expect(named.length).toBeGreaterThan(0)
      for (const t of named) expect(tools.has(t), t).toBe(true)
    }
  )

  it.each(RECIPES.filter((r) => r.name !== 'plausibilitaet').map((r) => [r.name, r] as const))(
    '%s runs every write as a preview first and says a preview creates nothing',
    (_name, r) => {
      const text = filled(r)
      expect(toolNames(text).some((t) => WRITE_TOOLS.includes(t))).toBe(true)
      expect(text).toContain('preview:true')
      expect(text).toContain('Eine Vorschau legt in TimeTrack nichts an und ändert nichts.')
      expect(text).toContain('denselben Aufruf ohne preview wiederholen')
    }
  )

  it('the read-only check names no write tool at all', () => {
    const check = RECIPES.find((r) => r.name === 'plausibilitaet')!
    expect(toolNames(filled(check)).filter((t) => WRITE_TOOLS.includes(t))).toEqual([])
  })

  it('the plausibility recipe delegates rules to check_period and adds only gaps, timers and budgets', () => {
    const text = RECIPES.find((r) => r.name === 'plausibilitaet')!.text({
      von: '2026-10-01',
      bis: '2026-10-31'
    })
    expect(text).toContain('check_period mit client_id und from/to')
    expect(text).toContain('include_archived:true')
    expect(text).toContain('Lücken zwischen Arbeitstagen')
    expect(text).toContain('get_running_timer')
    expect(text).toContain('Budget fast oder ganz verbraucht')
    expect(text).not.toMatch(/Tage über zehn Stunden|Arbeit am Wochenende/)
  })

  it('the monthly close keeps the id and uses the returned version for subsequent writes', () => {
    const text = RECIPES.find((r) => r.name === 'monatsabschluss')!.text({ monat: '2026-10' })
    expect(text).toContain('version aus list_entries als expected_version')
    expect(text).toContain('behält die id')
    expect(text).toContain('neuen version (auch version_no)')
    expect(text).toContain('diese version als expected_version')
    expect(text).not.toContain('neuen id')
  })

  it('the monthly close has no format unless one is given (Q7: empty by default)', () => {
    const close = RECIPES.find((r) => r.name === 'monatsabschluss')!
    expect(close.args.find((a) => a.name === 'format')?.required).toBe(false)
    const without = close.text({ monat: '2026-10' })
    expect(without).not.toMatch(/in diesem Format/)
    expect(close.text({ monat: '2026-10', format: '' })).toBe(without)
    expect(close.text({ monat: '2026-10', format: 'Projekt: Tätigkeit' })).toContain(
      'in diesem Format: Projekt: Tätigkeit'
    )
  })

  it('docs/mcp-recipes.md shows the same texts as the source', () => {
    const doc = readFileSync(join(__dirname, '..', '..', 'docs', 'mcp-recipes.md'), 'utf8').replace(
      /\r\n/g,
      '\n'
    )
    // Prettier puts blank lines around the markers; the block itself must match.
    const block = doc.match(/<!-- recipes:start -->([\s\S]*)<!-- recipes:end -->/)?.[1].trim()
    // On a mismatch: replace the block between the markers with renderRecipeDoc().
    expect(block).toBe(renderRecipeDoc())
  })
})
