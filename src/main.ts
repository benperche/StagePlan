import './style.css'
import { makeDefaultConfig, makeRow, makeInstrument, History, cloneConfig } from './state'
import { Renderer } from './renderer'
import {
  PRESETS, buildPreset, parseOrchestraNotation, describeComposition,
  type Preset,
} from './presets'
import { saveToJson, loadFromJson, encodeToHash, decodeFromHash, exportToPng } from './serializer'
import * as library from './library'
import type { ChartConfig, InstrumentType } from './types'

// --- App state ---
let config: ChartConfig = makeDefaultConfig()
const history = new History()
const renderer = new Renderer()

let activeColor = '#a8d8ea'
let activeTool: 'color' | 'toggle' | 'stand' | 'label' = 'toggle'

// When activeTool === 'label', clicking a chair sets its label to this string.
// Picked from the Allocate Instruments panel; null = nothing selected yet.
let selectedLabel: string | null = null

// Canonical instrument list, grouped by section (rough score order).
// Each instrument appears once — synonyms and instrument-key variants
// (Eb / Bb, TC / BC, etc.) are collapsed since the seating chart only
// needs one of each.
const INSTRUMENT_GROUPS: Array<{ name: string; items: string[] }> = [
  { name: 'Woodwinds', items: [
    'Piccolo', 'Flute', 'Oboe', 'Cor Anglais', 'Eb Clarinet', 'Clarinet',
    'Alto Clarinet', 'Bass Clarinet', 'Contrabass Clarinet', 'Bassoon', 'Contrabassoon',
  ] },
  { name: 'Saxophones', items: [
    'Soprano Sax', 'Alto Sax', 'Tenor Sax', 'Bari Sax', 'Bass Sax',
  ] },
  { name: 'Brass', items: [
    'Horn', 'Trumpet', 'Cornet', 'Flugelhorn', 'Trombone', 'Bass Trombone',
    'Baritone', 'Euphonium', 'Tuba',
  ] },
  { name: 'Strings', items: [
    'Violin', 'Viola', 'Cello', 'Double Bass',
  ] },
  { name: 'Rhythm and Keyboards', items: [
    'Piano', 'Keyboard', 'Organ', 'Harp', 'Celeste',
    'Guitar', 'Electric Guitar', 'Bass', 'Electric Bass',
  ] },
  { name: 'Percussion', items: [
    'Timpani', 'Drums', 'Snare Drum', 'Bass Drum', 'Cymbals', 'Tambourine',
    'Glockenspiel', 'Xylophone', 'Vibraphone', 'Marimba', 'Mallets',
    'Percussion', 'Auxiliary',
  ] },
  { name: 'Voices', items: ['Voice', 'Soprano', 'Alto', 'Tenor', 'Bass', 'Solo'] },
]

// Track which rows have their label editor open
const expandedRows = new Set<number>()

// Currently selected fixed instrument (for drag/inspector/delete)
let selectedInstrumentId: string | null = null

// Every drag tracks a pre-drag config snapshot (pushed to history only if
// the pointer actually moves, so click-to-select doesn't pollute undo) and
// a `moved` flag set when the threshold is crossed.
interface DragBase {
  preDragConfig: ChartConfig
  moved: boolean
}

// Instrument body drag — created on mousedown over an instrument, torn down
// on mouseup. Holds the pointer-to-centre offset so the instrument stays
// under the cursor as you drag.
interface DragState extends DragBase {
  instrumentId: string
  offsetX: number      // pointer x minus instrument centre x at drag start
  offsetY: number
}
let dragState: DragState | null = null

// Rotation drag — when the user grabs the green rotate handle. Records the
// instrument centre and the offset between the initial pointer angle and
// the instrument's rotation so the handle stays under the cursor.
interface RotateState extends DragBase {
  instrumentId: string
  centerX: number
  centerY: number
  initialPointerAngle: number   // atan2 from centre to pointer at mousedown
  initialRotation: number       // instrument.rotation at mousedown
}
let rotateState: RotateState | null = null

// Conductor drag — moves the conductor podium, which everything else
// (chairs and fixed instruments) is positioned relative to, so the entire
// chart translates as one unit. Pointer position at mousedown is stored so
// we can compute the delta on each move.
interface ConductorDragState extends DragBase {
  startX: number
  startY: number
  initialOffsetX: number
  initialOffsetY: number
}
let conductorDragState: ConductorDragState | null = null

// Set true on mouseup if a conductor drag actually moved.  The next click
// event consumes (and clears) this so we don't toggle conductor visibility
// at the end of a drag.
let suppressConductorClick = false

// All DOM refs live in dom.ts; pull them in by name.
import {
  canvas, tabButtons, tabContents, tabNavButtons,
  titleInput, layoutSelect, notesArea, showNumbersCheck, restartNumbersCheck,
  showRowLabelsCheck, conductorStandCheck, showArcCheck, showStageDirectionsCheck,
  chartScaleInput, bgInput, bgClearBtn, bgStatus, bgFitSelect, showCreditCheck,
  flipCheck, straightRowsInput, straightRowsLabel, arcRangeInput, arcRangeLabel,
  rowSpacingInput, rowCountInput, advancedBtn, advancedModal, advancedCloseBtn, rowsContainer,
  colorPicker, colorPickerLabel, undoBtn, redoBtn, resetPositionBtn, addRowBtn, saveBtn,
  loadInput, exportPngBtn, printBtn, shareLinkBtn, shareUrlDisplay, presetSelect, applyPresetBtn,
  libraryCurrentTitle, librarySaveBtn, libraryNewChartBtn, libraryNewFolderBtn,
  librarySearch, libraryList,
  customOrchestraBtn, customOrchestraModal, customOrchestraTitle, customOrchestraNotation,
  customOrchestraPreview, customOrchestraApply, customOrchestraCancel,
  toolButtons, instrumentPickerPanel, instrumentPickerList, instrumentPickerStatus,
  showTallyBtn, tallyOverlay, tallyBody, tallyTotal, tallyMinimizeBtn, tallyCloseBtn,
  addInstrumentButtons, inspector, inspectorType, inspectorLabel,
  inspectorCountLabel, inspectorCount, inspectorRotateLeft, inspectorRotateRight,
  inspectorDelete,
} from './dom'

// --- Init ---

function init() {
  if (location.hash) {
    const loaded = decodeFromHash(location.hash)
    if (loaded) config = loaded
  }
  migrateConfig(config)

  populatePresets()
  updateAllInputs()
  renderInspector()
  bindEvents()
  // setConfig isn't usable here yet (bindEvents hasn't wired things up
  // until after this returns). The default/hash-loaded path is the one
  // case where we mutate config in place and then sync everything below.
}

