import type { ChartConfig, Row, Chair, InstrumentType } from './types'

export interface PresetSection {
  name: string
  instrument: string
  count: number
  color: string
}

// Explicit row composition — used when a preset needs specific chair labels
// per seat (e.g. "Tnr 1", "Alto 2") rather than a generic packed layout.
export interface PresetCustomChair {
  label: string
  color: string
}
export interface PresetCustomRow {
  label: string
  chairs: PresetCustomChair[]
}

// Pre-placed fixed instrument in polar coords relative to the conductor.
export interface PresetInstrument {
  type: InstrumentType
  angle: number       // canvas radians: 0 right, π/2 down, π left, -π/2 up
  distance: number    // pixels from conductor
  rotation?: number   // default 0
  count?: number      // for timpani
  label?: string
}

export interface Preset {
  id: string
  name: string
  layout: ChartConfig['layout']
  sections: PresetSection[]
  // Optional: when set, these explicit rows override `sections` packing.
  customRows?: PresetCustomRow[]
  // Optional: number of straight rows from the back (semicircle layouts).
  straightRows?: number
  // Optional: pre-placed fixed instruments. When omitted, instruments are
  // simply cleared on apply (which is the default for every preset).
  instruments?: PresetInstrument[]
}

// Colors are visually distinct and print-friendly
const COLORS = {
  woodwind:   '#a8d8ea',
  brass:      '#f9ca74',
  percussion: '#c7b8ea',
  strings:    '#a8e6cf',
  rhythm:     '#f4a261',
  voice:      '#e8c4c4',
}

