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

// Migrate older saved formats forward
function migrate(data: Record<string, unknown>): ChartConfig {
  const version = (data['version'] as number) ?? 0
  if (version === CURRENT_VERSION) return data as unknown as ChartConfig
  // Future migrations go here as version numbers increase
  return data as unknown as ChartConfig
}

// URL hash encoding — LZ-style compression via built-in btoa
export function encodeToHash(config: ChartConfig): string {
  const json = JSON.stringify(config)
  // btoa requires ASCII; encode UTF-8 safely
  const encoded = btoa(encodeURIComponent(json))
  return '#' + encoded
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
