import { describe, expect, it } from 'vitest'
import { decodeFromHash, encodeToHash } from '../src/serializer'
import { makeDefaultConfig, makeInstrument } from '../src/state'
import type { ChartConfig } from '../src/types'

function buildExercisedConfig(): ChartConfig {
  const config = makeDefaultConfig()

  // Mutate rows to exercise optional per-row / per-chair fields.
  config.rows[0].riser = 2
  config.rows[0].riserPad = 35
  config.rows[0].gapBefore = 12
  config.rows[0].arcStart = 0.3
  config.rows[0].arcEnd = 2.9
  config.rows[0].isStraight = false

  const chair = config.rows[0].chairs[0]
  chair.label = 'Vln 1 — solo ✓'
  chair.isStool = true
  chair.noSeat = true
  chair.standAfter = true

  config.riserStepHeight = 25

  // Fixed instrument via the state.ts factory.
  const instrument = makeInstrument('timpani', config.flipped, config.instruments.length, 300)
  config.instruments.push(instrument)

  // Background image so we can assert it's stripped by encodeToHash.
  config.backgroundImage = 'data:image/png;base64,AAAA'

  return config
}

describe('encodeToHash / decodeFromHash round-trip', () => {
  it('round-trips a config exercising optional fields, except the background image', () => {
    const config = buildExercisedConfig()
    const { hash, strippedBackground } = encodeToHash(config)
    expect(strippedBackground).toBe(true)

    const decoded = decodeFromHash(hash)
    expect(decoded).not.toBeNull()

    // backgroundImage is intentionally stripped.
    expect(decoded!.backgroundImage).toBeUndefined()

    const { backgroundImage, ...expected } = config
    expect(decoded).toEqual(expected)
  })

  it('deep-compares row/chair optional fields exactly', () => {
    const config = buildExercisedConfig()
    const { hash } = encodeToHash(config)
    const decoded = decodeFromHash(hash)!

    expect(decoded.rows[0].riser).toBe(2)
    expect(decoded.rows[0].riserPad).toBe(35)
    expect(decoded.rows[0].gapBefore).toBe(12)
    expect(decoded.rows[0].arcStart).toBe(0.3)
    expect(decoded.rows[0].arcEnd).toBe(2.9)
    expect(decoded.rows[0].chairs[0].label).toBe('Vln 1 — solo ✓')
    expect(decoded.rows[0].chairs[0].isStool).toBe(true)
    expect(decoded.rows[0].chairs[0].noSeat).toBe(true)
    expect(decoded.rows[0].chairs[0].standAfter).toBe(true)
    expect(decoded.riserStepHeight).toBe(25)
    expect(decoded.instruments).toHaveLength(1)
    expect(decoded.instruments[0].type).toBe('timpani')
    expect(decoded.instruments[0].count).toBe(4)
  })

  it('accepts a hash with or without the leading #', () => {
    const config = makeDefaultConfig()
    const { hash } = encodeToHash(config)
    expect(hash.startsWith('#')).toBe(true)
    const withoutHash = hash.slice(1)

    const decodedWith = decodeFromHash(hash)
    const decodedWithout = decodeFromHash(withoutHash)
    expect(decodedWith).toEqual(decodedWithout)
    expect(decodedWith).toEqual(config)
  })

  it('returns null for garbage input instead of throwing', () => {
    expect(decodeFromHash('#not-valid-base64!!!')).toBeNull()
    expect(decodeFromHash('')).toBeNull()
    expect(decodeFromHash(btoa(encodeURIComponent('not json')))).toBeNull()
    // Valid JSON, but not a StagePlan chart (no `rows` array) — migrate()
    // throws "Not a StagePlan chart", which decodeFromHash swallows to null.
    expect(decodeFromHash(btoa(encodeURIComponent(JSON.stringify({ foo: 'bar' }))))).toBeNull()
  })
})
