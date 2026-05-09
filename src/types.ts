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
  straight: boolean    // true = straight row even within a semicircle layout
}

export interface Section {
  id: string
  name: string
  color: string
  instrument: string
}

export interface ConductorConfig {
  hasStand: boolean
}

export interface ChartConfig {
  version: number
  title: string
  layout: LayoutMode
  rows: Row[]
  conductor: ConductorConfig
  flipped: boolean
  showNumbers: boolean
  numberRestartPerRow: boolean
  showRowLabels: boolean
  notes: string
}

export interface HitTarget {
  rowIndex: number
  chairIndex: number
  x: number
  y: number
  radius: number
}

export type Tool = 'select' | 'color' | 'enable' | 'label' | 'stand'
