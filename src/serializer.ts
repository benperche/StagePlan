import type { ChartConfig } from './types'

const CURRENT_VERSION = 1

export function saveToJson(config: ChartConfig): void {
  const json = JSON.stringify({ ...config, version: CURRENT_VERSION }, null, 2)
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${config.title.replace(/\s+/g, '_') || 'seating_chart'}.json`
  a.click()
  URL.revokeObjectURL(url)
}

export function loadFromJson(file: File): Promise<ChartConfig> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target!.result as string)
        resolve(migrate(data))
      } catch {
        reject(new Error('Invalid chart file'))
      }
    }
    reader.onerror = () => reject(new Error('Could not read file'))
    reader.readAsText(file)
  })
}

// Migrate older saved formats forward. Throws on anything that isn't
// recognisably a StagePlan chart, so a stray JSON file or a corrupt share link
// surfaces a friendly error instead of replacing the chart with garbage.
function migrate(data: unknown): ChartConfig {
  if (!data || typeof data !== 'object' || !Array.isArray((data as { rows?: unknown }).rows)) {
    throw new Error('Not a StagePlan chart')
  }
  const rec = data as Record<string, unknown>
  const version = (rec['version'] as number) ?? 0
  if (version === CURRENT_VERSION) return data as unknown as ChartConfig
  // Future migrations go here as version numbers increase
  return data as unknown as ChartConfig
}

// ---------------------------------------------------------------------------
// Share-link hash encoding
// ---------------------------------------------------------------------------
//
// Current format ("2."-prefixed): strip everything regenerable or too big
// (backgroundImage, row/chair/instrument ids), deflate the JSON with the
// browser's native CompressionStream, and base64url the bytes. On a symphony
// chart this is ~1.3k chars vs ~24k for the legacy scheme — legacy stacked
// encodeURIComponent (3 bytes per JSON structural char) under base64 with no
// compression, on JSON that is mostly near-identical chair objects.
//
// The "2." prefix can never appear in legacy output (btoa's alphabet has no
// '.'), so decodeFromHash can dispatch on it and still read old links.

const HASH_PREFIX = '2.'

// base64url: '-'/'_' for '+'/'/' and no '=' padding, so the hash never needs
// percent-escaping in a URL (that escaping is exactly what bloated v1).
function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
  const bin = atob(padded)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

// Run bytes through a Compression/DecompressionStream. Blob→stream→Response
// is the terse portable way to collect a whole transformed stream.
async function pipeBytes(
  bytes: Uint8Array,
  transform: ReadableWritablePair<Uint8Array, BufferSource>,
): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(transform)
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

// Give every row / chair / fixed instrument a fresh id. Ids are runtime
// identity only, so they're stripped from share links (36 chars of
// incompressible UUID each — they tripled the compressed size) and minted
// anew on decode.
function restoreIds(config: ChartConfig): ChartConfig {
  for (const row of config.rows) {
    row.id ??= crypto.randomUUID()
    for (const chair of row.chairs) chair.id ??= crypto.randomUUID()
  }
  for (const inst of config.instruments ?? []) inst.id ??= crypto.randomUUID()
  return config
}

/**
 * Encode a ChartConfig into a URL hash. The background image is stripped
 * because data-URL-encoded images blow past every browser's URL length
 * cap. Returns `strippedBackground: true` so callers can surface a warning
 * when the chart had a background that won't make the trip.
 */
export async function encodeToHash(config: ChartConfig): Promise<{ hash: string; strippedBackground: boolean }> {
  const { backgroundImage, ...rest } = config
  const stripped = !!backgroundImage
  // Ancient browser without CompressionStream (pre-2023): fall back to the
  // legacy v1 encoding, which decodeFromHash still understands everywhere.
  if (typeof CompressionStream === 'undefined') {
    return { hash: '#' + btoa(encodeURIComponent(JSON.stringify(rest))), strippedBackground: stripped }
  }
  const lean = {
    ...rest,
    rows: rest.rows.map(({ id: _id, chairs, ...row }) => ({
      ...row,
      chairs: chairs.map(({ id: _cid, ...chair }) => chair),
    })),
    instruments: (rest.instruments ?? []).map(({ id: _iid, ...inst }) => inst),
  }
  const json = new TextEncoder().encode(JSON.stringify(lean))
  const compressed = await pipeBytes(json, new CompressionStream('deflate-raw'))
  return { hash: '#' + HASH_PREFIX + bytesToBase64Url(compressed), strippedBackground: stripped }
}

export async function decodeFromHash(hash: string): Promise<ChartConfig | null> {
  const encoded = hash.replace(/^#/, '')
  if (encoded.startsWith(HASH_PREFIX)) {
    try {
      const bytes = base64UrlToBytes(encoded.slice(HASH_PREFIX.length))
      const json = new TextDecoder().decode(await pipeBytes(bytes, new DecompressionStream('deflate-raw')))
      return restoreIds(migrate(JSON.parse(json)))
    } catch {
      return null
    }
  }
  // Legacy v1 links already shared stay loadable: btoa(encodeURIComponent(json)).
  try {
    const json = decodeURIComponent(atob(encoded))
    return migrate(JSON.parse(json))
  } catch {
    return null
  }
}

export function exportToPng(canvas: HTMLCanvasElement, title: string): void {
  canvas.toBlob((blob) => {
    if (!blob) return
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${title.replace(/\s+/g, '_') || 'seating_chart'}.png`
    a.click()
    URL.revokeObjectURL(url)
  }, 'image/png')
}