// Make older saved configs forward-compatible with newer schema fields.
// Fill in any newer fields that an older saved config might be missing,
// using makeDefaultConfig() as the source of truth. Mutates in place.
// (Defaults are spread first so anything the user actually set wins.)
function migrateConfig(c: ChartConfig) {
  const defaults = makeDefaultConfig()
  const merged = { ...defaults, ...c, conductor: { ...defaults.conductor, ...c.conductor } }
  Object.assign(c, merged)
}

/**
 * Swap the entire `config` for a new one (undo, redo, load JSON, hash-load)
 * and run the bookkeeping every replacement needs: schema migration,
 * collapse any open row label editors / instrument selection that no
 * longer refers to anything valid, push the new state to the sidebar, and
 * re-render the canvas. Use this any time the whole config is replaced
 * wholesale; for in-place mutations just call renderChart() directly.
 */
function setConfig(newConfig: ChartConfig) {
  config = newConfig
  migrateConfig(config)
  expandedRows.clear()
  setSelectedInstrument(null)
  updateAllInputs()
  renderChart()
}

// --- Library state ---
// The id of the chart currently loaded from the browser library, or null
// if the user is editing an unsaved/fresh chart. Used by the Save button
// to decide between "update in place" and "create new entry".
let currentChartId: string | null = null
let librarySearchText = ''

function updateLibraryCurrentTitle() {
  libraryCurrentTitle.textContent = currentChartId
    ? `My Charts — Editing "${config.title}"`
    : 'My Charts'
}

// --- Render ---

function renderChart() {
  resizeCanvas()
  renderer.render(canvas, config)
  undoBtn.disabled = !history.canUndo()
  redoBtn.disabled = !history.canRedo()
  renderTally()
}

// --- Instrument tally overlay ---
//
// Walks the chart and groups each distinct enabled chair label by its
// originating instrument's section in INSTRUMENT_GROUPS. Labels not
// recognised as belonging to any known instrument fall through to an
// "Other" bucket at the bottom. Re-rendered after every renderChart()
// call, but bails out early when the overlay is hidden so there's no
// cost while you're not looking at it.
function renderTally() {
  if (tallyOverlay.style.display === 'none') return

  // Pre-built sorted matcher list: longer names first so "Bass Clarinet"
  // wins over "Bass" when classifying a "Bass Clarinet 1" label.
  const matchers: Array<{ name: string; section: string; orderInSection: number }> = []
  INSTRUMENT_GROUPS.forEach(g => g.items.forEach((item, idx) =>
    matchers.push({ name: item, section: g.name, orderInSection: idx })))
  matchers.sort((a, b) => b.name.length - a.name.length)

  // Count every distinct (enabled) label in the chart
  const counts = new Map<string, number>()
  for (const row of config.rows) {
    for (const chair of row.chairs) {
      if (!chair.enabled || !chair.label) continue
      counts.set(chair.label, (counts.get(chair.label) ?? 0) + 1)
    }
  }

  // Bucket each label by section
  type TallyEntry = { label: string; count: number; baseOrder: number }
  const bySection = new Map<string, TallyEntry[]>()
  const other: TallyEntry[] = []
  counts.forEach((count, label) => {
    const match = matchers.find(m => label === m.name || label.startsWith(m.name + ' '))
    if (match) {
      if (!bySection.has(match.section)) bySection.set(match.section, [])
      bySection.get(match.section)!.push({ label, count, baseOrder: match.orderInSection })
    } else {
      other.push({ label, count, baseOrder: 0 })
    }
  })

  let totalChairs = 0
  const parts: string[] = []

  for (const group of INSTRUMENT_GROUPS) {
    const items = bySection.get(group.name)
    if (!items?.length) continue
    items.sort((a, b) => a.baseOrder - b.baseOrder || a.label.localeCompare(b.label))
    parts.push(`<div class="tally-section-heading">${group.name}</div>`)
    for (const { label, count } of items) {
      totalChairs += count
      parts.push(`<div class="tally-row"><span>${escapeHtml(label)}</span><span class="tally-count">${count}</span></div>`)
    }
  }
  if (other.length) {
    other.sort((a, b) => a.label.localeCompare(b.label))
    parts.push(`<div class="tally-section-heading">Other</div>`)
    for (const { label, count } of other) {
      totalChairs += count
      parts.push(`<div class="tally-row"><span>${escapeHtml(label)}</span><span class="tally-count">${count}</span></div>`)
    }
  }

  tallyBody.innerHTML = parts.length
    ? parts.join('')
    : `<p class="tally-empty">No labelled chairs yet. Pick an instrument in the panel on the left, then click chairs to assign.</p>`
  tallyTotal.textContent = totalChairs > 0
    ? `${totalChairs} labelled`
    : ''
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}

// Re-render once the background image finishes decoding.
renderer.onBackgroundLoaded = () => renderChart()

function resizeCanvas() {
  const container = canvas.parentElement!
  canvas.width = container.clientWidth
  canvas.height = Math.max(500, container.clientHeight)
}

// --- Library tab rendering ---

function fmtDate(t: number): string {
  const d = new Date(t)
  return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short' })
}

function escapeText(s: string): string {
  return s.replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}

/**
 * Rebuild the My Charts list from IndexedDB. Charts are grouped by
 * folder (with explicit empty folders shown too); the current loaded
 * chart is highlighted. Per-chart action buttons emit
 * `[data-lib-action]` so the click handler can dispatch by name.
 */
async function renderLibrary() {
  const [charts, folders] = await Promise.all([library.listCharts(), library.listFolders()])
  updateLibraryCurrentTitle()

  // Filter by search text
  const q = librarySearchText.trim().toLowerCase()
  const visible = q ? charts.filter(c => c.title.toLowerCase().includes(q)) : charts

  if (charts.length === 0 && folders.length === 0) {
    libraryList.innerHTML = '<p class="lib-empty">No saved charts yet. Click "Save current chart" above.</p>'
    return
  }

  // Bucket charts by folder
  const byFolder = new Map<string, library.SavedChart[]>()
  byFolder.set('', [])
  for (const f of folders) byFolder.set(f, [])
  for (const c of visible) {
    if (!byFolder.has(c.folder)) byFolder.set(c.folder, [])
    byFolder.get(c.folder)!.push(c)
  }

  // Build HTML — unfiled (root) first, then folders alphabetically
  const folderOrder = ['', ...Array.from(byFolder.keys()).filter(f => f !== '').sort()]
  const parts: string[] = []
  for (const folder of folderOrder) {
    const items = byFolder.get(folder) ?? []
    if (folder === '' && items.length === 0 && folders.length > 0) continue   // skip empty unfiled when folders exist
    const displayName = folder === '' ? 'Unfiled' : folder
    parts.push(`<details class="lib-folder" ${items.length > 0 || folder === '' ? 'open' : ''}>
      <summary>
        <span class="lib-folder-name">${escapeText(displayName)}</span>
        <span class="lib-folder-count">${items.length}</span>
        ${folder !== '' ? `<button class="lib-folder-delete" data-lib-action="delete-folder" data-folder="${escapeText(folder)}" title="Delete folder">✕</button>` : ''}
      </summary>`)
    if (items.length === 0) {
      parts.push('<div class="lib-chart-row"><span class="lib-empty" style="padding:6px 0">Empty</span></div>')
    }
    for (const c of items) {
      const current = c.id === currentChartId
      parts.push(`<div class="lib-chart-row${current ? ' current' : ''}">
        <button class="lib-chart-open" data-lib-action="open" data-id="${c.id}" title="Open ${escapeText(c.title)}">${escapeText(c.title)}</button>
        <span class="lib-chart-date">${fmtDate(c.updatedAt)}</span>
        <button class="lib-chart-action" data-lib-action="rename" data-id="${c.id}" title="Rename">✏</button>
        <button class="lib-chart-action" data-lib-action="duplicate" data-id="${c.id}" title="Duplicate">⎘</button>
        <button class="lib-chart-action" data-lib-action="move" data-id="${c.id}" title="Move to folder">📁</button>
        <button class="lib-chart-action danger" data-lib-action="delete" data-id="${c.id}" title="Delete">🗑</button>
      </div>`)
    }
    parts.push('</details>')
  }
  libraryList.innerHTML = parts.join('')
}

