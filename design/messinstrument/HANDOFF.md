# TimeTrack UI overhaul — "Messinstrument" (handoff)

**Status:** design approved by the owner (Design Council) on 2026-10-22 · ready for implementation
**Amended 2026-10-22 (owner):** header stages for narrow windows (§3.1), one rounding rule (§2.2), Heute with preset keys and a project list instead of the fan (§3.11, §4.1, B1).
**Replaces:** v1.8 Glass Design System (#76, `design/issue-76-glass-reference.html`)
**Scope of the mockups:** App shell + **Heute**, **Kalender**, **Auswertung** — light ("Papier") and dark ("Graphit")
**Everything else** (Kunden, Export, Einstellungen, modals, mini widget …) gets the new tokens and follows the vocabulary below — no separate mockups.

## What is in this folder

| File | Use it for |
| --- | --- |
| `HANDOFF.md` | This spec. Read §1–§3 before touching code. |
| `tokens.css` | Drop-in token layer: new tokens (`:root` = Papier, `.dark` = Graphit) **plus legacy aliases** for the Glass names. |
| `reference.html` | Static render of the three screens with the exact markup and inline values. Open in a browser, inspect in DevTools. Theme toggle in the top bar. **Sample data, no behaviour.** |
| `screens/*.png` | 1280 px screenshots of each screen in both themes — the visual target. |
| `screens/heute-speichertasten-*.png` | **Target layout of Heute from PR 5:** preset keys under the display, project list open. Supersedes the lower half of `heute-*.png` (side column). |
| `source/*.dc.html` | The interactive canvas source (needs the canvas runtime, so not directly runnable). Read it for the logic behind the mockups: day-scale math, tick generation, running-state switching. `HeuteSpeicher.dc.html` holds the preset keys incl. hold-to-open and the project list. |

The interactive prototype lives on Robin's design canvas (claude.ai, private). The PNGs and `reference.html` are the authoritative copies for implementation.

---

## 1. Why, and the rules that follow from it

Glass (blur, translucency, glow blobs, violet accent) read as generic. The new direction treats TimeTrack as a **precision instrument**: a lab counter / Braun-era device. Calm chassis, one dark readout window, scales with tick marks, monospace figures, a single signal colour.

Seven rules. If a decision is unclear, these decide it:

1. **No glass.** No `backdrop-filter`, no translucent surfaces, no glow shadows, no ambient blobs, no gradient backgrounds. The only `repeating-linear-gradient` allowed is the 135° **hatch texture** (running entries and non-billable time).
2. **Hairlines and rules instead of cards.** A section starts with a **2 px `--ink` rule**, then a small caps legend. Rows are separated by 1 px `--line`. Raised surfaces exist only for **keys** (buttons) and the **display**.
3. **Signal is not an accent.** `--sig` (orange) means *running / now* and nothing else: the running dot, the "Läuft" status, the needle, today's marker, the STOPP glyph, the active-nav bar and the focus ring. Primary actions are **ink keys**, not orange buttons.
4. **Numbers are instruments.** Every duration, time, money amount and count is set in **IBM Plex Mono** with tabular figures. Large readouts use weight 300.
5. **Time is drawn as a scale.** Wherever a day appears (Heute, every calendar cell), it is a ruler from 07 to 20 h with the entries placed at their real clock time — gaps are breaks.
6. **Colour never carries meaning alone.** Client colours always sit next to the client name; deltas carry an arrow glyph; the running entry is hatched *and* labelled.
7. **Accessible as drawn.** Text ≥ 4.5:1 (`--ink3` is the lightest text colour allowed on `--bg`), hit targets ≥ 44 px in the main window, 2 px focus ring, real `<button>`/`<a>`/`<table>` elements, `prefers-reduced-motion` respected.

---

## 2. Foundations

### 2.1 Colour

All values are in `tokens.css` (with the computed contrast table). Theme switching stays as it is: `ThemeContext` toggles `.dark` on `<html>` (light / dark / system).

| Token | Papier | Graphit | Role |
| --- | --- | --- | --- |
| `--bg` | `#E8E6DF` | `#141413` | Chassis = page background (solid) |
| `--key` | `#F3F2EC` | `#1E1E1C` | Keys, hovered row, selected cell, inputs |
| `--key-edge` | `#C9C6BC` | `#34332F` | Key border + 2 px bottom keycap edge |
| `--line` | `#CBC8BE` | `#2E2D2A` | Hairlines |
| `--tick` | `#8F8B80` | `#66635C` | Scale ticks, graticule, non-billable hatch |
| `--ink` | `#191917` | `#E9E7E0` | Primary text, section rules, baselines |
| `--ink2` | `#4A4843` | `#B5B2A8` | Secondary text, legends |
| `--ink3` | `#5E5B54` | `#8E8B82` | Hints / metadata (lightest text allowed) |
| `--disp` / `--disp-ink` / `--disp-dim` / `--disp-line` | `#1B1B19` / `#EDEBE4` / `#8F8C83` / `#3A3935` | `#0B0B0A` / same / same / `#2A2926` | Display window — dark in **both** themes |
| `--inv` / `--inv-ink` / `--inv-dim` | `#191917` / `#F3F2EC` / `#8F8C83` | `#E9E7E0` / `#141413` / `#55534D` | Inverse key (STOPP, active segment) |
| `--sig` / `--sig-ink` | `#E2551F` / `#191917` | same | Signal + text placed on it |
| `--danger` | `#A8261B` | `#EF7A72` | Destructive (a different hue from `--sig` on purpose) |

**Client colours stay user data** (`clients.color` / `projects.color`). The mockups use a validated demo set (`--demo-c1…4`); the stored presets are not touched in this overhaul (see §8).

### 2.2 Typography

Fonts are bundled. The CSP (`default-src 'self'`) rules out Google Fonts, so install them as packages:

```bash
pnpm add @fontsource-variable/archivo @fontsource/ibm-plex-mono
```

```ts
// src/renderer/src/main.tsx AND src/renderer/src/mini.tsx
import '@fontsource-variable/archivo/wdth.css' // family 'Archivo Variable', wght 100–900, wdth 62–125 %
import '@fontsource/ibm-plex-mono/300.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource/ibm-plex-mono/600.css'
```

Import **`wdth.css`**, not `index.css`: only `wdth.css` carries the width axis that the expanded legends need (`font-stretch`). This was checked against `@fontsource-variable/archivo@5.3.0`. Remove `@fontsource-variable/inter` and `@fontsource/jetbrains-mono` in the cleanup PR, once nothing references them.

| Style | Family | Size / weight | Extras |
| --- | --- | --- | --- |
| Timer digits (HH, MM) | Plex Mono | `clamp(64px, 9vw, 128px)` / 300 | line-height .86, letter-spacing −0.03em, colon in `--disp-dim` |
| Timer seconds | Plex Mono | `clamp(30px, 4vw, 52px)` / 300 | `--disp-dim`, aligned to digit baseline, prefixed `:` |
| KPI readout (Auswertung) | Plex Mono | 56px / 300 | −0.03em; unit in Archivo 15px `--ink2` |
| Readout L (Heute total, Monatssumme) | Plex Mono | 44px / 300 | −0.02em; unit "h" 13px `--ink2` |
| Readout M (Woche, selected day) | Plex Mono | 28px / 300 (24px in calendar panel) | |
| View title (month) | Archivo | 44px / 600, `font-stretch: 112%` | −0.01em; year in Plex Mono 28px/300 `--ink3` |
| Section title (date) | Archivo | 20px / 600, `font-stretch: 108%` | |
| **Legend** (section labels, units) | Archivo | 11px / 600, UPPERCASE, `letter-spacing: .14em`, `font-stretch: 118%` | `--ink2`; table headers 10px `--ink3` |
| Body | Archivo | 14px / 400, line-height 1.45 | |
| Secondary / meta | Archivo | 12–13px | `--ink2` / `--ink3` |
| Small figures (times, durations in lists) | Plex Mono | 11–14px / 400–600 | `font-variant-numeric: tabular-nums` always |
| Wordmark "TIMETRACK" | Archivo | 12px / 800, `.2em`, `font-stretch: 125%` | |

Duration formats stay as today: `H:MM` for completed durations, `H:MM:SS` for the running one, `HH:MM` for clock times.

**One rounding rule (owner 2026-10-22).** Large numbers are worked time. Wherever a rounded value appears ("gerundet … h", tooltips, `get_summary`'s `*_rounded_seconds`), it is computed **per entry, like the invoice** (`billedMinutes`), and then summed. Never round a sum. The only exception is the legacy `*_display_seconds` in `get_summary`, which is kept for installed Stream Deck plugins.

### 2.3 Shape, spacing, layout

- **Radii:** keys 4 px · display 6 px · tags/marks 0–2 px. Nothing is pill-shaped any more.
- **Elevation:** none, except the keycap edges: `inset 0 -2px 0 var(--key-edge)` on keys and `inset 0 -4px 0 rgb(0 0 0 / .3)` on the big STOPP/START key.
- **Content column:** `max-width: 1440px` (up to 1360 px of content; changed from 1200 px during implementation, owner 2026-10-22 — the 1280 px screenshots remain the reference), side padding 40 px, top 36–40 px, bottom 64 px. Header and views share one column class (`.mi-column`). Gap between sections 48 px (Heute) / 32 px (header → body).
- **Section pattern:** `border-top: 2px solid var(--ink); padding-top: 14px;` → legend row (legend left, meta right) → content.
- **Rows:** 56–58 px tall in tables, 1 px `--line` between rows.
- **Wrapping:** two-column areas use `flex-wrap` with `flex: 999 1 <min>` (main) / `flex: 1 1 <min>` (side). They stack below roughly 900 px window width, so nothing needs a breakpoint. **Rule: the flex basis is at least the content's minimum width** — otherwise the content scrolls before its neighbour wraps (the entry table: basis 640 px = its `min-width`).

### 2.4 Interaction states

| State | Treatment |
| --- | --- |
| Key hover | `outline: 1px solid var(--ink3); outline-offset: 2px` |
| Key active | `transform: translateY(1px)` |
| Row hover | `background: var(--key)` |
| Icon button hover | `color: var(--ink); background: var(--key)` |
| Focus-visible (everything) | `outline: 2px solid var(--sig); outline-offset: 2px` |
| Selected (calendar day) | `background: var(--key); box-shadow: inset 0 0 0 1px var(--ink)` |
| Disabled | out-of-month days: `disabled`, number in `--ink3`, no scale |

### 2.5 Motion

- Running indicator square: hard blink, `1s steps(1)`, 100 % → 25 % opacity. Off under `prefers-reduced-motion`.
- View enter: keep the existing 180 ms opacity fade (`.view-enter`).
- Everything else is instant. No bounce, no glow pulse. The quick-start fan animation (`qs-fan-*`) may stay, minus its blur backdrop (§6, B1).

### 2.6 Icons

Same approach as today: inline SVG, `currentColor`, stroke 1.4–1.6, square caps. New glyphs used in the mockups: logo mark (dial with a `--sig` needle), stop square, play triangle, plus, pencil, trash, calendar, chevrons, and the delta triangle (up/down). Glyph markup is in `reference.html`.

---

## 3. Components

Names are suggestions. Map them onto existing components where one already exists.

### 3.1 AppHeader (replaces the pill nav in `App.tsx`)
- 64 px tall, `border-bottom: 1px solid var(--line)`, background `--bg`. Inner row uses the shared content column (`.mi-column`, see §2.3).
- Left: logo mark (22 px) + wordmark.
- Nav: text links, 44 px tall, 14 px, `--ink2` / weight 500. Active: `--ink` / 600, plus a **3 px `--sig` bar** spanning the label, flush with the header's bottom edge. Use `aria-current="page"`.
- Right, when running — **RunningReadout:** 8 px `--sig` square (blinking) · client short name (13px `--ink2`) · `H:MM:SS` (Plex Mono 15/500) · 44 px stop key (key style, 12 px `--ink` square glyph).
- Right, when idle: key "▶ Timer starten" (existing `StartTimerModal`).
- Remove the ambient blobs and all `backdrop-blur`.
- **Narrow windows (owner 2026-10-22):** the header stays one line from 760 px up, in both states and in both languages. Collapse in this order, using container queries on the header (no JS):
  0. Always: client name in the RunningReadout max. 160 px with ellipsis; full name in `title`/`aria-label`.
  1. `< 1140 px`: hide the client name (dot · time · stop); the stop key's label becomes "Timer stoppen – <Kunde>".
  2. `< 960 px`: logo mark only; the wordmark is visually hidden and the logo gets `aria-label="TimeTrack"`.
  3. `< 840 px`: "Timer starten" becomes a 44 px icon key (`aria-label` + `title`); header gaps 32 → 16 px, nav padding 14 → 10 px, `.mi-column` side padding 40 → 24 px (header and views together, so the edges stay aligned).

  Measured (Archivo/Plex, DE): logo + wordmark 147 px, nav 527 px (EN 472), start key 130 px, readout with a 22-character name 292 px / without name 139 px / from 10 h 148 px. At 760 px: idle ≈ 625 px, running ≈ 729 px. Check at 760/840/960/1140/1440 px, idle and running, DE and EN, timer ≥ 10 h: the header stays 64 px tall.

### 3.2 Display (the readout window) — Heute hero
- `background: var(--disp); color: var(--disp-ink); border: 1px solid var(--disp-line); border-radius: 6px; padding: 22px 28px 24px;` · vertical gap 20 px.
- Row 1: status — 8 px square + legend. Running: `--sig` square (blink) + "LÄUFT · SEIT 14:05" in `--sig`. Idle: `--disp-dim` square + "BEREIT". Right side, legend in `--disp-dim`: running "TAKT 15 MIN · GERUNDET 3:00 H" (from `RoundingContext`; hide when rounding is off). Idle: the hotkey hint.
- Row 2: digits. Three flex columns (HH · colon · MM) plus a seconds column, `align-items: flex-end`. Under each column sits a 10 px legend in `--disp-dim`: STD / MIN / SEK. When idle, show `00:00 :00`.
- 1 px `--disp-line` divider.
- Row 3: client colour square (10 px) · client name 15/600 · "· Projekt" in `--disp-dim`. Row 4: description 14px, or "Ohne Beschreibung – wird beim Stopp abgefragt" in `--disp-dim` when empty (the QuickNote modal still fires on stop). Tags as outlined legend chips (`1px var(--disp-line)`).
- `role="timer"`. Do **not** add `aria-live`, because announcing every second is noise.

### 3.3 BigKey (STOPP / START)
- 148 px wide, full height of the display row (≥ 200 px), radius 6, keycap edge `--edge-bigkey`.
- Running: `--inv` background, 30 px `--sig` square glyph, legend "STOPP" (13px, `.22em`), hotkey below in Plex Mono 11px `--inv-dim`. In Graphit the key turns light (`--inv` flips), which is intended.
- Idle: `--sig` background, `--sig-ink` play triangle + "START" + hotkey.
- The hotkey label shows the **configured** global hotkey from settings, not a hard-coded "Alt ⇧ S".

### 3.4 Key (secondary button)
- `background: var(--key); border: 1px solid var(--key-edge); border-radius: 4px; box-shadow: var(--edge-key);` min-height 40–44 px, 13px/600, optional 12 px leading icon.
- Icon-only variant: 44 × 44 px with an `aria-label`.

### 3.5 Segmented control (Wochen | Monate)
- Container: `--key` background, 1 px `--key-edge` border, radius 4, padding 3, gap 3.
- Segment: 36 px tall, radius 2. Active: `--inv` / `--inv-ink`. Inactive: transparent / `--ink2`. `aria-pressed`.

### 3.6 Readout (stat)
- Legend → value (Plex Mono, light) + unit → optional sub-line (12px `--ink3`, e.g. "gerundet 8:00 h · 15-min-Takt").
- KPI variant (Auswertung) adds a delta line: triangle glyph (rotated 180° for negative), delta in Plex Mono 600 (`+6,1 %`, `−2 pp`), "vs. <previous value>" in `--ink3`. Deltas stay ink-coloured, with no red or green.

### 3.7 WeekMeter (Heute, beside the readouts)
- 7 columns, gap 6. Track 60 px = 10 h, with graticule `repeating-linear-gradient(to top, var(--line) 0 1px, transparent 1px 12px)` (one line per 2 h).
- Bars square-ended. Past days `--ink2`, **today `--sig`**, future days empty. Day labels in Plex Mono 11px (`--ink3`; today in `--ink`). The `title` carries the exact value.
- Respect the `week_start` setting (`useWeekStart`).

### 3.8 DayScale — the signature element (Heute)
- Container 100 px tall, inset 12 px left and right so the edge labels fit.
- **Range:** 07:00–20:00 by default. Extend to whole hours if an entry (or "now") falls outside: `start = min(07, floor(earliest))`, `end = max(20, ceil(latest or now))`.
- **Entry bars:** top 22 px, height 40 px, radius 1, `left/width` in % of the range. Completed entries are solid client colour. The running entry uses the hatch `repeating-linear-gradient(135deg, <c> 0 5px, transparent 5px 8px)` plus `box-shadow: inset 0 0 0 1px <c>`. Each bar is a `<button>` that opens the existing edit form; `aria-label`/`title` = "08:10–09:40 · Client · Project".
- **Baseline:** 1 px `--ink` at 62 px.
- **Ticks** hang below the baseline, every 15 min: hour 14 px, half-hour 9 px, quarter 5 px, colour `--tick`. Ticks after *now* get opacity .35.
- **Hour labels:** Plex Mono 11px, centred on the hour tick at 80 px. Before now `--ink2`, after now `--ink3`.
- **Needle:** 2 px wide, from 16 px to 78 px. Running: `--sig` with a chip on top (Plex Mono 11/600, `--sig` background, `--sig-ink` text, "16:52"). Idle: `--ink` with a `--bg` chip text.
- **Legend** (top right of the section): per client, square + short name + day total (Plex Mono, `--ink2`).
- Updates once per second while running (needle, running bar width, totals). Use **one** 1 s tick for the whole view, for example by lifting the interval that `ActiveTimerPill` runs today. Do not give every component its own interval.

### 3.9 MiniDayScale (calendar cell)
- 14 px tall: bars 8 px at top, baseline 1 px `--line` at 9 px, ticks 4 px at 08/10/12/14/16/18 in `--tick`.
- Today: running entry hatched (3/2 px), plus a 2 px `--sig` needle 17 px tall at *now*.
- Same range logic as DayScale, but use one shared range for the whole month so that cells compare.

### 3.10 EntryTable (Heute)
- Real `<table>`. Columns: **Zeit** (Plex Mono 13, `--ink2`, `08:10–09:40`, running `14:05–`) · **Kunde · Projekt** (10 px colour square, name 14/600, project 12px `--ink2`) · **Beschreibung** (14px, tags as legend chips) · **Dauer** (Plex Mono 14, right; running in 600 and live `H:MM:SS`) · actions (edit + delete, 44 px icon buttons, `--ink3`).
- The running row shows no delete button, but keeps a spacer so the columns stay aligned. Today's app already blocks deleting a running entry.
- Newest first. Header legends 10px `--ink3`. The table sits in an `overflow-x: auto` box with a min-width of 640 px.

### 3.11 QuickStart — preset keys + project list (Heute, from PR 5)
Supersedes the side-column keys and the radial fan (#96). Target: `screens/heute-speichertasten-*.png`, logic in `source/HeuteSpeicher.dc.html`.
- **Position:** a section directly under the hero row (the preset keys of the instrument, like a radio's station presets), *above* the Tagesverlauf, 32 px below the hero. At 1280 × 860 the keys sit at ≈ 480–545 px, so no scrolling is needed. Section pattern; legend "SCHNELLSTART" + meta "h · 30 Tage" on the left, the hint (12px `--ink3`) on the right.
- **Grid:** `repeat(auto-fit, minmax(min(260px, 100%), 1fr))`, gap 12. Three keys (`topClients30d`) → 3 / 2 / 1 per row depending on width.
- **Split key:** one key container (`--key`, 1 px `--key-edge`, radius 4, keycap edge).
  - **Main area** (min-height 64): colour square 12 px · client name 14/600 over the last project 12px `--ink2` (single lines, ellipsis) · right: 30-day hours (Plex Mono 12 `--ink2`), or while a timer runs on this client: blinking 7 px `--sig` square + legend "LÄUFT", and the sub-line shows the running project. **Click** starts the last used project, and while a timer runs it switches immediately (B1).
  - **▾ segment** (48 px wide, 1 px `--key-edge` left border, `aria-expanded`): opens the project list. **Press and hold** the main area for 300 ms opens it too (muscle memory from #96). The hold feedback is a 3 px `--ink` bar filling along the key's bottom edge — no glow, no scaling.
- **Project list (overlay, does not push content):** `position: absolute`, directly under the key, same width, `z-index` above the Tagesverlauf. While open, the key and the list share a **1 px `--ink` frame** (the key's bottom corners square, list bottom corners radius 4); no shadow. Background `--key`. Content:
  - Legend "PROJEKT WÄHLEN" (10px `--ink3`).
  - One row per active project of the client, 44 px: 8 px colour square · name 14px (600 while running) · right: "LÄUFT" with the `--sig` square for the running project, an outlined legend chip "ZULETZT" for the last used one, otherwise an action "starten" / "wechseln" (Plex Mono 11 `--ink3`) visible on hover/focus. Rows are separated by 1 px `--line`.
  - "Kein Projekt" as the last row: dashed separator above, outlined square, `--ink2`.
  - Footer (Plex Mono 11 `--ink3`): "↑↓ wählen · ↵ starten · Esc zu".
  - Opens downwards, and flips upwards only if there is no room below. **Keyboard:** Enter/Space/↓ on the ▾ segment opens it; ↑↓ move, Enter starts, Esc closes and returns focus to the ▾ segment. A click outside closes. Only one list is open at a time.
- Inactive client: key disabled with `title` "Kunde inaktiv" (as today). A client without projects: no ▾ segment, the main area alone.
- The radial fan code (`getRingPositions`, `fanShift`, `qs-*` keyframes, beam gradients) is deleted.

### 3.12 Calendar grid
- CSS grid `72px repeat(7, minmax(0, 1fr))`. Header row: legends ("KW", "MO" … "SO"; weekend `--ink3`) with a `2px --ink` bottom rule.
- KW cell: week number Plex Mono 20/300 at the top, week total Plex Mono 12 `--ink2` at the bottom ("–" if empty).
- Day cell = `<button>`, min-height 104 px, padding 10, `border-left`/`border-top: 1px var(--line)`, square corners. Top row: day number (Plex Mono 13/500) left, day total (Plex Mono 12 `--ink2`) right. Bottom: MiniDayScale.
- Today: `border-top: 2px solid var(--ink)`; day number on a `--sig` chip with `--sig-ink` text.
- Selected: see §2.4. `aria-pressed`, `aria-label` = "Mittwoch, 21. Oktober, 9:05 Stunden".
- Keep the existing keyboard navigation from v1.2.
- Footnote under the grid (12px `--ink3`): "Skala je Tag 07–20 Uhr · schraffiert = läuft".

### 3.13 Day panel (Kalender, right column — replaces the overlay drawer at wide widths)
- Section pattern, legend "AUSGEWÄHLTER TAG". Then date (18/600, `font-stretch: 106%`) on the left and the total readout (Plex Mono 24/300) on the right.
- Entry list (`<ol>`), each item: time range (Plex Mono 12 `--ink2`) + duration (Plex Mono 13) on one line → square + client 13/600 + "· Projekt" → description 13px. 1 px `--line` between items.
- Full-width key: "+ Eintrag für 21.10. nachtragen".
- Inline edit reuses the existing `CalendarDrawer` / `EntryEditForm` content.

### 3.14 Client breakdown (Kalender, below the day panel)
- Per client: square · name 13/600 · share % (Plex Mono 12 `--ink3`) · hours (Plex Mono 13). Below it a 4 px track (`--line`) with a fill in the client colour, **width = share of the month total**.

### 3.15 Charts (Auswertung)
Shared rules: one y-axis per chart (**never dual-axis**), gridlines 1 px dotted `--line`, baseline 1 px `--ink`, axis labels Plex Mono 11 `--ink3`, values in ink (never in the series colour), a legend whenever there are ≥ 2 series, and a `title` or aria value on every mark.

- **Stunden nach Kunde:** grid `170px | 1fr | 72px | 88px`, no column gap (so hairlines run through). Ruler axis on top: 0…max in steps of 10 h with 5 h minor ticks, ticks hanging up from a 1 px `--ink` line. Max = next multiple of 10 above the largest client. Bars 18 px, client colour, square. Hours (Plex Mono 14) and revenue (Plex Mono 13; a non-billable client shows "intern" in `--ink3`). Rows 52 px with 1 px `--line`.
- **Wochentag-Schnitt:** axis 0–10 h every 2 h. 7 bars, 56 % of the column width, `--ink2`, value label above each bar (Plex Mono 11 `--ink2`). Weekend labels `--ink3`.
- **Verlauf (12 Monate / 12 Wochen):**
  - **Cursor readout** above the chart: a display strip (`--disp`) with cells "ZEIGER" (legend in `--sig`) + period name, then STUNDEN / ABRECHENBAR / QUOTE / UMSATZ (legends `--disp-dim`, values Plex Mono 20). It defaults to the latest period and follows hover/focus on a column. `aria-live="polite"`.
  - **Band 1 — Stunden:** stacked columns, 38 % width, billable `--ink` at the bottom, non-billable hatched `--tick` on top, **2 px gap** between the segments. Axis 0/40/80/120/160 h.
  - **Band 2 — Umsatz:** a separate band below the hours band with its own axis (0/10/20 T€). 2 px `--ink2` line + 10 px `--ink2` dots ringed 2 px in `--bg`. This replaces the right-hand axis of today's `TrendChart`.
  - **Columns:** one `<button>` per period spanning both bands (hover/focus/click sets the cursor). The active column gets `color-mix(in srgb, var(--ink) 6%, transparent)` and a 1 px `--sig` cursor line. X labels Plex Mono 12 (active: `--ink`/600), with the year under January and the first column.
  - The legend row sits above the bands: ■ abrechenbar · ▨ nicht abrechenbar · — Umsatz.

---

## 4. Screens

Match against `screens/*.png` (1280 px wide). All copy is German in the mockups; it goes through the locale files (de + en) as usual.

### 4.1 Heute — `screens/heute-papier.png`, `screens/heute-graphit.png` (PR 2) → `screens/heute-speichertasten-*.png` (from PR 5)
1. **Hero row** (flex-wrap, gap 24): Display (`flex: 999 1 520px`) · BigKey (`0 0 148px`) · Summen column (`1 1 260px`, section pattern): **HEUTE** readout L + "gerundet … · 15-min-Takt" → 1 px `--line` → **WOCHE · KW nn** readout M → WeekMeter.
2. **Schnellstart** (from PR 5, §3.11): preset keys directly under the hero, 32 px gap.
3. **Tagesverlauf** (section pattern): legend + date title on the left, client legend on the right → DayScale.
4. **Einträge heute** — from PR 5 at **full width** (no side column any more). EntryTable header: legend "EINTRÄGE HEUTE" + count, key "+ Eintrag nachtragen" on the right. Until PR 5: lower row as merged in PR 2 (table `999 1 640px` · QuickStart aside `1 1 300px`).
5. **Empty/idle states:** no timer → Display "BEREIT" + START key, DayScale needle in `--ink`. No entries today → table replaced by the existing empty strings (`today.recent.empty` / `emptyHint`). Loading → keep the skeleton, re-styled as hairline blocks. No frequent clients → no Schnellstart section.

**Data needed**
- `DashboardSummary` has `todaySeconds`, `weekSeconds`, `recentEntries`, `topClients30d`. **Missing:** the per-day split of the current week, which the WeekMeter needs. Add e.g. `weekDaySeconds: number[]` (7 values in `week_start` order) in `dashboardTotals.ts`. That file is shared with the Stream Deck dial and the MCP `get_summary` bridge, so extend it without changing the existing fields, and add tests next to `dashboardTotals.test.ts`.
- DayScale and the table need **all entries of today** with start/end. Check what `recentEntries` returns today ("last 5" according to the README). If it is not "all of today", add a today list rather than changing `recentEntries` semantics.

### 4.2 Kalender — `screens/kalender-papier.png`, `screens/kalender-graphit.png`
1. **Header row:** legend "KALENDER", title "Oktober" + year, prev/next icon keys, key "Heute" · right side: key "Termine übernehmen" (Graph import, existing) + readout "SUMME OKTOBER".
2. **Body** (flex-wrap, gap 40): Calendar grid (`999 1 680px`, horizontal scroll under 660 px) · aside (`1 1 300px`): Day panel → Client breakdown.
3. Clicking a day selects it, and the panel shows that day. "Heute" selects today. Default selection on open = today. The mockup selects the 21st only to show the "today" and "selected" states side by side.
4. **Below roughly 1100 px window width**, fall back to the existing overlay drawer for the day details (the aside then shows only the client breakdown, below the grid).

**Data needed:** `entries.getByMonth` already returns entries with start/stop, which is enough for MiniDayScale, week totals and the client breakdown.

### 4.3 Auswertung — `screens/auswertung-papier.png`, `screens/auswertung-graphit.png`
1. **Header row:** legend "AUSWERTUNG", month title + prev/next keys · right: comparison note (13px `--ink2`), e.g. "Stand Do 22.10. · verglichen mit dem gleichen Zeitraum im Vormonat (1.–22. September)". For a completed month: "verglichen mit dem Vormonat".
2. **KPI row:** grid `repeat(auto-fit, minmax(min(260px,100%),1fr))`, gap 32: STUNDEN, UMSATZ (or the existing `analytics.noRate` state), ABRECHENBAR.
3. **Middle row** (flex-wrap, gap 48): Stunden nach Kunde (`3 1 520px`) · Wochentag-Schnitt (`2 1 340px`).
4. **Verlauf** (full width): legend + meta, segmented Wochen | Monate, cursor readout, legend row, two bands.
5. The empty state keeps the existing strings and actions, restyled.

**Data needed** (`analyticsHandlers.ts` + `AnalyticsSummary`, with tests in `analyticsHandlers.test.ts`):
- Same-period comparison (§6, B2): when the selected month is the current month, compute `*Prev` over day 1…`daysElapsed` of the previous month (clamped to its length). Either add new fields (`hoursPrevSamePeriod` …) or add a `comparison: 'samePeriod' | 'fullMonth'` flag. Don't silently change meaning without a test.
- `months[]` currently has only `h` and `r`. The stacked band needs a billable split, so add `b`/`n` (seconds) like `weeks[]` has. `weeks[]` lacks revenue, so add `r` there for the revenue band in week mode.

---

## 5. Remaining surfaces (no mockups — follow the vocabulary)

These get the new look through the tokens (PR 1) and are then aligned by hand in the last PR:

- **Kunden, Export, Einstellungen:** section pattern instead of glass cards. Settings rows: label left, control right, hairline between rows. Toggle = 40 × 22 track, `--inv` when on, `--key` with a `--key-edge` border when off, square-ish thumb (radius 2). Inputs = `--key` background, 1 px `--key-edge` border, radius 4, 2 px `--focus` ring.
- **Modals / dialogs:** `--bg` panel, 1 px `--line` border, radius 6, no blur. Backdrop is a plain `rgb(0 0 0 / .35)` wash. Title row with a 2 px `--ink` rule.
- **Toasts / UpdateBanner:** display style (`--disp`, `--disp-ink`), radius 4.
- **Onboarding wizard:** same vocabulary. Step indicator as ticks on a short scale.
- **Mini widget (200 × 40):** `--disp` background, 6 px `--sig` blinking square, Plex Mono time, 28 px key. Import the fonts in `mini.tsx`.
- **Quick-start fan:** see §6, B1.
- **Scrollbar:** thumb `--tick` at 40 %, track transparent; replace the hard-coded `::-webkit-scrollbar-corner #1e293b` with `var(--bg)`.

---

## 6. Behaviour changes (approved with the design)

They are part of the approved design, but they change behaviour, not just looks, so **each one stays switchable on its own: one clearly named switch point in the code, documented in the PR description** (where to change what to get the old behaviour back). Changed from "own commit" during implementation (owner 2026-10-22): the repo squash-merges, so individual commits do not survive the merge anyway, and review fixes spread a change over several commits. Applies to B1–B6.

- **B1 — Quick start while a timer runs = switch; project list instead of the fan.** Today the quick-start keys are disabled while running. New: a click on a preset key's main area stops the running entry and starts that client's last project, and a row in the project list does the same for that project. Both use the same code path as stop + start, so the QuickNote-on-empty-description still fires. The radial fan (#96) is replaced by the project list (§3.11); press-and-hold stays as a way to open it. **Switch point:** the `running` guard in the preset key's click handler (and the list rows) — restoring `disabled={running}` brings back the old lock.
- **B2 — Fair month comparison.** While viewing the *current* month, deltas compare against the same day span of the previous month (see §4.3). Past months compare full month to full month. The header note says which comparison applies.
- **B3 — No dual axis.** The trend chart splits hours and revenue into two bands that share the x-axis.
- **B4 — Calendar day panel + day scales.** A persistent day panel at wide widths instead of the overlay drawer (the drawer stays as the narrow-width fallback). Cells show a time-of-day scale instead of stacked mini-bars. The v1.2 rule "max 5 bars + N overflow" is retired.
- **B5 — Heute lists today.** The table shows all of today's entries, newest first (if that is not already the behaviour).
- **B6 — START key.** Opens the existing `StartTimerModal`, **prefilled with the last used client + project**, so Enter starts. The canvas prototype starts directly. The implementation keeps the modal on purpose.

---

## 7. Rollout (suggested PR sequence)

Work on a feature branch (e.g. `feat/messinstrument-ui`). One PR per step, each shippable:

1. **Foundation — tokens, fonts, de-glass.** Paste `tokens.css` into `base.css` (replacing the Glass blocks, keeping the legacy aliases). Install and import the fonts, and set `body { font-family: var(--font-ui) }`. Delete the ambient blobs, every `backdrop-blur*`/`backdrop-filter`, gradient backgrounds and glow shadows, and replace hard-coded Tailwind palette classes (`indigo-*`, `slate-*`, `emerald-*`, `red-*` …) with tokens. *Result: the whole app in the new palette and fonts, with layouts unchanged.*
2. **App shell + Heute** (§3.1–3.11, §4.1, B5, B6; `dashboardTotals` extension).
3. **Kalender** (§3.9, 3.12–3.14, §4.2, B4) **+ header stages for narrow windows** (§3.1).
4. **Auswertung** (§3.15, §4.3, B2, B3; analytics handler changes + tests).
5. **Align the rest + cleanup** (§5) **+ Heute re-layout with preset keys and project list** (§3.11, §4.1, B1). Delete the legacy alias block and the Inter/JetBrains Mono dependencies. **Rewrite `DESIGN.md`**: the "Design System (v1.8 Glass)" part becomes "Design System (Messinstrument)", built from this file, and the Glass reference is marked superseded. Add a CHANGELOG entry.

Find leftovers with:

```bash
rg -n "backdrop-blur|backdrop-filter|linear-gradient|accent-glow|--blur|indigo-|slate-|emerald-|rounded-full" src/renderer
```

`repeating-linear-gradient` for the hatch is allowed. `rounded-full` is fine for the colour dots only if they are meant to be round; the new vocabulary uses squares.

---

## 8. Definition of done

- [ ] No blur, translucency, glow or gradient background anywhere in the renderer (the grep above is clean, apart from the hatch).
- [ ] Papier, Graphit and "System" all work. No FOUC on start (the preload fix stays intact).
- [ ] No text colour lighter than `--ink3` on `--bg`, and `--sig` is never used for small text on `--bg`.
- [ ] Every interactive element in the main window is ≥ 44 px, reachable by keyboard, and shows the 2 px focus ring. Icon-only buttons have `aria-label`.
- [ ] `prefers-reduced-motion` stops the blink.
- [ ] The DayScale needle, running bar and totals tick live without a second interval.
- [ ] Heute, Kalender and Auswertung match `screens/*.png` at a 1280 px window width in both themes, and stack cleanly at the app's minimum window width.
- [ ] New strings live in the de + en locale files.
- [ ] `pnpm typecheck`, `pnpm lint` and `pnpm test` are green, with **0 skipped**.
- [ ] `DESIGN.md` is rewritten and the CHANGELOG has an entry. The owner map in the vault (`timetrack-architektur.md`) is updated if structure or data flow changed (new summary/analytics fields count).

### Repo guardrails (from CLAUDE.md, repeated because they bite)
- Run tests with `pnpm test`, never `vitest` directly (it refuses to run outside Electron). `better-sqlite3` is N-API since #269: do not add a native rebuild (`electron-rebuild`, `pnpm rebuild`) back.
- A three-digit skip count means a broken environment, not a green run. Report it.
- Repository docs are written in English; code comments and identifiers are English.

---

## 9. Open points (not part of this overhaul)

0. **Project choice — considered and not taken (owner 2026-10-22).** These stay on the canvas for reference only.
   - The radial fan: it cannot be reached by keyboard and its gesture is hidden. Its geometry fights the narrow column (angle hacks, viewport shift), and it crowds beyond about 6 projects.
   - A rotary selector: it has the same space problems and needs a separate keyboard path.
   - An anchored dark popover: it needs positioning and flip logic, and it puts a second dark window on the page next to the display.

1. **Client colour presets.** The 10 stored presets are not colour-blind-safe (DESIGN.md limitation L2). A validated replacement set is possible, but it touches user data, so it needs a separate issue and a decision.
2. **App icon / tray glyph** are still the glass versions (`timetrack_icon_glass_*.svg`). They need a separate design pass.
3. **PDF timesheet template** is unaffected (it has its own accent-colour setting).
4. If Kunden, Export or Einstellungen need **structural** changes beyond restyling, ask for a mockup instead of improvising.
