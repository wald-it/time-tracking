/**
 * TimeTrack Stream Deck — Tastenflächen im Messinstrument-Design (#363).
 *
 * Ersetzt svgImage() aus src/actions/toggle-timer.ts (#133).
 * Vier Zustände: running | idle | unset | offline.
 * Farben und Schriften aus design/messinstrument/HANDOFF.md (§2.1, §2.2).
 *
 * Keine Abhängigkeiten. Reines SVG als data:-URL für key.setImage().
 */

// ── Farb-Helfer (sRGB <-> OKLab) ────────────────────────────────────────────

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '')
  if (h.length === 3)
    h = h
      .split('')
      .map((c) => c + c)
      .join('')
  const n = parseInt(h.slice(0, 6), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

const srgbToLin = (c: number): number => {
  const x = c / 255
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)
}

const linToSrgb = (x: number): number => {
  const c = x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055
  return Math.round(Math.min(1, Math.max(0, c)) * 255)
}

function rgbToOklab(rgb: [number, number, number]): [number, number, number] {
  const R = srgbToLin(rgb[0]),
    G = srgbToLin(rgb[1]),
    B = srgbToLin(rgb[2])
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B)
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B)
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  ]
}

function oklabToHex(lab: [number, number, number]): string {
  const [L, a, b] = lab
  const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3)
  const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3)
  const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3)
  const R = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
  const G = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
  const B = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  return '#' + [R, G, B].map((v) => linToSrgb(v).toString(16).padStart(2, '0')).join('')
}

/** App-Akzent (dark mode) als Fallback für fehlende/ungültige Kundenfarben. */
const ACCENT_FALLBACK = '#8b7cf8'

/**
 * Zieht eine beliebige DB-Kundenfarbe auf eine tastentaugliche Helligkeit:
 * OKLab L = 0.65, Chroma = 0.15, Hue bleibt. Damit hat weiße Schrift auf der
 * Running-Fläche immer >= 4.5:1 — auch bei Pastellgelb oder Neonpink.
 * Graustufen (C < 0.02) bleiben neutral.
 */
export function normalizeKeyColor(hex?: string): string {
  const raw = hex && /^#[0-9a-fA-F]{3,8}$/.test(hex) ? hex : ACCENT_FALLBACK
  const [, a, b] = rgbToOklab(hexToRgb(raw))
  const C = Math.hypot(a, b)
  if (C < 0.02) return oklabToHex([0.65, 0, 0])
  const k = 0.15 / C
  return oklabToHex([0.65, a * k, b * k])
}

/** Lightness skalieren, Hue/Chroma behalten. Geteilt mit dialImage.ts (#186). */
export function scaleL(hex: string, f: number): string {
  const [L, a, b] = rgbToOklab(hexToRgb(hex))
  return oklabToHex([Math.max(0.05, Math.min(0.92, L * f)), a, b])
}

// ── Messinstrument-Tokens (#363) ───────────────────────────────────────────
// Die Taste ist das Display-Fenster der App: dunkel in beiden Themes. Werte
// aus design/messinstrument/HANDOFF.md §2.1, geteilt mit dialImage.ts.

export const DISP = '#1b1b19'
export const DISP_INK = '#edebe4'
export const DISP_DIM = '#8f8c83'
export const DISP_LINE = '#3a3935'
/** Signal: heißt nur „läuft“ (Handoff §1.3). */
export const SIG = '#e2551f'
export const OFF_BG = '#141413'
export const OFF_INK = '#55534d'

/**
 * Kundenfarbe als schmale Leiste: auf tastentaugliche Helligkeit gezogen,
 * damit auch sehr dunkle Kundenfarben auf dem Display sichtbar bleiben.
 * Ohne gültige Farbe eine neutrale Leiste statt eines erfundenen Akzents.
 */
