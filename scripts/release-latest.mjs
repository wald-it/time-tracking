#!/usr/bin/env node
/**
 * May a re-run that completes a partial release take GitHub's "latest" marker
 * (#221)? Prints `true` or `false` on stdout.
 *
 * electron-updater reads /releases/latest, and GitHub does not reliably move
 * that marker when a prerelease becomes a normal release — so the workflow
 * passes `--latest` itself. But only when it is safe: if v1.20.0 went out as
 * a partial prerelease, v1.21.0 shipped stable, and v1.20.0 is re-run later,
 * `--latest` would move the marker back and clients would be offered v1.20.0
 * instead of v1.21.0.
 *
 * `true` only when all of these hold:
 *   - the release was a prerelease (WAS_PRERELEASE=true) and is complete now
 *     (PRERELEASE=false);
 *   - TAG is strictly newer than CURRENT_LATEST, compared numerically.
 *
 * Fails closed: an empty CURRENT_LATEST (the lookup failed) or a tag that is
 * not plain `vX.Y.Z` gives `false` plus a warning to set the marker by hand.
 * A wrong "latest" is the harm here; a missing one is visible and fixable.
 *
 * Plain Node, no dependencies: `publish-release` runs without `pnpm install`.
 */

const { TAG = '', CURRENT_LATEST = '', WAS_PRERELEASE = '', PRERELEASE = '' } = process.env

function parse(tag) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag)
  return m ? m.slice(1).map(Number) : null
}

function isNewer(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i]
  }
  return false
}

function decide() {
  if (WAS_PRERELEASE !== 'true' || PRERELEASE !== 'false') return false

  const byHand = `set it by hand if ${TAG} should be latest: gh release edit ${TAG} --latest`
  if (CURRENT_LATEST === '') {
    console.error(
      `::warning::Could not read the current latest release — not moving the marker; ${byHand}`
    )
    return false
  }
  const own = parse(TAG)
  const current = parse(CURRENT_LATEST)
  if (!own || !current) {
    console.error(
      `::warning::Cannot compare '${TAG}' with '${CURRENT_LATEST}' — not moving the latest marker; ${byHand}`
    )
    return false
  }
  return isNewer(own, current)
}

console.log(String(decide()))
