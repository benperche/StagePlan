import './style.css'
import { makeDefaultConfig, makeRow, makeInstrument, History } from './state'
import { Renderer } from './renderer'
import { PRESETS, buildRowsFromSections, type PresetSection } from './presets'
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

// Drag state for instruments. Created on mousedown over an instrument and
// torn down on mouseup. The pre-drag config snapshot is pushed to history
// only if the pointer actually moves, so a pure click-to-select doesn't
// pollute the undo stack.
interface DragState {
  instrumentId: string
  offsetX: number      // pointer x minus instrument centre x at drag start
  offsetY: number
  preDragConfig: ChartConfig
  moved: boolean
}
let dragState: DragState | null = null

// Rotation drag (when user grabs the green rotate handle).  Records the
// instrument centre and the offset between the initial pointer angle and
// the instrument's rotation, so the handle stays under the cursor as you drag.
interface RotateState {
  instrumentId: string
  centerX: number
  centerY: number
  initialPointerAngle: number   // atan2 from centre to pointer at mousedown
  initialRotation: number       // instrument.rotation at mousedown
  preDragConfig: ChartConfig
  moved: boolean
}
let rotateState: RotateState | null = null

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
const flipCheck = document.getElementById('flip') as HTMLInputElement
const straightRowsInput = document.getElementById('straight-rows') as HTMLInputElement
const straightRowsLabel = document.getElementById('straight-rows-label') as HTMLElement
const rowsContainer = document.getElementById('rows-container') as HTMLElement
const colorPicker = document.getElementById('color-picker') as HTMLInputElement
const undoBtn = document.getElementById('undo-btn') as HTMLButtonElement
const redoBtn = document.getElementById('redo-btn') as HTMLButtonElement
const addRowBtn = document.getElementById('add-row-btn') as HTMLButtonElement
const saveBtn = document.getElementById('save-btn') as HTMLButtonElement
const loadInput = document.getElementById('load-input') as HTMLInputElement
const exportPngBtn = document.getElementById('export-png-btn') as HTMLButtonElement
const shareLinkBtn = document.getElementById('share-link-btn') as HTMLButtonElement
const shareUrlDisplay = document.getElementById('share-url-display') as HTMLElement
const presetSelect = document.getElementById('preset-select') as HTMLSelectElement
const applyPresetBtn = document.getElementById('apply-preset-btn') as HTMLButtonElement
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
  // Migration: older saved configs may not have `instruments`.
  if (!Array.isArray(config.instruments)) config.instruments = []

  populatePresets()
  updateAllInputs()
  renderInspector()
  bindEvents()
}

// --- Render ---

function renderChart() {
  resizeCanvas()
  renderer.render(canvas, config)
  undoBtn.disabled = !history.canUndo()
  redoBtn.disabled = !history.canRedo()
}

function resizeCanvas() {
  const container = canvas.parentElement!
  canvas.width = container.clientWidth
  canvas.height = Math.max(500, container.clientHeight)
}

// --- Sync inputs → config ---

function readInputs() {
  history.push(config)
  config.title = titleInput.value
  config.layout = layoutSelect.value as ChartConfig['layout']
  config.notes = notesArea.value
  config.showNumbers = showNumbersCheck.checked
  config.numberRestartPerRow = restartNumbersCheck.checked
  config.showRowLabels = showRowLabelsCheck.checked
  config.conductor.hasStand = conductorStandCheck.checked
  config.flipped = flipCheck.checked
  config.showArc = showArcCheck.checked
  config.straightRows = Math.max(0, Math.min(config.rows.length, Number(straightRowsInput.value) || 0))
}

// --- Sync config → inputs ---