async function handleLibraryAction(action: string, id: string | null, folder: string | null) {
  if (action === 'open' && id) {
    const chart = await library.loadChart(id)
    if (!chart) return
    setConfig(chart.config)
    currentChartId = id
    updateLibraryCurrentTitle()
    await renderLibrary()
    return
  }
  if (action === 'rename' && id) {
    const chart = await library.loadChart(id)
    if (!chart) return
    const next = window.prompt('Rename chart:', chart.title)
    if (next === null || !next.trim()) return
    await library.renameChart(id, next.trim())
    if (id === currentChartId) config.title = next.trim()
    updateAllInputs()
    await renderLibrary()
    return
  }
  if (action === 'duplicate' && id) {
    await library.duplicateChart(id)
    await renderLibrary()
    return
  }
  if (action === 'move' && id) {
    const folders = await library.listFolders()
    const options = ['(unfiled)', ...folders]
    const choice = window.prompt(
      `Move to which folder?\n\nExisting folders:\n${options.map((f, i) => `  ${i + 1}. ${f}`).join('\n')}\n\nType the number, the folder name, or a new folder name:`)
    if (choice === null) return
    let target: string
    const num = Number(choice)
    if (!isNaN(num) && num >= 1 && num <= options.length) {
      target = num === 1 ? '' : options[num - 1]
    } else if (choice.trim().toLowerCase() === '(unfiled)' || choice.trim() === '') {
      target = ''
    } else {
      target = choice.trim()
      if (target && !folders.includes(target)) await library.createFolder(target)
    }
    await library.moveChart(id, target)
    await renderLibrary()
    return
  }
  if (action === 'delete' && id) {
    const chart = await library.loadChart(id)
    if (!chart) return
    if (!window.confirm(`Delete "${chart.title}"? This cannot be undone.`)) return
    await library.deleteChart(id)
    if (currentChartId === id) currentChartId = null
    updateLibraryCurrentTitle()
    await renderLibrary()
    return
  }
  if (action === 'delete-folder' && folder !== null) {
    if (!window.confirm(`Delete folder "${folder}"? Any charts inside will become Unfiled.`)) return
    await library.deleteFolder(folder)
    await renderLibrary()
    return
  }
}

// --- Sync inputs → config ---

// --- Input ↔ config bindings ---
//
// Every form control in the sidebar/advanced modal is registered here with
// a paired getter (config → string/bool/number) and setter (input → config),
// including any unit conversion or clamping. readInputs() iterates the
// setters, updateAllInputs() iterates the getters — so adding a new field
// is one bind* call instead of remembering to update two unrelated blocks.
const fieldReaders: Array<() => void> = []   // input → config
const fieldWriters: Array<() => void> = []   // config → input

function bindText(
  el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  get: () => string,
  set: (v: string) => void,
) {
  fieldReaders.push(() => set(el.value))
  fieldWriters.push(() => { el.value = get() })
}
function bindBool(el: HTMLInputElement, get: () => boolean, set: (v: boolean) => void) {
  fieldReaders.push(() => set(el.checked))
  fieldWriters.push(() => { el.checked = get() })
}
function bindNumber(el: HTMLInputElement, get: () => number, set: (v: number) => void) {
  fieldReaders.push(() => set(Number(el.value)))
  fieldWriters.push(() => { el.value = String(get()) })
}

bindText(titleInput, () => config.title, v => { config.title = v })
bindText(layoutSelect, () => config.layout, v => { config.layout = v as ChartConfig['layout'] })
bindText(notesArea, () => config.notes, v => { config.notes = v })
bindBool(showNumbersCheck, () => config.showNumbers, v => { config.showNumbers = v })
bindBool(restartNumbersCheck, () => config.numberRestartPerRow, v => { config.numberRestartPerRow = v })
bindBool(showRowLabelsCheck, () => config.showRowLabels, v => { config.showRowLabels = v })
bindBool(conductorStandCheck, () => config.conductor.hasStand, v => { config.conductor.hasStand = v })
bindBool(flipCheck, () => config.flipped, v => { config.flipped = v })
bindBool(showArcCheck, () => config.showArc, v => { config.showArc = v })
bindBool(showStageDirectionsCheck, () => config.showStageDirections, v => { config.showStageDirections = v })
bindBool(showCreditCheck, () => config.showCredit, v => { config.showCredit = v })
bindNumber(chartScaleInput,
  () => Math.round(config.chartScale * 100),
  v => { config.chartScale = Math.max(50, Math.min(200, v || 100)) / 100 })
bindText(bgFitSelect,
  () => config.backgroundFit,
  v => { if (v === 'contain' || v === 'cover' || v === 'stretch') config.backgroundFit = v })
bindNumber(straightRowsInput,
  () => config.straightRows,
  v => {
    config.straightRows = Math.max(0, Math.min(config.rows.length, v || 0))
    // Clear all per-row isStraight overrides so the new global default
    // takes effect everywhere — otherwise a user who had toggled
    // individual rows would see a stale state.
    for (const row of config.rows) delete row.isStraight
  })
bindNumber(rowCountInput,
  () => config.rows.length,
  v => {
    const target = Math.max(1, Math.min(20, v || 1))
    while (config.rows.length < target) {
      config.rows.push(makeRow(8, String(config.rows.length + 1)))
    }
    while (config.rows.length > target) {
      config.rows.pop()
    }
  })
bindNumber(arcRangeInput,
  () => Math.round((config.arcRange * 180) / Math.PI),
  v => { config.arcRange = (Math.max(60, Math.min(180, v || 180)) * Math.PI) / 180 })