export function clientBarColor(hex?: string): string {
  if (!hex || !/^#[0-9a-fA-F]{3,8}$/.test(hex)) return DISP_LINE
  return normalizeKeyColor(hex)
}

/**
 * Fill for a progress line drawn over a `DISP_LINE` track: the client colour,
 * or the dim display colour when there is none, never the track colour itself.
 */
export function progressColor(hex?: string): string {
  const c = clientBarColor(hex)
  return c === DISP_LINE ? DISP_DIM : c
}

// ── Typografie ─────────────────────────────────────────────────────────────
// Im Key-SVG ist keine Font eingebettet: Archivo und IBM Plex Mono greifen nur,
// wenn sie installiert sind, sonst die Systemschriften dahinter.

export const FONT = 'Archivo, Segoe UI, Helvetica, Arial, sans-serif'
export const MONO = 'IBM Plex Mono, Consolas, Menlo, monospace'

// ── Bausteine ──────────────────────────────────────────────────────────────

const SHELL = (fill: string = DISP): string =>
  `<rect x="0" y="0" width="144" height="144" rx="18" fill="${fill}"/>`

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function dataUrl(inner: string): string {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">' +
    inner +
    '</svg>'
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

/** h:mm — minutengenau; die Sekunden zeigt das Signalquadrat als Takt. */
function formatElapsed(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}`
}

export interface KeyLabel {
  /** Kleine Kopfzeile (Kunde, wenn ein Projekt gesetzt ist — sonst leer). */
  header: string
  /** Hauptzeilen (Projekt wenn gesetzt, sonst Kunde), max. 3. */
  lines: string[]
}

export type KeyState = 'idle' | 'running' | 'unset' | 'offline'

// ── Textzeilen ─────────────────────────────────────────────────────────────

/** Legende: Archivo-Versalien, gesperrt, gedimmt. */
function legend(text: string, x: number, y: number, anchor: 'start' | 'middle' = 'start'): string {
  if (!text) return ''
  return `<text x="${x}" y="${y}" font-family="${FONT}" font-size="13" font-weight="600" letter-spacing="1.6" fill="${DISP_DIM}" text-anchor="${anchor}">${escapeXml(text.toUpperCase())}</text>`
}

/**
 * Legends are capitals with 1.6 px tracking at 13 px: about 10.5 px a
 * character, so 10 characters fit from x 16 inside the 144 px key. There are
 * no font metrics on the deck; the budget is a character count, and a cut
 * name gets an ellipsis rather than running off the key.
 */
export function fitLegend(s: string, maxChars = 10): string {
  if (s.length <= maxChars) return s
  return s.slice(0, Math.max(1, maxChars - 1)).trimEnd() + '…'
}

/** Namenszeilen, zentriert; Startzeile und Abstand je nach Platz. */
function nameLines(lines: string[], fill: string, size: number, ys: number[]): string {
  return lines
    .slice(0, ys.length)
    .map(
      (l, i) =>
        `<text x="72" y="${ys[i]}" font-family="${FONT}" font-size="${size}" font-weight="500" fill="${fill}" text-anchor="middle">${escapeXml(l)}</text>`
    )
    .join('')
}

const BAR = (color: string): string =>
  `<rect x="16" y="126" width="112" height="4" fill="${color}"/>`

// ── Zustände ───────────────────────────────────────────────────────────────

function runningFace(label: KeyLabel, color: string | undefined, elapsedSec: number): string {
  const sec = Math.max(0, Math.floor(elapsedSec))
  const [h, m] = formatElapsed(sec).split(':')
  // One static frame per tick (no SMIL on the deck): the signal square
  // blinks by alternating opacity on the 1 Hz render tick, like the app header.
  const mark = sec % 2 === 0 ? '1' : '0.35'
  const name = label.header || label.lines[0] || ''
  const sub = label.header ? (label.lines[0] ?? '') : ''
  return (
    SHELL() +
    `<rect x="16" y="18" width="10" height="10" fill="${SIG}" opacity="${mark}"/>` +
    legend('running', 34, 27) +
    `<text x="72" y="84" font-family="${MONO}" font-size="40" font-weight="300" fill="${DISP_INK}" text-anchor="middle" letter-spacing="-1">${escapeXml(h)}<tspan fill="${DISP_DIM}">:</tspan>${escapeXml(m)}</text>` +
    (sub
      ? nameLines([name], DISP_DIM, 12, [103]) + nameLines([sub], DISP_INK, 14, [119])
      : nameLines([name], DISP_INK, 15, [114])) +
    BAR(clientBarColor(color))
  )
}

function idleFace(label: KeyLabel, color: string | undefined): string {
  // keyLabel() wraps a client-only name into up to three lines; all of them
  // stay, since the last one is often what tells two clients apart.
  const lines = label.lines.slice(0, 3)
  const size = lines.length === 3 ? 14 : 15
  const ys = lines.length === 1 ? [104] : lines.length === 2 ? [96, 114] : [88, 103, 118]
  return (
    SHELL() +
    legend(fitLegend(label.header) || 'START', 16, 27) +
    `<polygon points="60,${lines.length === 3 ? '36 60,62 82,49' : '40 60,72 86,56'}" fill="none" stroke="${DISP_INK}" stroke-width="4" stroke-linejoin="miter"/>` +
    nameLines(lines, DISP_INK, size, ys) +
    BAR(clientBarColor(color))
  )
}

function unsetFace(): string {
  return (
    SHELL() +
    `<rect x="14" y="14" width="116" height="116" rx="10" fill="none" stroke="${DISP_LINE}" stroke-width="2" stroke-dasharray="6 6"/>` +
    // EN like the plugin's other strings (no i18n in the plugin yet).
    legend('pick a', 72, 66, 'middle') +
    legend('client', 72, 86, 'middle')
  )
}

function offlineFace(label: KeyLabel): string {
  // Keep the client and every wrapped name line: targets must still look
  // different while TimeTrack is closed (two projects of one client, or two
  // clients that differ only in their last word).
  const rows = [label.header, ...label.lines].filter((s) => s).slice(0, 3)
  const ys = rows.length === 1 ? [112] : rows.length === 2 ? [104, 120] : [98, 112, 126]
  return (
    SHELL(OFF_BG) +
    `<circle cx="72" cy="40" r="15" fill="none" stroke="${OFF_INK}" stroke-width="4"/>` +
    `<line x1="61" y1="51" x2="83" y2="29" stroke="${OFF_INK}" stroke-width="4" stroke-linecap="square"/>` +
    legend('offline', 72, 78, 'middle') +
    nameLines(rows, DISP_DIM, 12, ys)
  )
}

/**
 * 144x144 Tastenfläche als data:-URL.
 *
 * @param state       running = Signalquadrat + Uhr, idle = Start-Dreieck,
 *                    unset = gestrichelt, offline = durchgestrichen
 * @param label       aus keyLabel(settings) — unverändert übernommen
 * @param color       rohe Kundenfarbe aus der DB (wird normalisiert)
 * @param elapsedSec  Laufzeit in Sekunden (nur für 'running')
 */
export function keyImage(opts: {
  state: KeyState
  label: KeyLabel
  color?: string
  elapsedSec?: number
}): string {
  const { state, label, color } = opts
  switch (state) {
    case 'running':
      return dataUrl(runningFace(label, color, opts.elapsedSec ?? 0))
    case 'unset':
      return dataUrl(unsetFace())
    case 'offline':
      return dataUrl(offlineFace(label))
    default:
      return dataUrl(idleFace(label, color))
  }
}
