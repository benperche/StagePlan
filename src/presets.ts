import type { ChartConfig, Row, Chair } from './types'

export interface PresetSection {
  name: string
  instrument: string
  count: number
  color: string
}

export interface Preset {
  id: string
  name: string
  layout: ChartConfig['layout']
  sections: PresetSection[]
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
    layout: 'semicircle',
    sections: [
      { name: 'Rhythm – Drums',    instrument: 'Drums',       count: 1,  color: COLORS.rhythm },
      { name: 'Rhythm – Guitar',   instrument: 'Guitar',      count: 1,  color: COLORS.rhythm },
      { name: 'Rhythm – Piano',    instrument: 'Piano',       count: 1,  color: COLORS.rhythm },
      { name: 'Rhythm – Bass',     instrument: 'Bass',        count: 1,  color: COLORS.rhythm },
      { name: 'Trumpets',          instrument: 'Trumpet',     count: 4,  color: COLORS.brass },
      { name: 'Trombones',         instrument: 'Trombone',    count: 4,  color: COLORS.brass },
      { name: 'Alto Saxophones',   instrument: 'Alto Sax',    count: 2,  color: COLORS.woodwind },
      { name: 'Tenor Saxophones',  instrument: 'Tenor Sax',   count: 2,  color: COLORS.woodwind },
      { name: 'Baritone Saxophone',instrument: 'Baritone Sax',count: 1,  color: COLORS.woodwind },
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
      straight: false,
    })
    i += maxPerRow
  }

  return rows
}