bindNumber(rowSpacingInput,
  () => config.rowSpacing,
  v => { config.rowSpacing = Math.max(50, Math.min(120, v || 70)) })

function readInputs() {
  history.push(config)
  fieldReaders.forEach(r => r())
}

// --- Sync config → inputs ---

function updateAllInputs() {
  fieldWriters.forEach(w => w())
  // Special cases that don't fit a simple two-way bind:
  bgClearBtn.disabled = !config.backgroundImage
  bgStatus.textContent = config.backgroundImage ? 'Background loaded.' : 'No background.'
  straightRowsInput.max = String(config.rows.length)
  // Only show semicircle-specific controls in semicircle mode
  straightRowsLabel.style.display = config.layout === 'semicircle' ? '' : 'none'
  arcRangeLabel.style.display = config.layout === 'semicircle' ? '' : 'none'
  renderRowList()
}

// --- Row list UI ---

function renderRowList() {
  // Remember scroll position so the list doesn't jump after a rebuild
  const scrollTop = rowsContainer.scrollTop
  rowsContainer.innerHTML = ''

  const numRows = config.rows.length
  // For each row, decide whether it currently renders as straight, taking
  // both the per-row override and the global "last N from back" into account.
  const straightFlags = config.rows.map((row, i) =>
    row.isStraight ?? (i >= numRows - config.straightRows))

  // Warn if a straight row sits in front of an arc row (i.e. straight rows
  // are not all at the back). That layout can produce visual clashes
  // because the wider arc behind a straight row sweeps past its chairs.
  let seenStraight = false
  let interleaved = false
  for (const s of straightFlags) {
    if (s) seenStraight = true
    else if (seenStraight) { interleaved = true; break }
  }

  if (interleaved && config.layout === 'semicircle') {
    const warn = document.createElement('p')
    warn.className = 'row-warning'
    warn.textContent = '⚠ Some straight rows sit in front of arc rows — the arcs may visually clash with the straight rows behind them.'
    rowsContainer.appendChild(warn)
  }

  config.rows.forEach((row, i) => {
    const isExpanded = expandedRows.has(i)
    const labelsText = row.chairs.map(c => c.label).join('\n')
    const taRows = Math.min(12, Math.max(3, row.chairs.length))
    const isStraight = straightFlags[i]

    const div = document.createElement('div')
    div.className = 'row-item'
    div.innerHTML = `
      <div class="row-item-header">
        <button class="row-edit-toggle ${isExpanded ? 'active' : ''}" data-row="${i}" title="Edit chair labels">
          Row ${row.label}
        </button>
        <label>Chairs
          <input type="number" min="1" max="30" value="${row.chairs.length}" data-row="${i}" class="chair-count">
        </label>
        <label>Label
          <input type="text" maxlength="6" value="${row.label}" data-row="${i}" class="row-label-input">
        </label>
        <button data-row="${i}" class="remove-row-btn" ${config.rows.length <= 1 ? 'disabled' : ''}>✕</button>
      </div>
      <div class="row-item-meta">
        <label class="row-straight-toggle"><input type="checkbox" data-row="${i}" class="row-straight-check" ${isStraight ? 'checked' : ''}> Straight row</label>
      </div>
      <div class="row-item-labels" ${isExpanded ? '' : 'style="display:none"'}>
        <p class="label-editor-hint">One label per line · use % for a line‑break within a label · Tab/Shift‑Tab to move between rows</p>
        <textarea class="chair-labels-ta" data-row="${i}" rows="${taRows}">${labelsText}</textarea>
      </div>
    `
    rowsContainer.appendChild(div)
  })

  rowsContainer.scrollTop = scrollTop
}

// --- Instrument inspector ---

const INSTRUMENT_LABEL: Record<InstrumentType, string> = {
  'drumkit': 'Drum Kit',
  'piano': 'Grand Piano',
  'guitar-amp': 'Guitar Amp',
  'bass-amp': 'Bass Amp',
  'timpani': 'Timpani',
  'mallet': 'Mallets',
  'harp': 'Harp',
  'chair': 'Chair',
  'stand': 'Stand',
  'square': 'Square',
  'rectangle': 'Rectangle',
}

function renderInspector() {
  const inst = config.instruments.find(i => i.id === selectedInstrumentId)
  if (!inst) {
    inspector.style.display = 'none'
    return
  }
  inspector.style.display = 'block'
  inspectorType.textContent = INSTRUMENT_LABEL[inst.type]
  inspectorLabel.value = inst.label ?? ''
  inspectorLabel.placeholder = INSTRUMENT_LABEL[inst.type]

  if (inst.type === 'timpani') {
    inspectorCountLabel.style.display = ''
    inspectorCount.value = String(inst.count ?? 4)
  } else {
    inspectorCountLabel.style.display = 'none'
  }
}

function setSelectedInstrument(id: string | null) {
  selectedInstrumentId = id
  renderer.selectedInstrumentId = id
  renderInspector()
}

function pointerCanvasCoords(e: MouseEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect()
  return { x: e.clientX - rect.left, y: e.clientY - rect.top }
}

// Inverse of the renderer's chart-scale transform: takes a raw canvas
// pixel and returns the matching point in chart coordinates. Hit targets
// (chair / instrument / conductor / rotate-handle) are stored in chart
// coords, so pointer events must be transformed through this before any
// hitTest call.
function canvasToChart(x: number, y: number): { x: number; y: number } {
  const scale = config.chartScale ?? 1
  if (scale === 1) return { x, y }
  const { ox, oy } = renderer.conductorOrigin
  return { x: (x - ox) / scale + ox, y: (y - oy) / scale + oy }
}

// --- Presets ---

function populatePresets() {
  PRESETS.forEach(preset => {
    const opt = document.createElement('option')
    opt.value = preset.id
    opt.textContent = preset.name
    presetSelect.appendChild(opt)
  })
}

function applyPreset(preset: Preset) {
  const built = buildPreset(preset)
  if (!built.ok) {
    alert(built.error)
    return
  }

  history.push(config)
  config.rows = built.rows
  config.layout = preset.layout
  config.title = preset.name
  config.straightRows = built.straightRows
  config.instruments = built.instruments

  expandedRows.clear()
  setSelectedInstrument(null)
  updateAllInputs()
  renderChart()
}

// --- Canvas interaction ---

const DRAG_THRESHOLD = 4   // pixels before a mousedown is treated as a drag

