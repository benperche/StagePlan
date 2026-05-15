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
  label: string        // e.g. "A", "B", or custom
  fontSize: number
}

export interface Section {
  id: string
  name: string
  color: string
  instrument: string
}

export interface ConductorConfig {
  show: boolean
  hasStand: boolean
}

export type InstrumentType =
  | 'drumkit'
  | 'piano'
  | 'guitar-amp'
  | 'bass-amp'
  | 'timpani'
  | 'mallet'

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
  notes: string
  instruments: FixedInstrument[]
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

export interface ConductorOrigin {
  ox: number
  oy: number
  yDir: number     // +1 if conductor is above chairs (flipped), -1 otherwise
}

export type Tool = 'select' | 'color' | 'enable' | 'label' | 'stand'
