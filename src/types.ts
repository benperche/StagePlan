export type LayoutMode = 'semicircle' | 'straight'

export interface Chair {
  id: string
  enabled: boolean
  color: string
  label: string
  hasStand: boolean      // solo stand in front of this chair
  standAfter?: boolean   // shared stand between this chair and the next
}

export interface Row {
  id: string
  chairs: Chair[]
  label: string        // e.g. "1", "2", or custom
  fontSize: number
  // Per-row "render this as a straight horizontal line instead of an arc"
  // override. When undefined, the renderer falls back to the global
  // ChartConfig.straightRows ("last N rows from the back are straight")
  // setting. When set to true/false, this row's value wins over the global.
  isStraight?: boolean
}

export interface ConductorConfig {
  show: boolean
  hasStand: boolean
  // Manual offset from the auto-computed conductor position.  Set when the
  // user drags the podium; (0, 0) means use the auto position.  Stored as
  // an offset rather than absolute coords so that resizing the window still
  // rebalances the chart sensibly.
  offsetX: number
  offsetY: number
}

export type InstrumentType =
  | 'drumkit'
  | 'piano'
  | 'guitar-amp'
  | 'bass-amp'
  | 'timpani'
  | 'mallet'
  | 'square'
  | 'rectangle'

export interface FixedInstrument {
  id: string
  type: InstrumentType
  // Polar position relative to the conductor: angle in canvas radians
  // (0 = right of conductor, π/2 = below, π = left), distance in pixels.
  angle: number
  distance: number
  rotation: number    // local rotation in radians (0 = default orientation)
  count?: number      // timpani: 2-6 drums (default 4)
  label?: string      // optional override for the displayed label
}

export interface ChartConfig {
  version: number
  title: string
  layout: LayoutMode
  rows: Row[]
  straightRows: number
  conductor: ConductorConfig
  flipped: boolean
  showNumbers: boolean
  numberRestartPerRow: boolean
  showRowLabels: boolean
  showArc: boolean
  showCredit: boolean
  notes: string
  instruments: FixedInstrument[]
  // Angular range of the chair arc in radians. Default Math.PI (180°),
  // i.e. a full semicircle. Smaller values draw a narrower arc, useful for
  // ensembles that don't need to span the full front of the stage.
  arcRange: number
  // Distance between adjacent concentric rows in pixels. Default 70.
  // Larger values give more breathing room between rows; smaller values
  // pack more rows into a tight chart at the cost of stand/number clash.
  rowSpacing: number
  // When true, draws light-grey "STAGE RIGHT" / "STAGE LEFT" labels on the
  // canvas edges (from the performer's perspective, so stage right is on
  // the audience's left). Off by default.
  showStageDirections: boolean
  // Optional background image, stored as a data URL so it persists with
  // the chart. Drawn behind everything else.
  backgroundImage?: string
  // How the background image is sized to the canvas.
  //   'contain' (default) — preserve aspect, letterbox the remainder
  //   'cover'             — preserve aspect, crop the overflow
  //   'stretch'           — ignore aspect, fill the whole canvas
  backgroundFit: 'contain' | 'cover' | 'stretch'
  // Uniform scale applied to the seating chart (chairs, stands,
  // instruments, conductor) around the conductor position. Default 1.
  // Lets the user fit the chart onto a background image of any size.
  chartScale: number
}

export interface HitTarget {
  rowIndex: number
  chairIndex: number
  x: number
  y: number
  radius: number
}

// Separate hit rect for the conductor podium
export interface ConductorHit {
  x: number
  y: number
  w: number
  h: number
}

// Hit target for fixed instruments: oriented rectangle in canvas space.
// Click point is transformed into the instrument's local frame and tested
// against the half-width / half-height bounds.
export interface InstrumentHit {
  id: string
  cx: number       // world centre x
  cy: number       // world centre y
  hw: number       // half-width in local space
  hh: number       // half-height in local space
  rotation: number // total rotation applied when drawing
}

// Hit target for the rotate handle (a green disc above the selected
// instrument, MS-Office style).
export interface RotateHandleHit {
  id: string
  cx: number       // world centre x of the handle
  cy: number
  radius: number   // hit radius (slightly larger than visual radius)
}

export interface ConductorOrigin {
  ox: number
  oy: number
  yDir: number     // +1 if conductor is above chairs (flipped), -1 otherwise
}

