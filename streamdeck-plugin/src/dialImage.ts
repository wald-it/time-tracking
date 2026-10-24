/**
 * TimeTrack Stream Deck — touch-strip faces for the timer dial (#186).
 *
 * Same design language as the keys (`keyImage.ts`), on the encoder's 200x100
 * slot: the app's dark display window (Messinstrument, #363), readouts in a
 * mono face with the colon dimmed, the client colour as a thin bar, and
 * orange only for "running" (a blinking square). A seconds line replaces
 * the glass ring.
 *
 * The whole slot is ONE full-bleed SVG handed to the layout's `canvas` pixmap.
 * Text as layout items would mean a fixed rect per string; the four faces here
 * place their text differently, and a layout cannot switch geometry. Rendering
 * everything into the image keeps the layout contract at a single key — which
 * matters, because a key the layout does not know is dropped in silence.
 *
 * The same hardware rules as on the keys apply: one static frame, no SMIL, no
 * `pathLength`. Motion is frame-by-frame, driven by the action's 1 Hz tick.
 */
import {
  DISP,
  DISP_DIM,
  DISP_INK,
  DISP_LINE,
  FONT,
  MONO,
  OFF_BG,
  OFF_INK,
  SIG,
  clientBarColor,
  escapeXml
} from './keyImage'
import { formatHm } from './dialModel'

const W = 200
const H = 100

/**
 * The one key `setFeedback` writes to, and the one key `layouts/dial.json`
 * declares. Feedback keys are a contract with the layout: a key the layout
 * does not know is dropped without a word, which on the device is
 * indistinguishable from a broken feature. `dialImage.test.ts` checks both
 * sides against each other.
 */
export const FEEDBACK_KEY = 'canvas'

// ── Bausteine ──────────────────────────────────────────────────────────────

const SHELL = (fill: string = DISP): string =>
  `<rect x="0" y="0" width="${W}" height="${H}" rx="10" fill="${fill}"/>`

function dataUrl(inner: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    inner +
    '</svg>'
  // base64 rather than percent-encoding: the layout schema documents pixmap
  // values as "base64 encoded string", and that is the form the app parses
  // most reliably. Node's Buffer is available inside the plugin runtime.
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
}

function text(
  s: string,
  o: {
    x: number
    y: number
    size: number
    fill: string
    weight?: number
    anchor?: 'start' | 'middle' | 'end'
    mono?: boolean
    opacity?: number
    spacing?: number
  }
): string {
  if (!s) return ''
  const attrs = [
    `x="${o.x}"`,
    `y="${o.y}"`,
    `font-family="${o.mono ? MONO : FONT}"`,
    `font-size="${o.size}"`,
    `font-weight="${o.weight ?? 500}"`,
    `fill="${o.fill}"`,
    `text-anchor="${o.anchor ?? 'start'}"`
  ]
  if (o.opacity != null) attrs.push(`opacity="${o.opacity}"`)
  if (o.spacing != null) attrs.push(`letter-spacing="${o.spacing}"`)
  return `<text ${attrs.join(' ')}>${escapeXml(s)}</text>`
}

/**
 * Hard truncation with an ellipsis. No font metrics are available inside the
 * deck's renderer, so the budgets are character counts calibrated per size —
 * deliberately conservative: a clipped name is worse than a short one.
 */
export function fit(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s
  return s.slice(0, Math.max(1, maxChars - 1)).trimEnd() + '…'
}

/** Break into at most two lines at a space, else truncate to one. */
export function wrapTwo(s: string, maxChars: number): string[] {
  if (s.length <= maxChars) return [s]
  const words = s.split(/\s+/)
  const lines: string[] = []
  let line = ''
  for (const w of words) {
    if (line === '') line = w
    else if ((line + ' ' + w).length <= maxChars) line += ' ' + w
    else {
      lines.push(line)
      line = w
    }
  }
  if (line) lines.push(line)
  return lines.slice(0, 2).map((l) => fit(l, maxChars))
}

// ── Laufzeichen ────────────────────────────────────────────────────────────

