import { describe, expect, it } from 'vitest'
import { describeComposition, parseOrchestraNotation } from '../src/presets'

describe('parseOrchestraNotation', () => {
  it('parses a standard 4-block full-orchestra string', () => {
    const comp = parseOrchestraNotation('2.2.2.2 - 4.2.3.1 - 1.2 - 12.10.8.8.6')
    expect(comp).not.toBeNull()
    expect(comp!.woodwinds.map(s => s.parsed.count)).toEqual([2, 2, 2, 2])
    expect(comp!.brass.map(s => s.parsed.count)).toEqual([4, 2, 3, 1])
    expect(comp!.percussion.map(s => s.parsed.count)).toEqual([1, 2])
    expect(comp!.strings.map(s => s.parsed.count)).toEqual([12, 10, 8, 8, 6])
    // Names come from the fixed WW/BR/PERC/STR name tables.
    expect(comp!.woodwinds.map(s => s.name)).toEqual(['Fl', 'Ob', 'Cl', 'Bsn'])
    expect(comp!.strings.map(s => s.name)).toEqual(['Vln 1', 'Vln 2', 'Va', 'Vc', 'Cb'])
  })

  it('parses a 3-block string (no percussion) by leaving percussion empty', () => {
    const comp = parseOrchestraNotation('1.1.1.1 - 2.0.0.0 - 6.5.4.3.1')
    expect(comp).not.toBeNull()
    expect(comp!.percussion).toEqual([])
    expect(comp!.brass.map(s => s.parsed.count)).toEqual([2, 0, 0, 0])
    expect(comp!.strings.map(s => s.parsed.count)).toEqual([6, 5, 4, 3, 1])
  })

  it('tolerates surrounding whitespace and extra spaces around dashes', () => {
    const tight = parseOrchestraNotation('2.2.2.2-4.2.3.1-1.2-12.10.8.8.6')
    const loose = parseOrchestraNotation('  2.2.2.2  -  4.2.3.1  -  1.2  -  12.10.8.8.6  ')
    expect(tight).not.toBeNull()
    expect(loose).not.toBeNull()
    expect(loose).toEqual(tight)
  })

  it('supports the bracketed-doubling syntax with roman numeral positions', () => {
    const comp = parseOrchestraNotation('1.1.3(III=Bass Clarinet).1 - 2.0.0.0 - 0 - 6.5.4.3.2')
    expect(comp).not.toBeNull()
    const cl = comp!.woodwinds[2]
    expect(cl.parsed.count).toBe(3)
    expect(cl.parsed.doublings.get(3)).toBe('Bass Clarinet')
  })

  it('supports multiple doublings separated by commas, per the doc-comment example', () => {
    const comp = parseOrchestraNotation('2(I=Picc, II=Alto Fl).1.1.1 - 2.0.0.0 - 0 - 6.5.4.3.2')
    expect(comp).not.toBeNull()
    const fl = comp!.woodwinds[0]
    expect(fl.parsed.count).toBe(2)
    expect(fl.parsed.doublings.get(1)).toBe('Picc')
    expect(fl.parsed.doublings.get(2)).toBe('Alto Fl')
  })

  it('parses the documented Mozart-sized chamber example', () => {
    const comp = parseOrchestraNotation('1.1.1.1 - 2.0.0.0 - 0 - 6.5.4.3.2')
    expect(comp).not.toBeNull()
    const desc = describeComposition(comp!)
    expect(desc).toContain('Woodwinds: 1 Flute, 1 Oboe, 1 Clarinet, 1 Bassoon')
    expect(desc).toContain('Brass: 2 French Horn')
    expect(desc).toContain('Strings: 6 Violin I, 5 Violin II, 4 Viola, 3 Cello, 2 Double Bass')
    expect(desc).toContain('Total: 26 players')
  })

  it('returns null for fewer than 3 blocks', () => {
    expect(parseOrchestraNotation('2.2.2.2 - 4.2.3.1')).toBeNull()
  })

  it('returns null for more than 4 blocks', () => {
    expect(parseOrchestraNotation('1 - 2 - 3 - 4 - 5')).toBeNull()
  })

  it('treats unparseable entries as a count of 0 rather than throwing', () => {
    const comp = parseOrchestraNotation('x.y.z.w - 4.2.3.1 - 1.2 - 12.10.8.8.6')
    expect(comp).not.toBeNull()
    expect(comp!.woodwinds.map(s => s.parsed.count)).toEqual([0, 0, 0, 0])
  })

  it('treats an empty string as fewer than 3 non-empty blocks and returns null', () => {
    expect(parseOrchestraNotation('')).toBeNull()
  })

  it('handles "0" entries as an explicit zero count in a block', () => {
    const comp = parseOrchestraNotation('1.1.1.1 - 2.0.0.0 - 0 - 6.5.4.3.2')
    expect(comp).not.toBeNull()
    expect(comp!.brass.map(s => s.parsed.count)).toEqual([2, 0, 0, 0])
    expect(comp!.percussion.map(s => s.parsed.count)).toEqual([0])
  })
})
