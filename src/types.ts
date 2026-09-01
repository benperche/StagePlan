export type LayoutMode = 'semicircle' | 'straight'

export interface Chair {
  id: string
  enabled: boolean
  color: string
  label: string
  hasStand: boolean      // solo stand in front of this chair
  standAfter?: boolean   // shared stand between this chair and the next
  isStool?: boolean      // render as a double-bass stool (round) instead of a chair
  noSeat?: boolean       // standing player: no chair/stool drawn, just the stand + label
  // Layout-tab per-chair nudge: tangential displacement in px along the row
  // (sideways along the arc / line). Converted to an angle (offset / radius)
  // for arc rows. Default 0. Clamped so chairs never overlap.
  offset?: number
  // Section key (e.g. "vln1") for grouped arc spacing: chairs sharing a group
  // are clustered into one contiguous angular wedge within the row's arc span,
  // instead of being spread evenly across it. Set by the orchestra generator
  // and the "Tidy sections" action; absent on ordinary chairs, in which case
  // arc spacing is unaffected (today's even spread).
  group?: string
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

  // --- Layout-tab per-row overrides (all optional; unset = default) ---
  // Extra px of spacing in front of this row (the "distance handle"). Row
  // radii are cumulative, so increasing one row's gap pushes every row
  // behind it outward by the same amount, preserving the gaps between them.
  gapBefore?: number
  // Per-row arc span for curved rows, as explicit start/end angles in canvas
  // radians (the "span handles"). Unset → derived from the global arcRange
  // (Math.PI/2 ± arcRange/2). Stored as start+end so the span can be made
  // asymmetric (Shift+drag one end) rather than only widened symmetrically.
  arcStart?: number
  arcEnd?: number
  // Per-row chair spacing (px) for straight rows, and a sideways shift of the
  // whole row's centre from the conductor's x. Unset → 40px / centred.
  straightSpacing?: number
  straightOffset?: number
  // Riser tier this row sits on (1, 2, 3…). Unset = floor level. Higher tiers
  // are automatically stepped back (extra radial depth per level rise) so the
  // platform reads as raised, and drawRisers renders a platform band behind the
  // row following its shape — a concentric curved band for an arc row, a
  // rectangle for a straight row.
  riser?: number
  // Extra px enlarging this row's riser platform beyond its automatic size
  // (front/back depth and sideways/angular width), draggable via the Layout-tab
  // resize handle. Only meaningful on the last row of a same-tier run — see
  // Renderer.drawRisers, which takes the max across a run's rows. Unset = 0.
  riserPad?: number
}

export interface ConductorConfig {
  show: boolean
  hasStand: boolean
  // Text drawn on the podium (default "COND"). Editable by clicking the
  // conductor in a non-layout tab.
  label?: string
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
  | 'harp'
  | 'microphone'
  | 'gong'
  | 'cymbal'
  | 'snare'
  | 'bass-drum'
  | 'trap-table'
  | 'chair'
  | 'stand'
  | 'stool'
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
  // Timpani-only: when true, a player stool is drawn at the centre of the
  // timpani arc and counted in the chart's stool total.
  stool?: boolean
  label?: string      // optional override for the displayed label
  // Microphone-only: whether the mic sits on a mic stand (default true) and
  // whether it's a wireless unit (default false = wired, drawn with a cable).
  micStand?: boolean
  wireless?: boolean
  // When true, a music stand × is drawn between this instrument and the
  // conductor (toggleable by clicking the instrument while the Music
  // Stand tool is active in the Edit tab).
  hasStand?: boolean
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
  // Manual offset (canvas px) of the chart title from its auto position above
  // the back row. Set by dragging the title in the Layout tab; (0,0) = auto.
  titleOffsetX?: number
  titleOffsetY?: number
  // Extra breathing room (canvas px) between the title and the top of the
  // chart, on top of the built-in gap. Default 0.
  titleGap?: number
  instruments: FixedInstrument[]
  // Angular range of the chair arc in radians. Default Math.PI (180°),
  // i.e. a full semicircle. Smaller values draw a narrower arc, useful for
  // ensembles that don't need to span the full front of the stage.
  arcRange: number
  // Angle the default arc is centred on, in canvas radians. Unset → Math.PI/2
  // (the apex, straight back from the conductor). Set by Shift/Cmd-dragging a
  // purple arc-range handle, which rotates the whole default fan — the
  // chart-wide analogue of Shift-dragging one row's end to slide that row.
  // Only affects rows that haven't had their own arcStart/arcEnd set.
  arcCenter?: number
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
  // Optional built-in schematic stage shape drawn behind the chart (a light
  // vector backdrop — no photo needed). Purely decorative: it does not affect
  // row placement. A photo background, if present, takes precedence. Absent =
  // none. (Structural risers — Row.riser — are the separate feature that DOES
  // drive row placement.)
  stageTemplate?: 'flat-hall' | 'concert-shell' | 'apron'
  // Physical height per riser step in cm — used only for the "+Ncm" tier
  // labels drawn by drawRisers. Unset → RISER_STEP_HEIGHT_DEFAULT.
  riserStepHeight?: number
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

// Layout-tab drag handles (drawn only in layout mode). A row gets a radial
// "distance" handle at its apex and two tangential "span" handles at its ends.
export interface LayoutHandleHit {
  // -1 for the chart-wide default arc-range handles (kind 'arc-range-*').
  rowIndex: number
  kind: 'distance' | 'span-start' | 'span-end' | 'arc-range-start' | 'arc-range-end' | 'desk' | 'riser-size'
  cx: number
  cy: number
  radius: number
  // For 'desk' handles: index of the first chair of the dragged desk pair.
  chairIndex?: number
}

// Per-row geometry snapshot the Layout drag handlers need (populated by the
// renderer each frame in layout mode so main.ts doesn't re-derive it).
export interface RowGeometry {
  rowIndex: number
  isStraight: boolean
  r: number        // effective radius / distance from conductor (incl. gapBefore)
  base: number     // r minus this row's gapBefore (radius at gap 0)
  prevR: number    // effective radius of the row in front (0 for the first row)
  arcStart: number
  arcEnd: number
  rowY: number       // straight rows: world y of the row
  spacing: number    // straight rows: px between chairs
  centerOffset: number // straight rows: sideways shift of the row centre
}

export interface ConductorOrigin {
  ox: number
  oy: number
  yDir: number       // +1 if conductor is above chairs (flipped), -1 otherwise
  flipped: boolean   // convenience: same as yDir > 0
}

