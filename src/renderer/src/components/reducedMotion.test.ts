/**
 * DESIGN.md promises that `prefers-reduced-motion` stops the blink and any
 * animation. Every class that runs a CSS animation in the two renderer style
 * sheets must therefore be set to `animation: none` inside a reduced-motion
 * block (owner review PR 5b: `.view-enter` was not).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const ASSETS = join(__dirname, '..', 'assets')

function animatedSelectors(css: string): string[] {
  const out: string[] = []
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const body = m[2]
    if (/animation\s*:\s*(?!none)/.test(body)) out.push(m[1].trim())
  }
  return out
}

function stoppedSelectors(css: string): string[] {
  const out: string[] = []
  for (const block of css.matchAll(
    /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{((?:[^{}]*\{[^{}]*\})*)\s*\}/g
  )) {
    for (const m of block[1].matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (/animation\s*:\s*none/.test(m[2])) out.push(m[1].trim())
    }
  }
  return out
}

describe('reduced motion stops every CSS animation', () => {
  for (const file of ['base.css', 'main.css']) {
    it(file, () => {
      const css = readFileSync(join(ASSETS, file), 'utf8')
      const stopped = stoppedSelectors(css)
      const animated = animatedSelectors(css).filter((s) => !s.startsWith('@'))
      expect(animated.length).toBeGreaterThan(0)
      for (const sel of animated) expect(stopped, sel).toContain(sel)
    })
  }
})
