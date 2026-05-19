import './style.css'
import { makeDefaultConfig, makeRow, makeInstrument, History, cloneConfig } from './state'
import { Renderer } from './renderer'
import {
  PRESETS, buildRowsFromSections, parseOrchestraNotation,
  buildOrchestraRows, describeComposition,
  type Preset, type PresetSection,
} from './presets'
import { saveToJson, loadFromJson, encodeToHash, decodeFromHash, exportToPng } from './serializer'
import type { ChartConfig, InstrumentType, FixedInstrument, Row } from './types'

// --- App state ---
let config: ChartConfig = makeDefaultConfig()
const history = new History()
const renderer = new Renderer()

let activeColor = '#a8d8ea'
let activeTool: 'color' | 'toggle' | 'stand' = 'toggle'

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

// --- DOM refs ---
const canvas = document.getElementById('chart-canvas') as HTMLCanvasElement
const titleInput = document.getElementById('title') as HTMLInputElement
const layoutSelect = document.getElementById('layout') as HTMLSelectElement
const notesArea = document.getElementById('notes') as HTMLTextAreaElement
const showNumbersCheck = document.getElementById('show-numbers') as HTMLInputElement
const restartNumbersCheck = document.getElementById('restart-numbers') as HTMLInputElement
const showRowLabelsCheck = document.getElementById('show-row-labels') as HTMLInputElement
const conductorStandCheck = document.getElementById('conductor-stand') as HTMLInputElement
const showArcCheck = document.getElementById('show-arc') as HTMLInputElement
const showStageDirectionsCheck = document.getElementById('show-stage-directions') as HTMLInputElement
const chartScaleInput = document.getElementById('chart-scale') as HTMLInputElement
const bgInput = document.getElementById('bg-input') as HTMLInputElement
const bgClearBtn = document.getElementById('bg-clear-btn') as HTMLButtonElement
const bgStatus = document.getElementById('bg-status') as HTMLElement
const bgFitSelect = document.getElementById('bg-fit') as HTMLSelectElement
const showCreditCheck = document.getElementById('show-credit') as HTMLInputElement
const flipCheck = document.getElementById('flip') as HTMLInputElement
const straightRowsInput = document.getElementById('straight-rows') as HTMLInputElement
const straightRowsLabel = document.getElementById('straight-rows-label') as HTMLElement
const arcRangeInput = document.getElementById('arc-range') as HTMLInputElement
const arcRangeLabel = document.getElementById('arc-range-label') as HTMLElement
const rowSpacingInput = document.getElementById('row-spacing') as HTMLInputElement
const advancedBtn = document.getElementById('advanced-btn') as HTMLButtonElement
const advancedModal = document.getElementById('advanced-modal') as HTMLElement
const advancedCloseBtn = document.getElementById('advanced-close') as HTMLButtonElement
const rowsContainer = document.getElementById('rows-container') as HTMLElement
const colorPicker = document.getElementById('color-picker') as HTMLInputElement
const colorPickerLabel = document.getElementById('color-picker-label') as HTMLElement
const undoBtn = document.getElementById('undo-btn') as HTMLButtonElement
const redoBtn = document.getElementById('redo-btn') as HTMLButtonElement
const resetPositionBtn = document.getElementById('reset-position-btn') as HTMLButtonElement
const addRowBtn = document.getElementById('add-row-btn') as HTMLButtonElement
const saveBtn = document.getElementById('save-btn') as HTMLButtonElement
const loadInput = document.getElementById('load-input') as HTMLInputElement
const exportPngBtn = document.getElementById('export-png-btn') as HTMLButtonElement
const shareLinkBtn = document.getElementById('share-link-btn') as HTMLButtonElement
const shareUrlDisplay = document.getElementById('share-url-display') as HTMLElement
const presetSelect = document.getElementById('preset-select') as HTMLSelectElement
const applyPresetBtn = document.getElementById('apply-preset-btn') as HTMLButtonElement
const customOrchestraBtn = document.getElementById('custom-orchestra-btn') as HTMLButtonElement
const customOrchestraModal = document.getElementById('custom-orchestra-modal') as HTMLElement
const customOrchestraTitle = document.getElementById('custom-orchestra-title') as HTMLInputElement
const customOrchestraNotation = document.getElementById('custom-orchestra-notation') as HTMLInputElement
const customOrchestraPreview = document.getElementById('custom-orchestra-preview') as HTMLElement
const customOrchestraApply = document.getElementById('custom-orchestra-apply') as HTMLButtonElement
const customOrchestraCancel = document.getElementById('custom-orchestra-cancel') as HTMLButtonElement
const toolButtons = document.querySelectorAll<HTMLButtonElement>('[data-tool]')
const addInstrumentButtons = document.querySelectorAll<HTMLButtonElement>('[data-add-instrument]')
const inspector = document.getElementById('instrument-inspector') as HTMLElement
const inspectorType = document.getElementById('inspector-type') as HTMLElement
const inspectorLabel = document.getElementById('inspector-label') as HTMLInputElement
const inspectorCountLabel = document.getElementById('inspector-count-label') as HTMLElement
const inspectorCount = document.getElementById('inspector-count') as HTMLInputElement
const inspectorRotateLeft = document.getElementById('inspector-rotate-left') as HTMLButtonElement
const inspectorRotateRight = document.getElementById('inspector-rotate-right') as HTMLButtonElement
const inspectorDelete = document.getElementById('inspector-delete') as HTMLButtonElement

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

// --- Render ---

function renderChart() {
  resizeCanvas()
  renderer.render(canvas, config)
  undoBtn.disabled = !history.canUndo()
  redoBtn.disabled = !history.canRedo()
}

// Re-render once the background image finishes decoding.
renderer.onBackgroundLoaded = () => renderChart()

