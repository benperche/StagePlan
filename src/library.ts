// Browser-only chart library backed by IndexedDB. Charts and folders are
// stored in two separate object stores; folders can exist independently
// of charts so the user can set up a folder structure first and assign
// later. All data lives in this browser — clearing browser data wipes
// the library, which is why the Library tab carries a prominent warning
// and pushes users toward Save JSON for permanent backups.

import type { ChartConfig } from './types'

const DB_NAME = 'stageplan'
const DB_VERSION = 1

export interface SavedChart {
  id: string             // crypto.randomUUID
  title: string          // mirrors config.title at save time
  folder: string         // '' = unfiled / root
  createdAt: number      // Date.now()
  updatedAt: number
  config: ChartConfig
}

export interface Folder {
  name: string
}

let dbPromise: Promise<IDBDatabase> | null = null
function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('charts')) {
        db.createObjectStore('charts', { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains('folders')) {
        db.createObjectStore('folders', { keyPath: 'name' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

/** Wrap one IDBRequest as a promise inside a one-shot transaction. */
function run<T>(storeName: string, mode: IDBTransactionMode,
                action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(db => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(storeName, mode)
    const req = action(tx.objectStore(storeName))
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  }))
}

// --- Charts ---

export async function listCharts(): Promise<SavedChart[]> {
  return (await run<SavedChart[]>('charts', 'readonly', s => s.getAll()))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function loadChart(id: string): Promise<SavedChart | undefined> {
  return run<SavedChart | undefined>('charts', 'readonly', s => s.get(id))
}

/**
 * Insert-or-update a chart. If `id` is null, generates a new UUID and
 * sets createdAt; otherwise preserves whatever was there. Returns the id
 * (new or existing).
 */
export async function saveChart(
  id: string | null,
  title: string,
  folder: string,
  config: ChartConfig,
): Promise<string> {
  const now = Date.now()
  let record: SavedChart
  if (id) {
    const existing = await loadChart(id)
    record = {
      id,
      title,
      folder,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      config,
    }
  } else {
    record = { id: crypto.randomUUID(), title, folder, createdAt: now, updatedAt: now, config }
  }
  await run('charts', 'readwrite', s => s.put(record))
  return record.id
}

export async function deleteChart(id: string): Promise<void> {
  await run('charts', 'readwrite', s => s.delete(id))
}

export async function duplicateChart(id: string): Promise<string | null> {
  const chart = await loadChart(id)
  if (!chart) return null
  return saveChart(null, `${chart.title} (copy)`, chart.folder, chart.config)
}

export async function renameChart(id: string, newTitle: string): Promise<void> {
  const chart = await loadChart(id)
  if (!chart) return
  await run('charts', 'readwrite', s => s.put({ ...chart, title: newTitle, updatedAt: Date.now() }))
}

export async function moveChart(id: string, folder: string): Promise<void> {
  const chart = await loadChart(id)
  if (!chart) return
  await run('charts', 'readwrite', s => s.put({ ...chart, folder, updatedAt: Date.now() }))
}

// --- Folders ---

export async function listFolders(): Promise<string[]> {
  const arr = await run<Folder[]>('folders', 'readonly', s => s.getAll())
  return arr.map(f => f.name).sort()
}

export async function createFolder(name: string): Promise<void> {
  await run('folders', 'readwrite', s => s.put({ name }))
}

/**
 * Delete a folder. Charts that were in it become "unfiled" (folder set
 * to ''). This keeps the user's data — they just need to re-file the
 * charts if they want.
 */
export async function deleteFolder(name: string): Promise<void> {
  const charts = await listCharts()
  for (const c of charts) {
    if (c.folder === name) await moveChart(c.id, '')
  }
  await run('folders', 'readwrite', s => s.delete(name))
}
