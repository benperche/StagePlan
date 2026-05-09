import './style.css'
import { makeDefaultConfig, makeRow, History } from './state'
import { Renderer } from './renderer'
import { PRESETS, buildRowsFromSections, type PresetSection } from './presets'
import { saveToJson, loadFromJson, encodeToHash, decodeFromHash, exportToPng } from './serializer'
import type { ChartConfig } from './types'

// --- App state ---
let config: ChartConfig = makeDefaultConfig()
const history = new History()
const renderer = new Renderer()

let activeColor = '#a8d8ea'
let activeTool: 'color' | 'toggle' | 'stand' = 'color'

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

// --- Init ---

function init() {
  if (location.hash) {
    const loaded = decodeFromHash(location.hash)
    if (loaded) config = loaded
  }

  populatePresets()
  updateAllInputs()
  renderChart()
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
  rowsContainer.innerHTML = ''
  config.rows.forEach((row, i) => {
    const div = document.createElement('div')
    div.className = 'row-item'
    div.innerHTML = `
      <span class="row-id">Row ${row.label}</span>
      <label>Chairs
        <input type="number" min="1" max="30" value="${row.chairs.length}" data-row="${i}" class="chair-count">
      </label>
      <label>Label
        <input type="text" maxlength="4" value="${row.label}" data-row="${i}" class="row-label-input">
      </label>
      <button data-row="${i}" class="remove-row-btn" ${config.rows.length <= 1 ? 'disabled' : ''}>✕</button>
    `
    rowsContainer.appendChild(div)
  })
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

  const sections: PresetSection[] = preset.sections.map(s => ({ ...s }))
  const rows = buildRowsFromSections(sections)

  config.rows = rows
  config.layout = preset.layout
  config.title = preset.name
  layoutSelect.value = preset.layout
  titleInput.value = preset.name

  updateAllInputs()
  renderChart()
}

// --- Canvas interaction ---

canvas.addEventListener('click', (e) => {
  const rect = canvas.getBoundingClientRect()
  const x = e.clientX - rect.left
  const y = e.clientY - rect.top

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
    chair.hasStand = !chair.hasStand
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

  // Row list: chair count + label changes
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
          current.push({ id: crypto.randomUUID(), enabled: true, color: '#e8e8e8', label: '', hasStand: false })
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

  // Row list: remove row
  rowsContainer.addEventListener('click', (e) => {
    const target = e.target as HTMLButtonElement
    if (!target.classList.contains('remove-row-btn')) return
    const rowIdx = Number(target.dataset['row'])
    if (isNaN(rowIdx) || config.rows.length <= 1) return
    history.push(config)
    config.rows.splice(rowIdx, 1)
    // Clamp straightRows to new row count
    config.straightRows = Math.min(config.straightRows, config.rows.length)
    updateAllInputs()
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
    if (prev) { config = prev; updateAllInputs(); renderChart() }
  })
  redoBtn.addEventListener('click', () => {
    const next = history.redo(config)
    if (next) { config = next; updateAllInputs(); renderChart() }
  })
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
      e.preventDefault()
      const prev = history.undo(config)
      if (prev) { config = prev; updateAllInputs(); renderChart() }
    }
    if ((e.metaKey || e.ctrlKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
      e.preventDefault()
      const next = history.redo(config)
      if (next) { config = next; updateAllInputs(); renderChart() }
    }
  })

  // Save / load
  saveBtn.addEventListener('click', () => saveToJson(config))
  loadInput.addEventListener('change', async () => {
    const file = loadInput.files?.[0]
    if (!file) return
    try {
      config = await loadFromJson(file)
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

  // Pointer cursor when hovering the conductor
  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    canvas.style.cursor = renderer.conductorHitTest(x, y) ? 'pointer' : 'default'
  })

  window.addEventListener('resize', renderChart)
}

init()
