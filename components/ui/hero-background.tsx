// Soft brand-colored glow rendered as a fixed backdrop behind the whole app,
// on every page. Implemented as edgeless radial gradients (see `.app-backdrop`
// in globals.css) rather than clip-path blobs, so it never shows hard polygon
// edges when stretched full-page. Light/dark palettes are theme-driven in CSS.
export function HeroBackground() {
  return <div className="app-backdrop" aria-hidden="true" />
}