canvas.addEventListener('mousedown', (e) => {
  const cv = pointerCanvasCoords(e)
  const { x, y } = canvasToChart(cv.x, cv.y)

  // Red ✕ delete handle (present only on the selected instrument) takes
  // first priority so it isn't blocked by the rotate handle or the body.
  if (renderer.deleteHandleHitTest(x, y) && selectedInstrumentId) {
    history.push(config)
    config.instruments = config.instruments.filter(i => i.id !== selectedInstrumentId)
    setSelectedInstrument(null)
    renderChart()
    return
  }

  // Rotate handle (only present for the selected instrument) takes priority
  if (renderer.rotateHandleHitTest(x, y)) {
    const inst = config.instruments.find(i => i.id === selectedInstrumentId)
    if (inst) {
      const { ox, oy, flipped } = renderer.conductorOrigin
      // When the chart is flipped, the instrument is rendered at the
      // 180°-rotated position around the conductor. Recompute the rendered
      // centre so the rotate handle's pivot matches what the user sees.
      const mirror = flipped ? -1 : 1
      const cx = ox + mirror * inst.distance * Math.cos(inst.angle)
      const cy = oy + mirror * inst.distance * Math.sin(inst.angle)
      rotateState = {
        instrumentId: inst.id,
        centerX: cx,
        centerY: cy,
        initialPointerAngle: Math.atan2(y - cy, x - cx),
        initialRotation: inst.rotation,
        preDragConfig: cloneConfig(config),
        moved: false,
      }
      return
    }
  }

  // Instrument body hit takes priority over chairs (drawn on top)
  const instHit = renderer.instrumentHitTest(x, y)
  if (instHit) {
    // Music Stand tool + click on a fixed instrument = toggle a stand
    // attached to that instrument (drawn between it and the conductor).
    // Don't start a drag in this mode — the user's intent is clearly to
    // place/remove the stand.
    if (activeTool === 'stand') {
      const inst = config.instruments.find(i => i.id === instHit.id)
      if (inst) {
        history.push(config)
        inst.hasStand = !inst.hasStand
        setSelectedInstrument(inst.id)
        renderChart()
      }
      return
    }
    setSelectedInstrument(instHit.id)
    dragState = {
      instrumentId: instHit.id,
      offsetX: x - instHit.cx,
      offsetY: y - instHit.cy,
      preDragConfig: cloneConfig(config),
      moved: false,
    }
    renderChart()
    return
  }

  // Conductor: prepare for potential drag.  If the pointer never moves
  // beyond the threshold, the click handler will fire and toggle visibility.
  if (renderer.conductorHitTest(x, y)) {
    // Conductor offset is stored in canvas pixels (it determines where the
    // conductor lands on the canvas, independent of chartScale). So the
    // drag-start cursor is recorded in RAW canvas coords too.
    conductorDragState = {
      startX: cv.x,
      startY: cv.y,
      initialOffsetX: config.conductor.offsetX,
      initialOffsetY: config.conductor.offsetY,
      preDragConfig: cloneConfig(config),
      moved: false,
    }
    if (selectedInstrumentId) {
      setSelectedInstrument(null)
      renderChart()
    }
    return
  }

  // Click on empty canvas / chair deselects any instrument.
  if (selectedInstrumentId) {
    setSelectedInstrument(null)
    renderChart()
  }
})

window.addEventListener('mousemove', (e) => {
  const cv = pointerCanvasCoords(e)

  // Conductor drag — moves the whole chart (chairs and instruments are all
  // positioned relative to the conductor, so they translate as one unit).
  // Uses raw canvas delta because the conductor offset is in canvas pixels.
  const cdrag = conductorDragState
  if (cdrag) {
    const dx = cv.x - cdrag.startX
    const dy = cv.y - cdrag.startY
    if (!cdrag.moved) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return
      history.push(cdrag.preDragConfig)
      cdrag.moved = true
    }
    config.conductor.offsetX = cdrag.initialOffsetX + dx
    config.conductor.offsetY = cdrag.initialOffsetY + dy
    renderChart()
    return
  }

  // Rotate / instrument drags both work in chart coordinates so the
  // pointer tracks the instrument 1:1 regardless of chartScale.
  const { x, y } = canvasToChart(cv.x, cv.y)

  // Rotation drag — pointer angle around instrument centre drives rotation
  const rot = rotateState
  if (rot) {
    const inst = config.instruments.find(i => i.id === rot.instrumentId)
    if (!inst) return
    const pointerAngle = Math.atan2(y - rot.centerY, x - rot.centerX)
    const delta = pointerAngle - rot.initialPointerAngle
    const newRotation = rot.initialRotation + delta

    if (!rot.moved) {
      // Push history once the rotation has actually moved a few degrees
      if (Math.abs(delta) < 0.04) return
      history.push(rot.preDragConfig)
      rot.moved = true
    }
    inst.rotation = newRotation
    renderChart()
    return
  }

  // Translation drag — pointer drags the instrument across the chart
  const drag = dragState
  if (!drag) return

  const inst = config.instruments.find(i => i.id === drag.instrumentId)
  if (!inst) return

  // New instrument centre = pointer minus the grab offset
  const newCx = x - drag.offsetX
  const newCy = y - drag.offsetY
  const { ox, oy, flipped } = renderer.conductorOrigin
  // Stored polar (angle, distance) is in the unflipped frame. When the
  // chart is flipped (180° rotation around the conductor), the rendered
  // position is the negated polar offset, so we negate the canvas-space
  // dx/dy before computing the stored angle.
  const mirror = flipped ? -1 : 1

  // Threshold check: only treat as drag (and push history) once we've
  // moved meaningfully from the original instrument centre.
  if (!drag.moved) {
    const oldCx = ox + mirror * inst.distance * Math.cos(inst.angle)
    const oldCy = oy + mirror * inst.distance * Math.sin(inst.angle)
    if (Math.hypot(newCx - oldCx, newCy - oldCy) < DRAG_THRESHOLD) return
    history.push(drag.preDragConfig)
    drag.moved = true
  }

  const dx = newCx - ox
  const dy = newCy - oy
  inst.angle = Math.atan2(mirror * dy, mirror * dx)
  inst.distance = Math.hypot(dx, dy)
  renderChart()
})

window.addEventListener('mouseup', () => {
  if (conductorDragState?.moved) suppressConductorClick = true
  dragState = null
  rotateState = null
  conductorDragState = null
})

