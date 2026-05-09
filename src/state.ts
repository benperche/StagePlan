import type { ChartConfig, Row, Chair } from './types'

const CHAIR_COLORS = [
  '#e8e8e8', // default
]

export function makeChair(_index?: number): Chair {
  return {
    id: crypto.randomUUID(),
    enabled: true,
    color: CHAIR_COLORS[0],
    label: '',
    hasStand: false,
  }
}

export function makeRow(chairCount: number, label: string): Row {
  return {
    id: crypto.randomUUID(),
    chairs: Array.from({ length: chairCount }, (_, i) => makeChair(i)),
    label,
    fontSize: 13,
    straight: false,
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
    conductor: { hasStand: true },
    flipped: false,
    showNumbers: true,
    numberRestartPerRow: false,
    showRowLabels: true,
    notes: '',
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