function updateAllInputs() {
  titleInput.value = config.title
  layoutSelect.value = config.layout
  notesArea.value = config.notes
  showNumbersCheck.checked = config.showNumbers
  restartNumbersCheck.checked = config.numberRestartPerRow
  showRowLabelsCheck.checked = config.showRowLabels
  conductorStandCheck.checked = config.conductor.hasStand
  flipCheck.checked = config.flipped
  showArcCheck.checked = config.showArc
  straightRowsInput.value = String(config.straightRows)
  straightRowsInput.max = String(config.rows.length)
  // Only show straight-rows control in semicircle mode
  straightRowsLabel.style.display = config.layout === 'semicircle' ? '' : 'none'
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

// --- Presets ---

function populatePresets() {
  PRESETS.forEach(preset => {
    const opt = document.createElement('option')
    opt.value = preset.id
    opt.textContent = preset.name
    presetSelect.appendChild(opt)
  })
}

function applyPreset(presetId: string) {
  const preset = PRESETS.find(p => p.id === presetId)
  if (!preset) return
  history.push(config)

  // Rows: customRows (explicit per-chair labels) take precedence over the
  // generic auto-packing of `sections`.
  let rows: Row[]
  if (preset.customRows && preset.customRows.length > 0) {
    const rowLetters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    rows = preset.customRows.map((row, i) => ({
      id: crypto.randomUUID(),
      chairs: row.chairs.map(c => ({
        id: crypto.randomUUID(),
        enabled: true,
        color: c.color,
        label: c.label,
        hasStand: false,
        standAfter: false,
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
  config.straightRows = preset.straightRows ?? 0
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
  const { x, y } = pointerCanvasCoords(e)

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
        preDragConfig: JSON.parse(JSON.stringify(config)),
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
      preDragConfig: JSON.parse(JSON.stringify(config)),
      moved: false,
    }
    renderChart()
    return
  }

  // Click on empty canvas / chair / conductor deselects any instrument.
  if (selectedInstrumentId) {
    setSelectedInstrument(null)
    renderChart()
  }
})

window.addEventListener('mousemove', (e) => {
  const { x, y } = pointerCanvasCoords(e)

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
  dragState = null
  rotateState = null
})

// Click handler runs after mouseup. Skip if the click landed on an instrument
// or its rotate handle (already handled in mousedown) so chair/conductor logic
// doesn't fire on top.
canvas.addEventListener('click', (e) => {
  const { x, y } = pointerCanvasCoords(e)
  if (renderer.rotateHandleHitTest(x, y)) return
  if (renderer.instrumentHitTest(x, y)) return

  // Conductor toggle takes priority
  if (renderer.conductorHitTest(x, y)) {
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
    const isLast = hit.chairIndex === config.rows[hit.rowIndex].chairs.length - 1
    if (!chair.hasStand && !chair.standAfter) {
      chair.hasStand = true
    } else if (chair.hasStand) {
      chair.hasStand = false
      if (!isLast) chair.standAfter = true
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
    straightRowsInput, showArcCheck]) {
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
      if (!Array.isArray(config.instruments)) config.instruments = []
      setSelectedInstrument(null)
      updateAllInputs(); renderChart()
    }
  })
  redoBtn.addEventListener('click', () => {
    const next = history.redo(config)
    if (next) {
      config = next
      if (!Array.isArray(config.instruments)) config.instruments = []
      setSelectedInstrument(null)
      updateAllInputs(); renderChart()
    }
  })
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
      e.preventDefault()
      const prev = history.undo(config)
      if (prev) { config = prev; if (!Array.isArray(config.instruments)) config.instruments = []; setSelectedInstrument(null); updateAllInputs(); renderChart() }
    }
    if ((e.metaKey || e.ctrlKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
      e.preventDefault()
      const next = history.redo(config)
      if (next) { config = next; if (!Array.isArray(config.instruments)) config.instruments = []; setSelectedInstrument(null); updateAllInputs(); renderChart() }
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
      if (!Array.isArray(config.instruments)) config.instruments = []
      expandedRows.clear()
      setSelectedInstrument(null)
      updateAllInputs()
      renderChart()
    } catch {
      alert('Could not load chart file.')
    }
    loadInput.value = ''
  })

  exportPngBtn.addEventListener('click', () => exportToPng(canvas, config.title))

  shareLinkBtn.addEventListener('click', () => {
    const hash = encodeToHash(config)
    const url = location.origin + location.pathname + hash
    navigator.clipboard.writeText(url).catch(() => {})
    shareUrlDisplay.textContent = url
    shareUrlDisplay.style.display = 'block'
  })

  applyPresetBtn.addEventListener('click', () => {
    applyPreset(presetSelect.value)
  })

  // Hover cursor: grab over rotate handle / instrument body, pointer over conductor
  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    if (rotateState || dragState) {
      canvas.style.cursor = 'grabbing'
      return
    }
    if (renderer.rotateHandleHitTest(x, y)) {
      canvas.style.cursor = 'grab'
    } else if (renderer.instrumentHitTest(x, y)) {
      canvas.style.cursor = 'move'
    } else if (renderer.conductorHitTest(x, y)) {
      canvas.style.cursor = 'pointer'
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
