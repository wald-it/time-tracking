/**
 * Recipes (Q17): tested prompts for the TimeTrack MCP server. Each is offered
 * as an MCP prompt (Claude Desktop lists them, Claude Code as
 * /mcp__timetrack__<name>) and printed in docs/mcp-recipes.md for clients
 * without prompt support. This file is the one source; recipes.test.ts keeps
 * the doc in step and checks that a recipe names only tools that exist and
 * puts a preview before every write.
 *
 * Rules every recipe follows:
 * - A write runs first with preview:true and is repeated without preview only
 *   after the user agreed; the text says that a preview creates nothing.
 * - No house format: the monthly close takes a format only as an optional
 *   argument, empty by default (Q7: no format rule unless the user sets one).
 * - Nothing here tells the model to read or write files or other systems.
 */

export interface RecipeArg {
  name: string
  description: string
  required: boolean
}

export interface Recipe {
  name: string
  title: string
  description: string
  args: RecipeArg[]
  /** The prompt text, with each argument filled in. */
  text: (args: Record<string, string | undefined>) => string
}

/** How every recipe phrases a write, so a model never stops at the preview. */
const WRITE_RULE =
  'Jede Änderung zuerst mit preview:true aufrufen und die Vorschau zeigen. Eine Vorschau legt in ' +
  'TimeTrack nichts an und ändert nichts. Erst wenn ich zustimme, denselben Aufruf ohne preview ' +
  'wiederholen und danach bestätigen, was angelegt oder geändert wurde.'

const ask = (value: string | undefined, fallback: string): string =>
  value && value.trim() !== '' ? value.trim() : fallback

export const RECIPES: Recipe[] = [
  {
    name: 'nachtrag',
    title: 'Zeit nachtragen',
    description:
      'Einen vergessenen Eintrag aus einem Satz nachtragen, mit Vorschau vor dem Anlegen.',
    args: [
      {
        name: 'was',
        description:
          'Was nachgetragen werden soll, z. B. "gestern 14 bis 16 Uhr Workshop bei Acme"',
        required: true
      }
    ],
    text: (a) =>
      [
        `Trag diese Zeit in TimeTrack nach: ${ask(a.was, '(bitte frag mich, was nachgetragen werden soll)')}`,
        '',
        '1. Finde Kunde und Projekt mit list_clients und list_projects. Passt mehr als eines oder keines, frag mich.',
        '2. Bestimme Beginn und Ende als Zeitstempel mit Zeitzone. Fehlt eine Uhrzeit, frag nach, statt sie zu raten.',
        '3. Prüf mit list_entries für denselben Tag, ob sich der Eintrag mit einem bestehenden überschneidet, und sag es mir.',
        `4. Leg den Eintrag mit create_manual_entry an. ${WRITE_RULE}`
      ].join('\n')
  },
  {
    name: 'monatsabschluss',
    title: 'Monatsabschluss vorbereiten',
    description:
      'Einen Monat vor der Abrechnung durchsehen: was an den Einträgen fehlt oder auffällt, dazu die Summen.',
    args: [
      { name: 'monat', description: 'Monat als YYYY-MM, z. B. 2026-10', required: true },
      {
        name: 'format',
        description:
          'Wie Beschreibungen aussehen sollen. Leer lassen, dann gilt keine Formatregel.',
        required: false
      }
    ],
    text: (a) => {
      const format = a.format?.trim()
      return [
        `Bereite den Monatsabschluss für ${ask(a.monat, '(bitte frag mich nach dem Monat)')} in TimeTrack vor.`,
        '',
        '1. Hol die Summen mit get_report über den ganzen Monat, gruppiert nach client und project.',
        '2. Hol die Einträge des Monats mit list_entries.',
        '3. Liste auf, was ich mir ansehen sollte: Einträge ohne Beschreibung, Einträge über zehn Stunden, nicht abrechenbare Einträge, Einträge ohne Projekt bei Kunden mit Projekten und Überschneidungen.',
        format
          ? `4. Schlag für Einträge mit fehlender oder unklarer Beschreibung einen Text vor, in diesem Format: ${format}`
          : '4. Schlag für Einträge mit fehlender oder unklarer Beschreibung einen Text vor, im Stil der übrigen Beschreibungen des Monats.',
        `5. Änderungen nur einzeln mit update_entry_fields und nur nach meiner Zustimmung. ${WRITE_RULE}`,
        '6. Schließ mit den Summen aus Schritt 1: Stunden je Kunde, davon abrechenbar, gerundet wie die Rechnung.'
      ].join('\n')
    }
  },
  {
    name: 'plausibilitaet',
    title: 'Zeiten auf Plausibilität prüfen',
    description:
      'Einen Zeitraum auf Lücken, lange Tage und vergessene Timer prüfen, ohne etwas zu ändern.',
    args: [
      { name: 'von', description: 'Erster Tag als YYYY-MM-DD', required: true },
      { name: 'bis', description: 'Letzter Tag als YYYY-MM-DD', required: true }
    ],
    text: (a) =>
      [
        `Prüf meine Zeiten in TimeTrack von ${ask(a.von, '(bitte frag mich nach dem ersten Tag)')} bis ${ask(a.bis, '(bitte frag mich nach dem letzten Tag)')} auf Plausibilität.`,
        '',
        '1. Hol die Tagessummen mit get_report, gruppiert nach day.',
        '2. Prüf mit get_running_timer, ob ein Timer seit mehr als zwölf Stunden läuft.',
        '3. Prüf mit list_projects, welche Projekte ihr Budget fast oder ganz verbraucht haben.',
        '4. Stell mir Fragen statt Schlüsse zu ziehen: Werktage ohne Eintrag, Tage über zehn Stunden, Arbeit am Wochenende, ein lange laufender Timer, knappe Budgets.',
        '5. Ändere in diesem Durchgang nichts.'
      ].join('\n')
  }
]

/** The doc block for docs/mcp-recipes.md, generated from RECIPES. */
export function renderRecipeDoc(): string {
  return RECIPES.map((r) => {
    const placeholders = Object.fromEntries(r.args.map((a) => [a.name, `<${a.name}>`]))
    const args = r.args
      .map((a) => `- \`${a.name}\`${a.required ? '' : ' (optional)'}: ${a.description}`)
      .join('\n')
    return [
      `## ${r.title} (\`${r.name}\`)`,
      '',
      r.description,
      '',
      args,
      '',
      '```text',
      r.text(placeholders),
      '```'
    ].join('\n')
  }).join('\n\n')
}
