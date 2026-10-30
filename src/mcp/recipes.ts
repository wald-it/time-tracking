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
          'Was nachgetragen werden soll, als ganzer Satz. In Claude Code ohne Argument aufrufen, dann fragt das Rezept im Chat danach; nach dem Befehl kommt nur das erste Wort an.',
        required: false
      }
    ],
    text: (a) =>
      [
        a.was?.trim()
          ? `Trag diese Zeit in TimeTrack nach: „${a.was.trim()}“. Bevor du etwas anderes tust, lass dir von mir bestätigen, dass das der ganze Satz ist; der Client könnte ihn abgeschnitten haben.`
          : `Trag diese Zeit in TimeTrack nach: ${ask(a.was, '(bitte frag mich im Chat nach dem ganzen Satz, der nachgetragen werden soll)')}`,
        '',
        '1. Finde Kunde und Projekt mit list_clients und list_projects. Passt mehr als eines oder keines, frag mich.',
        '2. Bestimme Beginn und Ende als Zeitstempel mit Zeitzone. Fehlt eine Uhrzeit, frag nach, statt sie zu raten.',
        '3. Prüf mit list_entries für jeden Tag, den der neue Eintrag berührt, und für den Tag davor, ob er sich mit einem bestehenden überschneidet (auch mit einem, der am Vorabend begann und über Mitternacht lief), und sag es mir.',
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
        '2. Hol die Einträge des Monats mit list_entries und die Projekte der Kunden mit list_projects.',
        '3. Liste auf, was ich mir ansehen sollte: Einträge ohne Beschreibung, Einträge über zehn Stunden, nicht abrechenbare Einträge, Einträge ohne Projekt bei Kunden mit Projekten und Überschneidungen. Kennzeichne Befunde zu Einträgen mit billed als abgerechnet und nenne die Laufnummern.',
        format
          ? `4. Schlag nur für Einträge mit billed null und fehlender oder unklarer Beschreibung einen Text vor, in diesem Format: ${format}`
          : '4. Schlag nur für Einträge mit billed null und fehlender oder unklarer Beschreibung einen Text vor, im Stil der übrigen Beschreibungen des Monats.',
        `5. Ändere nur Einträge mit billed null, einzeln mit update_entry_fields und nur nach meiner Zustimmung. Gib die version aus list_entries als expected_version mit. ${WRITE_RULE} update_entry_fields behält die id und liefert den Eintrag mit der neuen version (auch version_no) zurück; nimm für jede weitere Änderung diese version als expected_version.`,
        '6. Hol die Summen danach erneut mit get_report, weil Änderungen sie verschieben, und schließ damit: Stunden je Kunde, davon abrechenbar, gerundet wie die Rechnung.'
      ].join('\n')
    }
  },
  {
    name: 'plausibilitaet',
    title: 'Zeiten auf Plausibilität prüfen',
    description:
      'Einen Zeitraum mit dem Regelcheck prüfen, dazu Lücken, vergessene Timer und knappe Budgets, ohne etwas zu ändern.',
    args: [
      { name: 'von', description: 'Erster Tag als YYYY-MM-DD', required: true },
      { name: 'bis', description: 'Letzter Tag als YYYY-MM-DD', required: true }
    ],
    text: (a) =>
      [
        `Prüf meine Zeiten in TimeTrack von ${ask(a.von, '(bitte frag mich nach dem ersten Tag)')} bis ${ask(a.bis, '(bitte frag mich nach dem letzten Tag)')} auf Plausibilität.`,
        '',
        '1. Hol die Kunden mit list_clients (include_archived:true). Ruf für jeden Kunden check_period mit client_id und from/to für diesen Zeitraum auf. Übernimm dessen Befunde zu Beschreibungen, Projekten, Abrechenbarkeit, fehlenden Sätzen, langen Einträgen und Tagen, Arbeitszeiten, Wochenenden und Formatregeln.',
        '2. Hol die Tagessummen mit get_report, gruppiert nach day, und suche Lücken zwischen Arbeitstagen.',
        '3. Prüf mit get_running_timer, ob ein Timer seit mehr als zwölf Stunden läuft.',
        '4. Prüf mit list_projects, welche Projekte ihr Budget fast oder ganz verbraucht haben.',
        '5. Ein Tag fehlt in get_report auch dann, wenn dort nur ein laufender Timer oder Einträge ohne Dauer stehen. Hol einmal list_entries mit from/to über den ganzen Zeitraum (lokale Mitternacht am ersten Tag bis zur lokalen Mitternacht nach dem letzten Tag, jeweils mit Zeitzone) und limit:10000. Ist count größer als entries.length, wiederhole die Abfrage für kleinere Abschnitte, bis alle Einträge vorliegen. Vergleiche die belegten Tage mit den Tagen aus get_report; beachte bei Einträgen über Mitternacht auch segments.',
        '6. Lass gesetzliche Feiertage aus, bevor du nach Werktagen ohne Eintrag fragst; kennst du mein Bundesland oder meine Region nicht, frag mich einmal danach. TimeTrack hat keine Feiertagsdaten. Stell mir Fragen statt Schlüsse zu ziehen: zu den Befunden von check_period, den übrigen Werktagen ohne Eintrag, einem lange laufenden Timer und knappen Budgets.',
        '7. Ändere in diesem Durchgang nichts.'
      ].join('\n')
  }
]

/**
 * The doc block for docs/mcp-recipes.md, generated from RECIPES. Required
 * fields show as `<name>`; optional ones are left empty, so the doc shows the
 * default text a user gets without them (the monthly close: no format).
 */
export function renderRecipeDoc(): string {
  return RECIPES.map((r) => {
    const placeholders = Object.fromEntries(
      r.args.map((a) => [a.name, a.required ? `<${a.name}>` : undefined])
    )
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
