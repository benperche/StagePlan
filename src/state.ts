import type { ChartConfig, Row, Chair, FixedInstrument, InstrumentType } from './types'

const CHAIR_COLORS = [
  '#e8e8e8', // default
]

export function makeChair(): Chair {
  return {
    id: crypto.randomUUID(),
    enabled: true,
    color: CHAIR_COLORS[0],
    label: '',
    hasStand: false,
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
      makeRow(8, 'A'),
      makeRow(10, 'B'),
      makeRow(12, 'C'),
    ],
    straightRows: 0,
    conductor: { show: true, hasStand: true, offsetX: 0, offsetY: 0 },
    flipped: false,
    showNumbers: true,
    numberRestartPerRow: false,
    showRowLabels: false,
    showArc: false,
    notes: '',
    instruments: [],
    arcRange: Math.PI,
    rowSpacing: 70,
  }
}

// Default polar position is "behind the conductor" — opposite the chairs.
export function makeInstrument(type: InstrumentType, flipped: boolean, existing: number): FixedInstrument {
  // -yDir is the direction away from the chairs in canvas y.
  const yDir = flipped ? 1 : -1
  const angleAway = -yDir > 0 ? Math.PI / 2 : -Math.PI / 2
  // Tiny stagger so each new add is visible rather than stacked exactly.
  const stagger = (existing % 4) * 14
  return {
    id: crypto.randomUUID(),
    type,
    angle: angleAway,
    distance: 110 + stagger,
    rotation: 0,
    ...(type === 'timpani' ? { count: 4 } : {}),
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
