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

/**
 * Encode a ChartConfig into a URL hash. The background image is stripped
 * because data-URL-encoded images blow past every browser's URL length
 * cap. Returns `strippedBackground: true` so callers can surface a warning
 * when the chart had a background that won't make the trip.
 */
export function encodeToHash(config: ChartConfig): { hash: string; strippedBackground: boolean } {
  const { backgroundImage, ...rest } = config
  const json = JSON.stringify(rest)
  // btoa requires ASCII; encode UTF-8 safely
  const encoded = btoa(encodeURIComponent(json))
  return { hash: '#' + encoded, strippedBackground: !!backgroundImage }
}

export function decodeFromHash(hash: string): ChartConfig | null {
  try {
    const encoded = hash.replace(/^#/, '')
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
