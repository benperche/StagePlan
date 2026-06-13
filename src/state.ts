import type { ChartConfig, Row, Chair, FixedInstrument, InstrumentType } from './types'

export const DEFAULT_CHAIR_COLOR = '#e8e8e8'

const CHAIR_COLORS = [
  DEFAULT_CHAIR_COLOR, // default
]

export function makeChair(): Chair {
  return {
    id: crypto.randomUUID(),
    enabled: true,
    color: CHAIR_COLORS[0],
    label: '',
    // Stands on by default — most ensembles have one per chair, and it's
    // easier to toggle a stand off than to remember to add it to every
    // chair on a fresh chart.
    hasStand: true,
    standAfter: false,
  }
}

export function makeRow(chairCount: number, label: string): Row {
  return {
    id: crypto.randomUUID(),
    chairs: Array.from({ length: chairCount }, () => makeChair()),
    label,
    fontSize: 13,
  }
}

export function makeDefaultConfig(): ChartConfig {
  return {
    version: 1,
    title: 'Seating Chart',
    layout: 'semicircle',
    rows: [
      makeRow(8, '1'),
      makeRow(10, '2'),
      makeRow(12, '3'),
    ],
    straightRows: 0,
    conductor: { show: true, hasStand: true, offsetX: 0, offsetY: 0 },
    flipped: false,
    showNumbers: false,
    numberRestartPerRow: false,
    showRowLabels: false,
    showArc: false,
    showCredit: true,
    notes: '',
    instruments: [],
    arcRange: Math.PI,
    rowSpacing: 70,
    showStageDirections: false,
    chartScale: 1,
    backgroundFit: 'contain',
  }
}

// Sensible default insert position per instrument type, so a new instrument
// lands roughly where ensembles actually put it instead of next to the
// conductor. Angles are canvas radians around the conductor (0 right, -π/2
// straight back through the chairs, π left); `pad` is extra px beyond the
// back row, so the defaults scale with the size of the chart. Tuned from the
// Concert Band / Big Band preset placements (presets.ts).
const INSERT_DEFAULTS: Partial<Record<InstrumentType, { angle: number; pad: number; rotation?: number }>> = {
  // Percussion across the back: timpani back-right, mallets back-left
  // (mirroring the Concert Band preset), kit and aux in between.
  timpani:  { angle: -0.95, pad: 150 },
  mallet:   { angle: -2.2,  pad: 115, rotation: -0.65 },
  drumkit:  { angle: -1.27, pad: 130 },
  gong:     { angle: -1.75, pad: 120 },
  square:   { angle: -1.55, pad: 100 },
  rectangle: { angle: -1.55, pad: 100 },
  // Rhythm section flanks the band on the left (as in the Big Band preset);
  // the piano angles in toward the conductor.
  piano:      { angle: -2.42, pad: 40, rotation: 1.5708 },
  'guitar-amp': { angle: -2.15, pad: 40 },
  'bass-amp':   { angle: -2.45, pad: 70 },
  // Harp tucks in at the front-left, beside the outer string desks.
  harp: { angle: -2.75, pad: 25 },
}

// Default position is type-specific (INSERT_DEFAULTS, relative to the back
// row) where one exists; small stage props (mic, stand, chair, stool) fall
// back to "in front of the conductor" where they're easy to grab.
export function makeInstrument(
  type: InstrumentType, flipped: boolean, existing: number, backRadius: number,
): FixedInstrument {
  // Tiny stagger so each new add is visible rather than stacked exactly.
  const stagger = (existing % 4) * 14
  const smart = INSERT_DEFAULTS[type]
  if (smart) {
    return {
      id: crypto.randomUUID(),
      type,
      angle: smart.angle,
      distance: backRadius + smart.pad + stagger,
      rotation: smart.rotation ?? 0,
      ...(type === 'timpani' ? { count: 4 } : {}),
    }
  }
  // -yDir is the direction away from the chairs in canvas y.
  const yDir = flipped ? 1 : -1
  const angleAway = -yDir > 0 ? Math.PI / 2 : -Math.PI / 2
  return {
    id: crypto.randomUUID(),
    type,
    angle: angleAway,
    distance: 110 + stagger,
    rotation: 0,
    ...(type === 'microphone' ? { micStand: true, wireless: false } : {}),
  }
}

// Deep clone via JSON — safe for plain data objects
export function cloneConfig(config: ChartConfig): ChartConfig {
  return JSON.parse(JSON.stringify(config))
}

// --- Undo/redo stack ---

const MAX_HISTORY = 50

export class History {
  private past: ChartConfig[] = []
  private future: ChartConfig[] = []

  push(config: ChartConfig) {
    this.past.push(cloneConfig(config))
    if (this.past.length > MAX_HISTORY) this.past.shift()
    this.future = []
  }

  undo(current: ChartConfig): ChartConfig | null {
    if (this.past.length === 0) return null
    this.future.push(cloneConfig(current))
    return this.past.pop()!
  }

  redo(current: ChartConfig): ChartConfig | null {
    if (this.future.length === 0) return null
    this.past.push(cloneConfig(current))
    return this.future.pop()!
  }

  canUndo() { return this.past.length > 0 }
  canRedo() { return this.future.length > 0 }
}
