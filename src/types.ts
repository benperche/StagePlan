export type LayoutMode = 'semicircle' | 'straight'

export interface Chair {
  id: string
  enabled: boolean
  color: string
  label: string
  hasStand: boolean
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

export type Tool = 'select' | 'color' | 'enable' | 'label' | 'stand'