export const PRESETS: Preset[] = [
  {
    id: 'big-band',
    name: 'Big Band',
    layout: 'straight',
    sections: [],
    // Three straight rows: saxes (front, 5) → trombones (mid, 4) → trumpets (back, 4).
    // Standard big-band lead-in-the-middle ordering within each section.
    customRows: [
      {
        label: 'A',
        chairs: [
          { label: 'Tnr 2',  color: COLORS.woodwind },
          { label: 'Alto 2', color: COLORS.woodwind },
          { label: 'Alto 1', color: COLORS.woodwind },
          { label: 'Tnr 1',  color: COLORS.woodwind },
          { label: 'Bari',   color: COLORS.woodwind },
        ],
      },
      {
        label: 'B',
        chairs: [
          { label: 'Tbn 4', color: COLORS.brass },
          { label: 'Tbn 2', color: COLORS.brass },
          { label: 'Tbn 1', color: COLORS.brass },
          { label: 'Tbn 3', color: COLORS.brass },
        ],
      },
      {
        label: 'C',
        chairs: [
          { label: 'Tpt 4', color: '#f4a261' },
          { label: 'Tpt 2', color: '#f4a261' },
          { label: 'Tpt 1', color: '#f4a261' },
          { label: 'Tpt 3', color: '#f4a261' },
        ],
      },
    ],
    // Rhythm section to the LEFT of the horns, in a rough 2x2 grid.
    // Polar coords are angle (canvas radians, -π/2 ≈ above conductor) and
    // distance in pixels.  These are starting positions; the user can drag
    // any of them to fine-tune the layout for their actual stage.
    instruments: [
      { type: 'bass-amp',   angle: -2.25, distance: 245 },  // top-left, behind everything
      { type: 'drumkit',    angle: -2.05, distance: 235 },  // top, between bass and chairs
      { type: 'piano',      angle: -2.55, distance: 215 },  // mid-left, in front of bass
      { type: 'guitar-amp', angle: -2.25, distance: 170 },  // mid, in front of drums
    ],
  },
  {
    id: 'symphony',
    name: 'Symphony Orchestra',
    layout: 'semicircle',
    sections: [
      { name: 'Violin I',      instrument: 'Violin',      count: 16, color: COLORS.strings },
      { name: 'Violin II',     instrument: 'Violin',      count: 14, color: COLORS.strings },
      { name: 'Viola',         instrument: 'Viola',       count: 10, color: COLORS.strings },
      { name: 'Cello',         instrument: 'Cello',       count: 8,  color: COLORS.strings },
      { name: 'Double Bass',   instrument: 'Double Bass', count: 6,  color: COLORS.strings },
      { name: 'Flute',         instrument: 'Flute',       count: 3,  color: COLORS.woodwind },
      { name: 'Oboe',          instrument: 'Oboe',        count: 3,  color: COLORS.woodwind },
      { name: 'Clarinet',      instrument: 'Clarinet',    count: 3,  color: COLORS.woodwind },
      { name: 'Bassoon',       instrument: 'Bassoon',     count: 3,  color: COLORS.woodwind },
      { name: 'French Horn',   instrument: 'French Horn', count: 4,  color: COLORS.brass },
      { name: 'Trumpet',       instrument: 'Trumpet',     count: 3,  color: COLORS.brass },
      { name: 'Trombone',      instrument: 'Trombone',    count: 3,  color: COLORS.brass },
      { name: 'Tuba',          instrument: 'Tuba',        count: 1,  color: COLORS.brass },
      { name: 'Timpani',       instrument: 'Timpani',     count: 1,  color: COLORS.percussion },
      { name: 'Percussion',    instrument: 'Percussion',  count: 2,  color: COLORS.percussion },
      { name: 'Harp',          instrument: 'Harp',        count: 2,  color: COLORS.strings },
    ],
  },
  {
    id: 'concert-band',
    name: 'Concert Band',
    layout: 'semicircle',
    sections: [
      { name: 'Flute',          instrument: 'Flute',       count: 6,  color: COLORS.woodwind },
      { name: 'Oboe',           instrument: 'Oboe',        count: 2,  color: COLORS.woodwind },
      { name: 'Clarinet',       instrument: 'Clarinet',    count: 10, color: COLORS.woodwind },
      { name: 'Bass Clarinet',  instrument: 'Bass Clar.',  count: 2,  color: COLORS.woodwind },
      { name: 'Alto Saxophone', instrument: 'Alto Sax',    count: 3,  color: COLORS.woodwind },
      { name: 'Tenor Saxophone',instrument: 'Tenor Sax',   count: 2,  color: COLORS.woodwind },
      { name: 'Bari Saxophone', instrument: 'Bari Sax',    count: 1,  color: COLORS.woodwind },
      { name: 'Bassoon',        instrument: 'Bassoon',     count: 2,  color: COLORS.woodwind },
      { name: 'French Horn',    instrument: 'French Horn', count: 4,  color: COLORS.brass },
      { name: 'Trumpet',        instrument: 'Trumpet',     count: 6,  color: COLORS.brass },
      { name: 'Trombone',       instrument: 'Trombone',    count: 4,  color: COLORS.brass },
      { name: 'Euphonium',      instrument: 'Euphonium',   count: 2,  color: COLORS.brass },
      { name: 'Tuba',           instrument: 'Tuba',        count: 2,  color: COLORS.brass },
      { name: 'Timpani',        instrument: 'Timpani',     count: 1,  color: COLORS.percussion },
      { name: 'Percussion',     instrument: 'Percussion',  count: 4,  color: COLORS.percussion },
    ],
  },
  {
    id: 'string-quartet',
    name: 'String Quartet',
    layout: 'semicircle',
    sections: [
      { name: 'Violin I',  instrument: 'Violin', count: 1, color: COLORS.strings },
      { name: 'Violin II', instrument: 'Violin', count: 1, color: COLORS.strings },
      { name: 'Viola',     instrument: 'Viola',  count: 1, color: COLORS.strings },
      { name: 'Cello',     instrument: 'Cello',  count: 1, color: COLORS.strings },
    ],
  },
  {
    id: 'jazz-combo',
    name: 'Jazz Combo',
    layout: 'semicircle',
    sections: [
      { name: 'Trumpet',  instrument: 'Trumpet',  count: 1, color: COLORS.brass },
      { name: 'Saxophone',instrument: 'Sax',      count: 1, color: COLORS.woodwind },
      { name: 'Piano',    instrument: 'Piano',    count: 1, color: COLORS.rhythm },
      { name: 'Guitar',   instrument: 'Guitar',   count: 1, color: COLORS.rhythm },
      { name: 'Bass',     instrument: 'Bass',     count: 1, color: COLORS.rhythm },
      { name: 'Drums',    instrument: 'Drums',    count: 1, color: COLORS.rhythm },
    ],
  },
]

/**
 * Convert a preset + optional count overrides into a ChartConfig-ready row array.
 * Sections are packed into rows of maxPerRow chairs, colored by section.
 */
export function buildRowsFromSections(
  sections: PresetSection[],
  maxPerRow = 12,
): Row[] {
  // Flatten all chairs with their section color and label
  const allChairs: Chair[] = []
  for (const section of sections) {
    for (let i = 0; i < section.count; i++) {
      allChairs.push({
        id: crypto.randomUUID(),
        enabled: true,
        color: section.color,
        label: section.instrument,
        hasStand: false,
      })
    }
  }

  // Pack into rows
  const rows: Row[] = []
  let i = 0
  const rowLabels = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  while (i < allChairs.length) {
    const rowChairs = allChairs.slice(i, i + maxPerRow)
    rows.push({
      id: crypto.randomUUID(),
      chairs: rowChairs,
      label: rowLabels[rows.length] ?? String(rows.length + 1),
      fontSize: 11,
    })
    i += maxPerRow
  }

  return rows
}