/**
 * Seconds within the minute as a thin line along the bottom edge (replaces the
 * glass ring, #363). Real user units, one static frame per tick.
 */
const SECONDS_W = 172

function secondsLine(elapsedSec: number, color: string): string {
  const w = Math.round(((Math.floor(elapsedSec) % 60) / 60) * SECONDS_W)
  return (
    `<line x1="14" y1="91" x2="${14 + SECONDS_W}" y2="91" stroke="${DISP_LINE}" stroke-width="2"/>` +
    (w > 0 ? `<rect x="14" y="90" width="${w}" height="2" fill="${color}"/>` : '')
  )
}

/** The running mark: a signal square that blinks with the 1 Hz tick, like the app header. */
function runMark(x: number, y: number, elapsedSec: number, size = 9): string {
  const o = Math.floor(elapsedSec) % 2 === 0 ? '1' : '0.35'
  return `<rect x="${x}" y="${y}" width="${size}" height="${size}" fill="${SIG}" opacity="${o}"/>`
}

function legend(s: string, x: number, y: number): string {
  return text(s, { x, y, size: 8, fill: DISP_DIM, weight: 600, spacing: 1.1 })
}

/** H:MM with the colon in the dim display colour (Messinstrument readout). */
function readout(s: string, o: { x: number; y: number; size: number }): string {
  const i = s.indexOf(':')
  if (i < 0) return text(s, { ...o, fill: DISP_INK, weight: 300, mono: true, spacing: -0.6 })
  return (
    `<text x="${o.x}" y="${o.y}" font-family="${MONO}" font-size="${o.size}" font-weight="300" fill="${DISP_INK}" text-anchor="start" letter-spacing="-0.6">` +
    `${escapeXml(s.slice(0, i))}<tspan fill="${DISP_DIM}">:</tspan>${escapeXml(s.slice(i + 1))}</text>`
  )
}

// ── Flächen ────────────────────────────────────────────────────────────────

export interface DialLabel {
  /** Client name — the header when a project is shown, else the main line. */
  client: string
  /** Project name, or null for a client-only target. */
  project: string | null
}

/**
 * Idle: the two numbers from the app's "Heute" page, plus the entry a press
 * would start. The footer is what keeps the press from being blind — without
 * it you would have to rotate first to find out what you are about to start.
 */
function statsFace(o: {
  todaySeconds: number
  weekSeconds: number
  label: DialLabel | null
  position: string
  color?: string
}): string {
  const bar = clientBarColor(o.color)
  const selection = o.label
    ? o.label.project
      ? `${o.label.client} · ${o.label.project}`
      : o.label.client
    : 'No clients'
  return (
    SHELL() +
    legend('TODAY', 14, 20) +
    legend('WEEK', 106, 20) +
    readout(formatHm(o.todaySeconds), { x: 14, y: 48, size: 26 }) +
    readout(formatHm(o.weekSeconds), { x: 106, y: 48, size: 26 }) +
    `<line x1="14" y1="62" x2="186" y2="62" stroke="${DISP_LINE}" stroke-width="1"/>` +
    `<rect x="14" y="74" width="4" height="12" fill="${bar}"/>` +
    text(fit(selection, 24), { x: 24, y: 84, size: 10, fill: DISP_INK }) +
    text(o.position, { x: 186, y: 84, size: 9, fill: DISP_DIM, anchor: 'end', mono: true })
  )
}

/**
 * Rotating: the entry under the wheel. The bar along the bottom is the
 * position in the list — on a long list the counter alone does not convey
 * "how far in" you are.
 */