// Click handler runs after mouseup. Skip if the click landed on an instrument
// or its rotate handle (already handled in mousedown) so chair/conductor logic
// doesn't fire on top.
canvas.addEventListener('click', (e) => {
  const cv = pointerCanvasCoords(e)
  const { x, y } = canvasToChart(cv.x, cv.y)
  if (renderer.deleteHandleHitTest(x, y)) return
  if (renderer.rotateHandleHitTest(x, y)) return
  if (renderer.instrumentHitTest(x, y)) return

  // Conductor toggle takes priority — but if the user just finished
  // dragging the podium, skip the toggle (consume the suppression flag).
  if (renderer.conductorHitTest(x, y)) {
    if (suppressConductorClick) {
      suppressConductorClick = false
      return
    }
    history.push(config)
    config.conductor.show = !config.conductor.show
    renderChart()
    return
  }

  const hit = renderer.hitTest(x, y)
  if (!hit) return
  // Label tool with no instrument picked yet — no-op (don't pollute undo).
  if (activeTool === 'label' && selectedLabel === null) return

  history.push(config)
  const chair = config.rows[hit.rowIndex].chairs[hit.chairIndex]

  if (activeTool === 'label') {
    chair.label = selectedLabel!
  } else if (activeTool === 'color') {
    chair.color = activeColor
  } else if (activeTool === 'toggle') {
    chair.enabled = !chair.enabled
  } else if (activeTool === 'stand') {
    const rowChairs = config.rows[hit.rowIndex].chairs
    const isLast = hit.chairIndex === rowChairs.length - 1
    if (!chair.hasStand && !chair.standAfter) {
      chair.hasStand = true
    } else if (chair.hasStand) {
      // Solo → shared with next. Drop the next chair's own stand, since
      // they're now sharing this one — otherwise you'd see both a stand
      // between the two chairs AND a stand in front of the next chair.
      chair.hasStand = false
      if (!isLast) {
        chair.standAfter = true
        const nextChair = rowChairs[hit.chairIndex + 1]
        if (nextChair) nextChair.hasStand = false
      }
    } else {
      chair.standAfter = false
    }
  }

  renderChart()
})

// --- Events ---