function resizeCanvas() {
  const container = canvas.parentElement!
  canvas.width = container.clientWidth
  canvas.height = Math.max(500, container.clientHeight)
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
  v => { config.straightRows = Math.max(0, Math.min(config.rows.length, v || 0)) })
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

  config.rows.forEach((row, i) => {
    const isExpanded = expandedRows.has(i)
    const labelsText = row.chairs.map(c => c.label).join('\n')
    const taRows = Math.min(12, Math.max(3, row.chairs.length))

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
          <input type="text" maxlength="4" value="${row.label}" data-row="${i}" class="row-label-input">
        </label>
        <button data-row="${i}" class="remove-row-btn" ${config.rows.length <= 1 ? 'disabled' : ''}>✕</button>
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
  history.push(config)

  // Row source priority: notation > customRows > sections.
  let rows: Row[]
  // For orchestra notation, the row builder also tells us how many of the
  // back rows should render straight (winds/brass/perc) so a small section
  // doesn't get stretched across the full back arc.
  let straightRowsOverride: number | null = null
  if (preset.notation) {
    const comp = parseOrchestraNotation(preset.notation)
    if (!comp) {
      alert(`Invalid orchestra notation: "${preset.notation}"`)
      return
    }
    const built = buildOrchestraRows(comp)
    rows = built.rows
    straightRowsOverride = built.straightRows
  } else if (preset.customRows && preset.customRows.length > 0) {
    const rowLetters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    rows = preset.customRows.map((row, i) => ({
      id: crypto.randomUUID(),
      chairs: row.chairs.map(c => ({
        id: crypto.randomUUID(),
        enabled: c.enabled ?? true,
        color: c.color,
        label: c.label,
        hasStand: c.hasStand ?? false,
        standAfter: c.standAfter ?? false,
      })),
      label: row.label || rowLetters[i] || String(i + 1),
      fontSize: 11,
    }))
  } else {
    const sections: PresetSection[] = preset.sections.map(s => ({ ...s }))
    rows = buildRowsFromSections(sections)
  }

  // Always clear existing fixed instruments on preset apply, then add any
  // the preset wants pre-placed.
  const instruments: FixedInstrument[] = (preset.instruments ?? []).map(i => ({
    id: crypto.randomUUID(),
    type: i.type,
    angle: i.angle,
    distance: i.distance,
    rotation: i.rotation ?? 0,
    ...(i.count !== undefined ? { count: i.count } : {}),
    ...(i.label !== undefined ? { label: i.label } : {}),
  }))

  config.rows = rows
  config.layout = preset.layout
  config.title = preset.name
  config.straightRows = straightRowsOverride ?? preset.straightRows ?? 0
  config.instruments = instruments

  layoutSelect.value = preset.layout
  titleInput.value = preset.name

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

  // Rotate handle (only present for the selected instrument) takes priority
  if (renderer.rotateHandleHitTest(x, y)) {
    const inst = config.instruments.find(i => i.id === selectedInstrumentId)
    if (inst) {
      const { ox, oy } = renderer.conductorOrigin
      const cx = ox + inst.distance * Math.cos(inst.angle)
      const cy = oy + inst.distance * Math.sin(inst.angle)
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
  const { ox, oy } = renderer.conductorOrigin

  // Threshold check: only treat as drag (and push history) once we've
  // moved meaningfully from the original instrument centre.
  if (!drag.moved) {
    const oldCx = ox + inst.distance * Math.cos(inst.angle)
    const oldCy = oy + inst.distance * Math.sin(inst.angle)
    if (Math.hypot(newCx - oldCx, newCy - oldCy) < DRAG_THRESHOLD) return
    history.push(drag.preDragConfig)
    drag.moved = true
  }

  const dx = newCx - ox
  const dy = newCy - oy
  inst.angle = Math.atan2(dy, dx)
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

  history.push(config)
  const chair = config.rows[hit.rowIndex].chairs[hit.chairIndex]

  if (activeTool === 'color') {
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
    straightRowsInput, showArcCheck, arcRangeInput, rowSpacingInput, showStageDirectionsCheck,
    chartScaleInput, bgFitSelect, showCreditCheck]) {
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
    const labels = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    const label = labels[config.rows.length] ?? String(config.rows.length + 1)
    config.rows.push(makeRow(8, label))
    updateAllInputs()
    renderChart()
  })

  // Tool selection
  toolButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      activeTool = btn.dataset['tool'] as typeof activeTool
      toolButtons.forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      colorPickerLabel.style.display = activeTool === 'color' ? '' : 'none'
      if (activeTool === 'color') colorPicker.click()
    })
  })

  colorPicker.addEventListener('input', () => {
    activeColor = colorPicker.value
  })

  // Undo / redo
  undoBtn.addEventListener('click', () => {
    const prev = history.undo(config)
    if (prev) {
      config = prev
      migrateConfig(config)
      setSelectedInstrument(null)
      updateAllInputs(); renderChart()
    }
  })
  redoBtn.addEventListener('click', () => {
    const next = history.redo(config)
    if (next) {
      config = next
      migrateConfig(config)
      setSelectedInstrument(null)
      updateAllInputs(); renderChart()
    }
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
      if (prev) { config = prev; migrateConfig(config); setSelectedInstrument(null); updateAllInputs(); renderChart() }
    }
    if ((e.metaKey || e.ctrlKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
      e.preventDefault()
      const next = history.redo(config)
      if (next) { config = next; migrateConfig(config); setSelectedInstrument(null); updateAllInputs(); renderChart() }
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
      config = await loadFromJson(file)
      migrateConfig(config)
      expandedRows.clear()
      setSelectedInstrument(null)
      updateAllInputs()
      renderChart()
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
    if (renderer.rotateHandleHitTest(x, y)) {
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