function browseFace(o: {
  label: DialLabel
  position: string
  progress: number
  color?: string
  running: boolean
}): string {
  const bar = clientBarColor(o.color)
  const main = o.label.project ?? o.label.client
  const lines = wrapTwo(main, 17)
  const header = o.label.project ? o.label.client : ''
  const barW = Math.max(6, Math.round(168 * Math.min(1, Math.max(0, o.progress))))
  return (
    SHELL() +
    `<rect x="14" y="13" width="4" height="10" fill="${bar}"/>` +
    text(fit(header.toUpperCase(), 22), {
      x: 24,
      y: 21,
      size: 8,
      fill: DISP_DIM,
      weight: 600,
      spacing: 1.1
    }) +
    text(o.position, { x: 186, y: 21, size: 9, fill: DISP_DIM, anchor: 'end', mono: true }) +
    (lines.length === 1
      ? text(lines[0], { x: 16, y: 60, size: 19, fill: DISP_INK, weight: 600 })
      : text(lines[0], { x: 16, y: 52, size: 18, fill: DISP_INK, weight: 600 }) +
        text(lines[1], { x: 16, y: 72, size: 18, fill: DISP_INK, weight: 600 })) +
    // Running target while browsing: the signal square, the app's only
    // meaning of orange — "this one is already going" before you press.
    (o.running ? `<rect x="177" y="72" width="9" height="9" fill="${SIG}"/>` : '') +
    `<line x1="16" y1="90" x2="184" y2="90" stroke="${DISP_LINE}" stroke-width="4"/>` +
    `<rect x="16" y="88" width="${barW}" height="4" rx="2" fill="${bar}"/>`
  )
}

/** Running: the app's timer readout, the blinking signal square and the seconds line. */
function runningFace(o: { label: DialLabel; elapsedSec: number; color?: string }): string {
  const sec = Math.max(0, Math.floor(o.elapsedSec))
  const header = o.label.project ? o.label.client : ''
  const main = o.label.project ?? o.label.client
  return (
    SHELL() +
    runMark(14, 13, sec) +
    (header
      ? text(fit(header.toUpperCase(), 24), {
          x: 30,
          y: 21,
          size: 8,
          fill: DISP_DIM,
          weight: 600,
          spacing: 1.1
        })
      : '') +
    readout(formatHm(sec), { x: 14, y: 60, size: 34 }) +
    text(fit(main, 22), { x: 14, y: 82, size: 11, fill: DISP_INK, weight: 500 }) +
    secondsLine(sec, clientBarColor(o.color))
  )
}

/** The app is not running, or hardware keys are switched off. */
function offlineFace(): string {
  return (
    SHELL(OFF_BG) +
    `<circle cx="30" cy="50" r="13" fill="none" stroke="${OFF_INK}" stroke-width="2.5"/>` +
    `<line x1="21" y1="59" x2="39" y2="41" stroke="${OFF_INK}" stroke-width="2.5" stroke-linecap="square"/>` +
    text('TimeTrack offline', { x: 54, y: 47, size: 15, fill: DISP_DIM, weight: 600 }) +
    text('Settings → Integrations', { x: 54, y: 66, size: 11, fill: OFF_INK })
  )
}

/** Bridge answers, but there is nothing to start yet. */
function emptyFace(): string {
  return (
    SHELL() +
    text('No clients yet', { x: 100, y: 48, size: 16, fill: DISP_INK, weight: 600, anchor: 'middle' }) +
    text('Add one in TimeTrack', { x: 100, y: 70, size: 11, fill: DISP_DIM, anchor: 'middle' })
  )
}

export type DialFace =
  | { state: 'offline' }
  | { state: 'empty' }
  | {
      state: 'stats'
      todaySeconds: number
      weekSeconds: number
      label: DialLabel | null
      position: string
      color?: string
    }
  | {
      state: 'browse'
      label: DialLabel
      position: string
      progress: number
      color?: string
      running: boolean
    }
  | { state: 'running'; label: DialLabel; elapsedSec: number; color?: string }

/** 200x100 touch-strip face as a data: URL for the layout's `canvas` pixmap. */
export function dialImage(face: DialFace): string {
  switch (face.state) {
    case 'offline':
      return dataUrl(offlineFace())
    case 'empty':
      return dataUrl(emptyFace())
    case 'running':
      return dataUrl(runningFace(face))
    case 'browse':
      return dataUrl(browseFace(face))
    default:
      return dataUrl(statsFace(face))
  }
}