function bindEvents() {
  for (const el of [titleInput, layoutSelect, notesArea, showNumbersCheck,
    restartNumbersCheck, showRowLabelsCheck, conductorStandCheck, flipCheck,
    straightRowsInput, rowCountInput, showArcCheck, arcRangeInput, rowSpacingInput,
    showStageDirectionsCheck, chartScaleInput, bgFitSelect, showCreditCheck]) {
    el.addEventListener('change', () => { readInputs(); updateAllInputs(); renderChart() })
  }

  // Row list: chair count + row-label changes
  rowsContainer.addEventListener('change', (e) => {
    const target = e.target as HTMLInputElement
    const rowIdx = Number(target.dataset['row'])
    if (isNaN(rowIdx)) return
    history.push(config)

    if (target.classList.contains('chair-count')) {
      const count = Math.max(1, Math.min(30, Number(target.value)))
      const current = config.rows[rowIdx].chairs
      if (count > current.length) {
        for (let i = current.length; i < count; i++) {
          current.push({ id: crypto.randomUUID(), enabled: true, color: '#e8e8e8', label: '', hasStand: false, standAfter: false })
        }
      } else {
        config.rows[rowIdx].chairs = current.slice(0, count)
      }
    } else if (target.classList.contains('row-label-input')) {
      config.rows[rowIdx].label = target.value
      renderRowList()
    } else if (target.classList.contains('row-straight-check')) {
      // Per-row straight/arc override. Setting this wins over the global
      // "straight rows from back" default in the Setup tab.
      config.rows[rowIdx].isStraight = target.checked
      renderRowList()
    }
    renderChart()
  })

  // Row list: toggle label editor + remove row
  rowsContainer.addEventListener('click', (e) => {
    const target = e.target as HTMLElement

    if (target.classList.contains('row-edit-toggle')) {
      const rowIdx = Number(target.dataset['row'])
      if (isNaN(rowIdx)) return
      if (expandedRows.has(rowIdx)) {
        expandedRows.delete(rowIdx)
      } else {
        expandedRows.add(rowIdx)
      }
      renderRowList()
      // Focus the textarea if we just opened it
      if (expandedRows.has(rowIdx)) {
        const ta = rowsContainer.querySelector<HTMLTextAreaElement>(`.chair-labels-ta[data-row="${rowIdx}"]`)
        ta?.focus()
      }
      return
    }

    if (target.classList.contains('remove-row-btn')) {
      const rowIdx = Number(target.dataset['row'])
      if (isNaN(rowIdx) || config.rows.length <= 1) return
      history.push(config)
      config.rows.splice(rowIdx, 1)
      config.straightRows = Math.min(config.straightRows, config.rows.length)
      expandedRows.clear()
      updateAllInputs()
      renderChart()
    }
  })

  // Chair label editor — real-time update on every keystroke
  rowsContainer.addEventListener('input', (e) => {
    const target = e.target as HTMLTextAreaElement
    if (!target.classList.contains('chair-labels-ta')) return
    const rowIdx = Number(target.dataset['row'])
    if (isNaN(rowIdx)) return
    const lines = target.value.split('\n')
    config.rows[rowIdx].chairs.forEach((chair, i) => {
      chair.label = lines[i] ?? ''
    })
    renderChart()
  })

  // Chair label editor — push to history on blur (not on every keystroke)
  rowsContainer.addEventListener('focusout', (e) => {
    const target = e.target as HTMLElement
    if (!target.classList.contains('chair-labels-ta')) return
    history.push(config)
  })

  // Tab / Shift+Tab moves between row label editors
  rowsContainer.addEventListener('keydown', (e) => {
    const target = e.target as HTMLTextAreaElement
    if (!target.classList.contains('chair-labels-ta')) return
    if (e.key !== 'Tab') return

    e.preventDefault()
    const rowIdx = Number(target.dataset['row'])
    const nextIdx = e.shiftKey ? rowIdx - 1 : rowIdx + 1

    if (nextIdx < 0 || nextIdx >= config.rows.length) return

    // Open the destination editor if not already open
    expandedRows.add(nextIdx)
    renderRowList()

    const nextTa = rowsContainer.querySelector<HTMLTextAreaElement>(`.chair-labels-ta[data-row="${nextIdx}"]`)
    nextTa?.focus()
  })

  // Add fixed instrument
  addInstrumentButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const type = btn.dataset['addInstrument'] as InstrumentType
      history.push(config)
      const sameTypeCount = config.instruments.filter(i => i.type === type).length
      const inst = makeInstrument(type, config.flipped, sameTypeCount)
      config.instruments.push(inst)
      setSelectedInstrument(inst.id)
      renderChart()
    })
  })

  // Inspector — label edit
  inspectorLabel.addEventListener('input', () => {
    const inst = config.instruments.find(i => i.id === selectedInstrumentId)
    if (!inst) return
    inst.label = inspectorLabel.value || undefined
    renderChart()
  })
  inspectorLabel.addEventListener('focus', () => { history.push(config) })

  // Inspector — timpani drum count
  inspectorCount.addEventListener('input', () => {
    const inst = config.instruments.find(i => i.id === selectedInstrumentId)
    if (!inst || inst.type !== 'timpani') return
    history.push(config)
    inst.count = Math.max(2, Math.min(6, Number(inspectorCount.value) || 4))
    renderChart()
  })

  // Inspector — rotate buttons (15° increments)
  const rotateBy = (delta: number) => {
    const inst = config.instruments.find(i => i.id === selectedInstrumentId)
    if (!inst) return
    history.push(config)
    inst.rotation = (inst.rotation + delta) % (Math.PI * 2)
    renderChart()
  }
  inspectorRotateLeft.addEventListener('click', () => rotateBy(-Math.PI / 12))
  inspectorRotateRight.addEventListener('click', () => rotateBy(Math.PI / 12))

  // Inspector — delete
  inspectorDelete.addEventListener('click', () => {
    if (!selectedInstrumentId) return
    history.push(config)
    config.instruments = config.instruments.filter(i => i.id !== selectedInstrumentId)
    setSelectedInstrument(null)
    renderChart()
  })

  addRowBtn.addEventListener('click', () => {
    history.push(config)
    config.rows.push(makeRow(8, String(config.rows.length + 1)))
    updateAllInputs()
    renderChart()
  })

  // Sidebar tab navigation (Setup / Edit / Export). Both the top tab
  // buttons and the bottom Next/Back nav buttons end up calling this.
  const switchTab = (tab: string | undefined) => {
    if (!tab) return
    tabButtons.forEach(b => b.classList.toggle('active', b.dataset['tab'] === tab))
    tabContents.forEach(c => c.classList.toggle('active', c.dataset['tabContent'] === tab))
    // Scroll the sidebar back to the top so Next/Back doesn't strand the
    // user partway down the new tab.
    document.getElementById('sidebar')?.scrollTo({ top: 0 })
    // Library tab is async: refresh the list whenever it becomes visible
    // so any saves made elsewhere show up.
    if (tab === 'library') renderLibrary()
  }
  tabButtons.forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset['tab'])))
  tabNavButtons.forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset['tabNav'])))

  // Tool selection
  toolButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      activeTool = btn.dataset['tool'] as typeof activeTool
      toolButtons.forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      colorPickerLabel.style.display = activeTool === 'color' ? '' : 'none'
      instrumentPickerPanel.style.display = activeTool === 'label' ? '' : 'none'
      if (activeTool === 'color') colorPicker.click()
      if (activeTool === 'label') renderInstrumentPicker()
    })
  })

  // Build the Allocate Instruments panel: one row per instrument with a
  // wide [Name] button and three narrow [1] [2] [3] part-number buttons.
  // Clicking any button sets `selectedLabel` and highlights itself; the
  // next chair click in label mode writes that string into chair.label.
  function renderInstrumentPicker() {
    if (instrumentPickerList.children.length > 0) return   // already built
    INSTRUMENT_GROUPS.forEach(group => {
      // Native <details> gives us a free toggle + keyboard accessibility.
      // All sections start collapsed — open the one you want and the rest
      // stay tucked away.
      const details = document.createElement('details')
      details.className = 'instrument-group'
      const summary = document.createElement('summary')
      summary.className = 'instrument-group-heading'
      summary.textContent = group.name
      details.appendChild(summary)
      group.items.forEach(name => {
        const row = document.createElement('div')
        row.className = 'instrument-row'
        const makeBtn = (text: string, label: string, isName: boolean) => {
          const b = document.createElement('button')
          b.textContent = text
          b.className = isName ? 'instrument-name' : 'instrument-num'
          b.dataset['label'] = label
          b.addEventListener('click', () => {
            selectedLabel = label
            instrumentPickerList.querySelectorAll('.active').forEach(el => el.classList.remove('active'))
            b.classList.add('active')
            instrumentPickerStatus.textContent = `Selected: "${label}". Click any chair to apply.`
          })
          return b
        }
        row.appendChild(makeBtn(name, name, true))
        for (const n of [1, 2, 3]) {
          row.appendChild(makeBtn(String(n), `${name} ${n}`, false))
        }
        details.appendChild(row)
      })
      instrumentPickerList.appendChild(details)
    })
  }

  // Show / hide / minimise the floating tally overlay.
  showTallyBtn.addEventListener('click', () => {
    // Toggle: a second click on the picker button closes the overlay too.
    if (tallyOverlay.style.display === 'none' || !tallyOverlay.style.display) {
      tallyOverlay.style.display = 'flex'
      tallyOverlay.classList.remove('minimized')
      renderTally()
    } else {
      tallyOverlay.style.display = 'none'
    }
  })
  tallyCloseBtn.addEventListener('click', () => { tallyOverlay.style.display = 'none' })
  tallyMinimizeBtn.addEventListener('click', () => {
    tallyOverlay.classList.toggle('minimized')
    tallyMinimizeBtn.textContent = tallyOverlay.classList.contains('minimized') ? '+' : '–'
  })

  colorPicker.addEventListener('input', () => {
    activeColor = colorPicker.value
  })

  // Undo / redo
  undoBtn.addEventListener('click', () => {
    const prev = history.undo(config)
    if (prev) setConfig(prev)
  })
  redoBtn.addEventListener('click', () => {
    const next = history.redo(config)
    if (next) setConfig(next)
  })
  resetPositionBtn.addEventListener('click', () => {
    if (config.conductor.offsetX === 0 && config.conductor.offsetY === 0) return
    history.push(config)
    config.conductor.offsetX = 0
    config.conductor.offsetY = 0
    renderChart()
  })
  document.addEventListener('keydown', (e) => {
    // Close any open modal on Escape
    if (e.key === 'Escape') {
      if (customOrchestraModal.style.display !== 'none') {
        customOrchestraModal.style.display = 'none'
        return
      }
      if (advancedModal.style.display !== 'none') {
        advancedModal.style.display = 'none'
        return
      }
    }

    if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
      e.preventDefault()
      const prev = history.undo(config)
      if (prev) setConfig(prev)
    }
    if ((e.metaKey || e.ctrlKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
      e.preventDefault()
      const next = history.redo(config)
      if (next) setConfig(next)
    }

    // Delete selected instrument (Delete or Backspace) — but only when not
    // typing into an input/textarea, so users can still backspace text.
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedInstrumentId) {
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return
      e.preventDefault()
      history.push(config)
      config.instruments = config.instruments.filter(i => i.id !== selectedInstrumentId)
      setSelectedInstrument(null)
      renderChart()
    }
  })

  // Save / load
  saveBtn.addEventListener('click', () => saveToJson(config))
  loadInput.addEventListener('change', async () => {
    const file = loadInput.files?.[0]
    if (!file) return
    try {
      setConfig(await loadFromJson(file))
      // Loaded from disk → no library entry yet. Next Save creates one.
      currentChartId = null
      updateLibraryCurrentTitle()
    } catch {
      alert('Could not load chart file.')
    }
    loadInput.value = ''
  })

  // Background image upload — store the file as a data URL so it serialises
  // with the chart JSON. The renderer caches the decoded HTMLImageElement
  // and fires onBackgroundLoaded to trigger a re-render once it's ready.
  bgInput.addEventListener('change', () => {
    const file = bgInput.files?.[0]
    if (!file) return
    if (!file.type.startsWith('image/')) {
      alert('Please choose an image file.')
      bgInput.value = ''
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      history.push(config)
      config.backgroundImage = String(reader.result)
      updateAllInputs()
      renderChart()
    }
    reader.onerror = () => alert('Could not read image file.')
    reader.readAsDataURL(file)
    bgInput.value = ''
  })
  bgClearBtn.addEventListener('click', () => {
    if (!config.backgroundImage) return
    history.push(config)
    config.backgroundImage = undefined
    updateAllInputs()
    renderChart()
  })

  exportPngBtn.addEventListener('click', () => exportToPng(canvas, config.title))

  // Print → triggers the browser print dialog. The @media print CSS in
  // style.css hides every UI control, leaving only the canvas centred on
  // the page. Users can then pick "Save as PDF" from the print dialog to
  // get a PDF for free with no extra dependencies.
  printBtn.addEventListener('click', () => window.print())

  // --- Library tab ---
  librarySaveBtn.addEventListener('click', async () => {
    // If we have a current chart loaded, update it in place. Otherwise
    // create a new entry — title defaults to config.title but the user
    // gets a quick prompt so they can adjust.
    let title = config.title || 'Untitled'
    let folder = ''
    if (currentChartId) {
      const existing = await library.loadChart(currentChartId)
      if (existing) {
        title = config.title || existing.title
        folder = existing.folder
      }
    } else {
      const next = window.prompt('Save chart as:', title)
      if (next === null) return
      title = next.trim() || 'Untitled'
    }
    const id = await library.saveChart(currentChartId, title, folder, config)
    currentChartId = id
    updateLibraryCurrentTitle()
    await renderLibrary()
  })

  libraryNewChartBtn.addEventListener('click', () => {
    if (currentChartId && !window.confirm('Discard current chart and start a new blank one? Anything unsaved here will be lost — use Save first if you want to keep it.')) return
    setConfig(makeDefaultConfig())
    currentChartId = null
    updateLibraryCurrentTitle()
    renderLibrary()
  })

  libraryNewFolderBtn.addEventListener('click', async () => {
    const name = window.prompt('Folder name:')
    if (name === null || !name.trim()) return
    await library.createFolder(name.trim())
    await renderLibrary()
  })

  librarySearch.addEventListener('input', () => {
    librarySearchText = librarySearch.value
    renderLibrary()
  })

  // Delegated click handler for all per-chart and per-folder action buttons.
  libraryList.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('[data-lib-action]') as HTMLElement | null
    if (!btn) return
    const action = btn.dataset['libAction'] ?? ''
    const id = btn.dataset['id'] ?? null
    const folder = btn.dataset['folder'] ?? null
    handleLibraryAction(action, id, folder)
  })

  shareLinkBtn.addEventListener('click', () => {
    const { hash, strippedBackground } = encodeToHash(config)
    const url = location.origin + location.pathname + hash
    navigator.clipboard.writeText(url).catch(() => {})
    shareUrlDisplay.textContent = strippedBackground
      ? `${url}\n(Background image was not included — share links can't carry images. Use "Save JSON" to keep it.)`
      : url
    shareUrlDisplay.style.display = 'block'
  })

  applyPresetBtn.addEventListener('click', () => {
    const preset = PRESETS.find(p => p.id === presetSelect.value)
    if (preset) applyPreset(preset)
  })

  // --- Advanced layout modal ---
  // Inputs inside live-update via the existing change listener loop.
  advancedBtn.addEventListener('click', () => { advancedModal.style.display = 'flex' })
  advancedCloseBtn.addEventListener('click', () => { advancedModal.style.display = 'none' })
  advancedModal.addEventListener('click', (e) => {
    if (e.target === advancedModal) advancedModal.style.display = 'none'
  })

  // --- Custom orchestra modal ---
  const openCustomModal = () => {
    customOrchestraTitle.value = ''
    customOrchestraNotation.value = ''
    customOrchestraPreview.textContent = 'Type a notation above to see a preview.'
    customOrchestraPreview.classList.remove('error')
    customOrchestraModal.style.display = 'flex'
    setTimeout(() => customOrchestraNotation.focus(), 0)
  }
  const closeCustomModal = () => { customOrchestraModal.style.display = 'none' }

  const refreshCustomPreview = () => {
    const text = customOrchestraNotation.value.trim()
    if (!text) {
      customOrchestraPreview.textContent = 'Type a notation above to see a preview.'
      customOrchestraPreview.classList.remove('error')
      return
    }
    const comp = parseOrchestraNotation(text)
    if (!comp) {
      customOrchestraPreview.textContent =
        'Could not parse. Expected 3 or 4 dot-separated blocks joined by " - ".\nExample: 2.2.2.2 - 4.2.3.1 - 1.2 - 12.10.8.8.6'
      customOrchestraPreview.classList.add('error')
      return
    }
    customOrchestraPreview.textContent = describeComposition(comp)
    customOrchestraPreview.classList.remove('error')
  }

  customOrchestraBtn.addEventListener('click', openCustomModal)
  customOrchestraCancel.addEventListener('click', closeCustomModal)
  // Click on the backdrop (but not the card) closes
  customOrchestraModal.addEventListener('click', (e) => {
    if (e.target === customOrchestraModal) closeCustomModal()
  })
  customOrchestraNotation.addEventListener('input', refreshCustomPreview)
  customOrchestraApply.addEventListener('click', () => {
    const notation = customOrchestraNotation.value.trim()
    if (!notation) return
    if (!parseOrchestraNotation(notation)) {
      refreshCustomPreview()
      return
    }
    const title = customOrchestraTitle.value.trim() || 'Custom Orchestra'
    applyPreset({
      id: 'custom-orchestra',
      name: title,
      layout: 'semicircle',
      sections: [],
      notation,
    })
    closeCustomModal()
  })

  // Hover cursor reflects what's under the pointer.  Conductor uses 'move'
  // since dragging it now translates the entire chart.
  canvas.addEventListener('mousemove', (e) => {
    const cv = pointerCanvasCoords(e)
    const { x, y } = canvasToChart(cv.x, cv.y)
    if (rotateState || dragState || conductorDragState) {
      canvas.style.cursor = 'grabbing'
      return
    }
    if (renderer.deleteHandleHitTest(x, y)) {
      canvas.style.cursor = 'pointer'
    } else if (renderer.rotateHandleHitTest(x, y)) {
      canvas.style.cursor = 'grab'
    } else if (renderer.instrumentHitTest(x, y)) {
      canvas.style.cursor = 'move'
    } else if (renderer.conductorHitTest(x, y)) {
      canvas.style.cursor = 'move'
    } else {
      canvas.style.cursor = 'default'
    }
  })

  // ResizeObserver fires once the container actually has pixel dimensions
  // (fixes the first-load squish where clientWidth is 0 before CSS layout),
  // and handles subsequent window resizes — replacing the old 'resize' listener.
  new ResizeObserver(() => renderChart()).observe(canvas.parentElement!)
}

init()
