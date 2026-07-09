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

// Row/chair/instrument ids are stripped from share links (pure runtime
// identity, incompressible UUID noise) and regenerated on decode — so
// round-trip comparisons must ignore them.
function stripIds(config: ChartConfig): unknown {
  return {
    ...config,
    rows: config.rows.map(({ id: _id, chairs, ...row }) => ({
      ...row,
      chairs: chairs.map(({ id: _cid, ...chair }) => chair),
    })),
    instruments: (config.instruments ?? []).map(({ id: _iid, ...inst }) => inst),
  }
}

// The pre-compression v1 encoding, as produced by every already-shared link.
function legacyEncode(config: ChartConfig): string {
  const { backgroundImage: _bg, ...rest } = config
  return '#' + btoa(encodeURIComponent(JSON.stringify(rest)))
}

describe('encodeToHash / decodeFromHash round-trip', () => {
  it('round-trips a config exercising optional fields, except the background image', async () => {
    const config = buildExercisedConfig()
    const { hash, strippedBackground } = await encodeToHash(config)
    expect(strippedBackground).toBe(true)

    const decoded = await decodeFromHash(hash)
    expect(decoded).not.toBeNull()

    // backgroundImage is intentionally stripped.
    expect(decoded!.backgroundImage).toBeUndefined()

    const { backgroundImage: _bg, ...expected } = config
    expect(stripIds(decoded!)).toEqual(stripIds(expected as ChartConfig))
  })

  it('deep-compares row/chair optional fields exactly', async () => {
    const config = buildExercisedConfig()
    const { hash } = await encodeToHash(config)
    const decoded = (await decodeFromHash(hash))!

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

  it('regenerates fresh, unique ids for rows, chairs and instruments', async () => {
    const config = buildExercisedConfig()
    const { hash } = await encodeToHash(config)
    const decoded = (await decodeFromHash(hash))!

    const ids: string[] = []
    for (const row of decoded.rows) {
      ids.push(row.id)
      for (const chair of row.chairs) ids.push(chair.id)
    }
    for (const inst of decoded.instruments) ids.push(inst.id)

    expect(ids.every(id => typeof id === 'string' && id.length > 0)).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('accepts a hash with or without the leading #', async () => {
    const config = makeDefaultConfig()
    const { hash } = await encodeToHash(config)
    expect(hash.startsWith('#2.')).toBe(true)
    const withoutHash = hash.slice(1)

    const decodedWith = await decodeFromHash(hash)
    const decodedWithout = await decodeFromHash(withoutHash)
    expect(stripIds(decodedWith!)).toEqual(stripIds(decodedWithout!))
    expect(stripIds(decodedWith!)).toEqual(stripIds(config))
  })

  it('still decodes legacy v1 links (btoa + encodeURIComponent, ids included)', async () => {
    const config = buildExercisedConfig()
    const decoded = await decodeFromHash(legacyEncode(config))
    expect(decoded).not.toBeNull()
    // Legacy links carried the ids, so this round-trip is exact (minus bg).
    const { backgroundImage: _bg, ...expected } = config
    expect(decoded).toEqual(expected)
  })

  it('is drastically shorter than the legacy encoding', async () => {
    const config = buildExercisedConfig()
    const { hash } = await encodeToHash(config)
    const legacy = legacyEncode(config)
    // The whole point of v2: deflate + base64url + no ids. Even this small
    // config should compress to well under a third of the legacy length.
    expect(hash.length).toBeLessThan(legacy.length / 3)
  })

  it('base64url output needs no percent-escaping in a URL', async () => {
    const { hash } = await encodeToHash(buildExercisedConfig())
    const body = hash.slice(1)
    expect(encodeURIComponent(body)).toBe(body)
  })

  it('returns null for garbage input instead of throwing', async () => {
    expect(await decodeFromHash('#not-valid-base64!!!')).toBeNull()
    expect(await decodeFromHash('')).toBeNull()
    expect(await decodeFromHash('#2.not-deflate-data')).toBeNull()
    expect(await decodeFromHash(btoa(encodeURIComponent('not json')))).toBeNull()
    // Valid JSON, but not a StagePlan chart (no `rows` array) — migrate()
    // throws "Not a StagePlan chart", which decodeFromHash swallows to null.
    expect(await decodeFromHash(btoa(encodeURIComponent(JSON.stringify({ foo: 'bar' }))))).toBeNull()
  })
})
