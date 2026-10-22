/**
 * Horizontal shift (px) that keeps a quick-start project fan inside the
 * viewport. `centerX` is the key's centre in viewport coordinates; each item
 * sits centred at `centerX + x` with its layout `width` (offsetWidth — the
 * open animation scales the items, so their bounding boxes would lie).
 * Returns 0 when everything fits; if the fan is wider than the window, the
 * left edge wins so the first items stay reachable.
 */
export function fanShift(
  centerX: number,
  items: Array<{ x: number; width: number }>,
  viewportWidth: number,
  margin = 16
): number {
  if (items.length === 0) return 0
  let minLeft = Infinity
  let maxRight = -Infinity
  for (const it of items) {
    minLeft = Math.min(minLeft, centerX + it.x - it.width / 2)
    maxRight = Math.max(maxRight, centerX + it.x + it.width / 2)
  }
  let shift = 0
  if (maxRight > viewportWidth - margin) shift = viewportWidth - margin - maxRight
  if (minLeft + shift < margin) shift = margin - minLeft
  return shift
}
