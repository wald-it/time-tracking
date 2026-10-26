// Renders the app and tray icons from the SVG sources in build/icon-src/.
// - resources/icon.png            1024 px, Linux window icon
// - build/icon.png                1024 px, electron-builder (also the macOS source:
//                                 with no build/icon.icns it derives one from this)
// - build/icon.ico                16/20/24/32/40/48/64/128/256 (20 and 40 are the
//                                 sizes Windows asks for at 125 % scaling)
// - resources/tray-*.png          32 px, @2x 64 px
//
// app-small.svg is its own drawing (no tick marks, heavier strokes) and is used
// up to 24 px, where the ticks would only turn to mush. Run automatically via
// the `prebuild` hook; the generated files are committed.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import pngToIco from 'png-to-ico'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const src = join(root, 'build', 'icon-src')
const read = (name) => readFileSync(join(src, name))

// Rasterise large, then Lanczos down: the same path for every size.
async function render(svg, size) {
  const big = await sharp(svg, { density: 288 }).resize(1024, 1024).png().toBuffer()
  return size === 1024 ? big : sharp(big).resize(size, size).png({ compressionLevel: 9 }).toBuffer()
}

mkdirSync(join(root, 'build'), { recursive: true })

const app = read('app.svg')
const appSmall = read('app-small.svg')

const png1024 = await render(app, 1024)
writeFileSync(join(root, 'resources', 'icon.png'), png1024)
writeFileSync(join(root, 'build', 'icon.png'), png1024)
console.log('[sync-icon] resources/icon.png + build/icon.png written (1024×1024)')

const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
const frames = await Promise.all(sizes.map((n) => render(n <= 24 ? appSmall : app, n)))
writeFileSync(join(root, 'build', 'icon.ico'), await pngToIco(frames))
console.log(`[sync-icon] build/icon.ico written (${sizes.join('/')})`)

for (const state of ['running', 'stopped']) {
  const svg = read(`tray-${state}.svg`)
  writeFileSync(join(root, 'resources', `tray-${state}.png`), await render(svg, 32))
  writeFileSync(join(root, 'resources', `tray-${state}@2x.png`), await render(svg, 64))
}
console.log('[sync-icon] resources/tray-{running,stopped}[@2x].png written')
