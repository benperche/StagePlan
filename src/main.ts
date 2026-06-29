import './style.css'
import { makeDefaultConfig, makeRow, makeInstrument, History, cloneConfig, DEFAULT_CHAIR_COLOR } from './state'
import { Renderer } from './renderer'
import {
  PRESETS, buildPreset, parseOrchestraNotation, describeComposition,
  type Preset,
} from './presets'
import { saveToJson, loadFromJson, encodeToHash, decodeFromHash, exportToPng } from './serializer'
import * as library from './library'
import type { ChartConfig, InstrumentType, Chair } from './types'

// --- App state ---
let config: ChartConfig = makeDefaultConfig()
const history = new History()
const renderer = new Renderer()

// Off-screen render size for PNG export / print — A4 landscape proportions
// (297×210 ≈ 1.414:1) at a print-friendly resolution, so exports fill the page.
const EXPORT_W = 2100
const EXPORT_H = Math.round(EXPORT_W / Math.SQRT2)   // 1485 — A4's √2 aspect ratio

let activeColor = '#a8d8ea'
type ChairTool = 'color' | 'toggle' | 'stand' | 'stool' | 'label' | 'instrument'
let activeTool: ChairTool = 'toggle'

// One-line explanation per chair tool, shown under the Edit Chairs buttons for
// whichever tool is active (set in setChairTool).
const TOOL_HINTS: Record<ChairTool, string> = {
  toggle: "Click a chair to hide it — its place is kept so the row doesn't shift. Click again to bring it back.",
  stand: 'Pick a stand type below, then click a chair (or drag a box over several) to apply it.',
  stool: 'Pick a seat type below, then click a chair (or drag a box over several) to apply it.',
  color: 'Click a chair to paint it the swatch colour. Click the swatch to change the colour.',
  label: 'Click a chair to type a name on it (Enter jumps to the next chair), or paste a list below.',
  instrument: 'Pick an instrument below, then click chairs to stamp it on them.',
}

// True while the Layout tab is active: the canvas shows geometry handles +
// arc guides and the chair-editing tools / instrument drags are suspended.
let layoutMode = false

// Which sidebar tab is showing. The conductor is draggable (move whole chart)
// in the positioning tabs — Setup (place against a background) and Layout —
// but not in Edit, where clicking it renames it instead.
let activeTab = 'setup'
const conductorMovable = () => activeTab === 'setup' || activeTab === 'layout'

// When activeTool === 'label', clicking a chair sets its label to this string.
// Picked from the Allocate Instruments panel; null = nothing selected yet.
let selectedLabel: string | null = null

// --- View zoom/pan (screen-only) ---
// A CSS transform on the canvas, purely for inspecting the chart on screen.
// It never touches `config`, undo history, PNG export or print — those always
// render the full chart at full resolution. transform-origin is the canvas's
// top-left (0,0); a backing pixel (bx,by) shows at (panX + bx*zoom, ...).
let viewZoom = 1
let viewPanX = 0
let viewPanY = 0
const VIEW_ZOOM_MIN = 1      // 1 = fit (the canvas already fills the area)
const VIEW_ZOOM_MAX = 6
let panState: { startX: number; startY: number; panX0: number; panY0: number; moved: boolean } | null = null
let suppressClickAfterPan = false

// Edit-tab marquee bulk-select. Active while dragging a box over chairs at 100%
// view-zoom; on release the active tool is applied to every chair inside it.
type StandMode = 'solo' | 'desk' | 'remove'
type StoolMode = 'chair' | 'stool' | 'standing'
let standMode: StandMode = 'solo'
let stoolMode: StoolMode = 'stool'

// Repeated clicks on the SAME chair with the stand/stool tool cycle through
// the options: the first click on a chair applies the armed sidebar mode,
// and each further click on that same chair steps to the next option. We
// track the last chair a cycling tool acted on; it's cleared whenever the
// tool, config or a marquee changes things, so a fresh chair always starts
// from the armed mode again.
let lastCycledChair: { rowIndex: number; chairIndex: number; tool: ChairTool } | null = null
const STAND_CYCLE: StandMode[] = ['solo', 'remove', 'desk']
const STOOL_CYCLE: StoolMode[] = ['chair', 'stool', 'standing']
let marqueeState: {
  startClientX: number; startClientY: number
  startChart: { x: number; y: number }
  moved: boolean
} | null = null
// Set when a marquee with the free-type Label tool opens the floating input in
// bulk mode: committing writes the value to every listed chair at once.
let bulkLabelTargets: { rowIndex: number; chairIndex: number }[] | null = null
// When labelling via a marquee, replace existing labels (true) or fill only
// blanks (false). Toggled by the floating #drag-overwrite button.
let overwriteLabels = false
// A marquee needs a precise pointer, so the gesture is only started for
// mouse/pen (per-event), and its UI is shown only when the device has any fine
// pointer (desktop, or a tablet with a mouse/trackpad attached).
const hasFinePointer = window.matchMedia?.('(any-pointer: fine)')?.matches ?? true
document.body.classList.toggle('marquee-capable', hasFinePointer)

// Active Layout-tab handle drag. geom0 is the row's geometry snapshot captured
// at grab time; start is the chart-space pointer at grab time.
let layoutDrag: {
  rowIndex: number
  kind: 'distance' | 'span-start' | 'span-end'
  geom0: import('./types').RowGeometry
  start: { x: number; y: number }
  preDragConfig: ChartConfig
  moved: boolean
} | null = null

// Active Layout-tab title drag. The title is drawn in raw canvas px (not the
// chartScale frame), so this works in screen px and stores config.titleOffset.
let titleDrag: {
  startX: number; startY: number; x0: number; y0: number
  preDragConfig: ChartConfig; moved: boolean
} | null = null

// Active drag of a chart-wide default arc-range handle (sets config.arcRange).
let arcRangeDrag: { startX: number; startY: number; preDragConfig: ChartConfig; moved: boolean } | null = null

// Active Layout-tab per-chair nudge. naturalAngle (arc) / base (straight) are
// the chair's position with its current offset backed out, so the new offset
// is just (natural − target).
let chairDrag: {
  rowIndex: number
  chairIndex: number
  isStraight: boolean
  r: number
  naturalAngle: number
  base: number
  start: { x: number; y: number }
  preDragConfig: ChartConfig
  moved: boolean
} | null = null

// Active Layout-tab desk-group drag: slides a two-chair desk (and its shared
// stand) along the row as a unit. Tracks both chairs' starting offsets plus the
// frozen start centres of the pair and its outer neighbours (for overlap
// clamping), since the pair moves while the neighbours stay put.
let deskDrag: {
  rowIndex: number
  i: number              // first chair of the pair
  isStraight: boolean
  r: number
  off0: [number, number]
  centers: {
    i: { x: number; y: number }
    i1: { x: number; y: number }
    left: { x: number; y: number } | null
    right: { x: number; y: number } | null
  }
  start: { x: number; y: number }
  preDragConfig: ChartConfig
  moved: boolean
} | null = null

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

// Short labels the Instruments picker stamps into the (small) chair boxes, so
// they read like the preset charts ("Fl 1" rather than "Flute 1"). Where a
// built-in preset (presets.ts / orchestra notation) uses a short form, the
// value here matches it verbatim; the rest use standard score abbreviations.
// Names short enough to fit a chair box already (Tuba, Bass, Solo…) are
// simply absent and pass through unchanged.
const INSTRUMENT_ABBREV: Record<string, string> = {
  // Woodwinds
  Piccolo: 'Picc', Flute: 'Fl', Oboe: 'Ob', 'Cor Anglais': 'CA',
  'Eb Clarinet': 'Eb Cl', Clarinet: 'Cl', 'Alto Clarinet': 'A Cl',
  'Bass Clarinet': 'B Cl', 'Contrabass Clarinet': 'CB Cl',
  Bassoon: 'Bsn', Contrabassoon: 'Cbsn',
  // Saxophones
  'Soprano Sax': 'SS', 'Alto Sax': 'AS', 'Tenor Sax': 'TS', 'Bari Sax': 'BS',
  'Bass Sax': 'B Sax',
  // Brass
  Horn: 'Hn', Trumpet: 'Tpt', Cornet: 'Cnt', Flugelhorn: 'Flug',
  Trombone: 'Tbn', 'Bass Trombone': 'B Tbn', Baritone: 'Bar', Euphonium: 'Euph',
  // Strings
  Violin: 'Vn', Viola: 'Va', Cello: 'Vc', 'Double Bass': 'Cb',
  // Rhythm and keyboards
  Piano: 'Pno', Keyboard: 'Kbd', Organ: 'Org', Harp: 'Hp', Celeste: 'Cel',
  Guitar: 'Gtr', 'Electric Guitar': 'E Gtr', 'Electric Bass': 'E Bass',
  // Percussion
  Timpani: 'Timp', 'Snare Drum': 'SD', 'Bass Drum': 'BD', Cymbals: 'Cym',
  Tambourine: 'Tamb', Glockenspiel: 'Glock', Xylophone: 'Xylo',
  Vibraphone: 'Vibes', Marimba: 'Mba', Mallets: 'Mlts',
  Percussion: 'Perc', Auxiliary: 'Aux',
  // Voices
  Voice: 'Vox', Soprano: 'Sop', Tenor: 'Ten',
}

const abbrevInstrument = (name: string): string => INSTRUMENT_ABBREV[name] ?? name

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
  // When the Stand tool is active, a press that never crosses the drag
  // threshold toggles the instrument's music stand on pointerup; an actual
  // drag still just moves it. Lets you reposition instruments in stand mode.
  toggleStandOnClick?: boolean
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

// All DOM refs live in dom.ts; pull them in by name.
import {
  canvas, canvasArea, tabButtons, tabContents, tabNavButtons,
  titleInput, titleGapInput, layoutSelect, notesArea, showNumbersCheck, restartNumbersCheck,
  showRowLabelsCheck, conductorStandCheck, showConductorCheck, showArcCheck, showStageDirectionsCheck,
  chartScaleInput, bgInput, bgClearBtn, bgStatus, bgFitSelect, showCreditCheck,
  flipCheck, straightRowsInput, straightRowsLabel, arcRangeInput, arcRangeLabel,
  rowSpacingInput, rowCountInput, aboutBtn, aboutModal, aboutCloseBtn,
  rowsContainer,
  colorPicker, colorPickerLabel, colorBulkPanel, resetColorsBtn,
  undoBtn, redoBtn, zoomInBtn, zoomOutBtn, zoomResetBtn,
  resetPositionBtn, resetLayoutBtn, layoutRowList, addRowBtn, saveBtn,
  loadInput, exportPngBtn, printBtn, shareLinkBtn, shareUrlDisplay, presetSelect, applyPresetBtn, clearPresetBtn,
  libraryDrawer, libraryBackdrop, libraryOpenBtn, libraryCloseBtn,
  libraryCurrentTitle, librarySaveBtn, libraryNewChartBtn, libraryNewFolderBtn,
  librarySearch, libraryList,
  customOrchestraBtn, customOrchestraModal, customOrchestraTitle, customOrchestraNotation,
  customOrchestraPreview, customOrchestraApply, customOrchestraCancel,
  toolButtons, chairLabelInput, editChairsHint, labelPanel, clearLabelsBtn, instrumentPanel,
  marqueeBox, dragOverwriteBtn,
  standBulkPanel, stoolBulkPanel, standBulkButtons, stoolBulkButtons,
  instrumentPickerList, labelList, instrumentPickerStatus,
  showTallyBtn, tallyOverlay, tallyBody, tallyTotal, tallyMinimizeBtn, tallyCloseBtn,
  addInstrumentButtons, inspector, inspectorType, inspectorLabel,
  inspectorCountLabel, inspectorCount, inspectorRotateLeft, inspectorRotateRight,
  inspectorDelete, inspectorMicOptions, inspectorMicStand, inspectorMicWireless,
  inspectorTimpaniOptions, inspectorTimpaniStool,
} from './dom'

// --- Init ---

function init() {
  if (location.hash) {
    // An explicit shared-chart link wins over anything else.
    const loaded = decodeFromHash(location.hash)
    if (loaded) config = loaded
  } else {
    // Otherwise pick up where the last session left off (autosave safety net).
    const restored = restoreWorkingChart()
    if (restored) {
      config = restored.config
      currentChartId = restored.currentChartId
    }
  }
  migrateConfig(config)

  populatePresets()
  updateAllInputs()
  renderInspector()
  bindEvents()
  markSaved()        // baseline for the unsaved-changes guard
  maybeShowIntro()
  // setConfig isn't usable here yet (bindEvents hasn't wired things up
  // until after this returns). The default/hash-loaded path is the one
  // case where we mutate config in place and then sync everything below.
}

// Pop the About / how-it-works modal automatically the very first time someone
// opens the app on this device (a localStorage flag, so it's once-only — after
// that it's reachable only via the ⓘ button). Wrapped in try/catch because
// localStorage throws in private-mode / cookie-blocked browsers; failing to
// remember just means a returning visitor sees the intro again, which is
// harmless. Don't barge in over a shared chart (a hash link) — that visitor
// asked for a specific chart, not a tour.
const INTRO_SEEN_KEY = 'stageplan_intro_seen'
function maybeShowIntro() {
  if (location.hash) return
  try {
    if (localStorage.getItem(INTRO_SEEN_KEY)) return
    localStorage.setItem(INTRO_SEEN_KEY, '1')
  } catch { /* storage unavailable — show it this once anyway */ }
  aboutModal.style.display = 'flex'
}

// --- Working-chart autosave (crash / refresh safety) ---
//
// The charts a user explicitly keeps live in the IndexedDB library; this is a
// separate safety net for the chart currently on screen. We mirror it to
// localStorage on a short debounce after every render, and restore it on the
// next launch, so a refresh / closed tab / slept laptop never silently loses
// unsaved work. The library id rides along so a restored chart still Saves in
// place. Best-effort throughout — storage can be full or blocked.
const WORKING_KEY = 'stageplan_working_chart'
let autosaveTimer: number | undefined
function scheduleAutosave() {
  clearTimeout(autosaveTimer)
  autosaveTimer = window.setTimeout(persistWorkingChart, 500)
}
function persistWorkingChart() {
  try {
    localStorage.setItem(WORKING_KEY, JSON.stringify({ config, currentChartId }))
  } catch {
    // Usually the quota, blown by a large background image. Retry without it so
    // at least the layout survives — better than losing everything.
    try {
      const { backgroundImage: _omit, ...rest } = config
      localStorage.setItem(WORKING_KEY, JSON.stringify({ config: rest, currentChartId }))
    } catch { /* storage unavailable — nothing more we can do */ }
  }
}
function restoreWorkingChart(): { config: ChartConfig; currentChartId: string | null } | null {
  try {
    const raw = localStorage.getItem(WORKING_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { config?: unknown; currentChartId?: unknown }
    // Same shape guard as the file/hash loaders — ignore anything corrupt.
    if (!parsed.config || typeof parsed.config !== 'object' ||
        !Array.isArray((parsed.config as { rows?: unknown }).rows)) return null
    return {
      config: parsed.config as ChartConfig,
      currentChartId: typeof parsed.currentChartId === 'string' ? parsed.currentChartId : null,
    }
  } catch { return null }
}

// --- Unsaved-changes guard ---
//
// Baseline JSON of the chart as it last stood at an explicit Save / Load / New
// (NOT undo/redo, which are edits). beforeunload warns only when the live chart
// differs from it, so leaving with genuinely unsaved edits prompts, but a clean
// reload doesn't nag. Autosave above is the real safety net; this is the belt
// to its braces.
let savedSnapshot = ''
function markSaved() { savedSnapshot = JSON.stringify(config) }

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
 * and run the bookkeeping every replacement needs: schema migration, clear
 * the instrument selection that no longer refers to anything valid, push the
 * new state to the sidebar, and re-render the canvas. Use this any time the
 * whole config is replaced wholesale; for in-place mutations just call
 * renderChart() directly.
 */
function setConfig(newConfig: ChartConfig) {
  config = newConfig
  migrateConfig(config)
  lastCycledChair = null   // chair indices may no longer refer to the same seat
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
const LIBRARY_ERROR = "Couldn't reach the chart library — your browser may be blocking local storage. Use Save JSON in the Export tab to keep this chart."

function updateLibraryCurrentTitle() {
  libraryCurrentTitle.textContent = currentChartId
    ? `My Charts — Editing "${config.title}"`
    : 'My Charts'
}

// --- Library drawer open/close ---

function openLibrary() {
  libraryDrawer.classList.add('open')
  libraryDrawer.setAttribute('aria-hidden', 'false')
  libraryBackdrop.hidden = false
  renderLibrary()
}

function closeLibrary() {
  libraryDrawer.classList.remove('open')
  libraryDrawer.setAttribute('aria-hidden', 'true')
  libraryBackdrop.hidden = true
}

function isLibraryOpen() {
  return libraryDrawer.classList.contains('open')
}

// --- Render ---

function renderChart() {
  resizeCanvas()
  // Hidden seats show their ghost outline while editing, but not in the Export
  // tab preview — that mirrors the PNG/print output, which omits them entirely.
  renderer.render(canvas, config, { layoutMode, dpr: renderDpr, showGhosts: activeTab !== 'export' })
  undoBtn.disabled = !history.canUndo()
  redoBtn.disabled = !history.canRedo()
  renderTally()
  scheduleAutosave()   // debounced mirror to localStorage; cheap to call often
  // Keep the Layout tab's per-row boxes in sync with the geometry the render
  // just produced (renderer.layoutRows). A row-handle / default-arc drag is the
  // only kind that changes those numbers, so it gets a lightweight in-place
  // value sync; other drags leave the boxes untouched; everything else rebuilds.
  if (layoutMode) {
    if (layoutDrag?.moved || arcRangeDrag?.moved) syncLayoutRowValues()
    else if (!quietDragMoved()) updateLayoutRowList()
  }
}

// True while a canvas drag is in progress that doesn't affect the Layout
// row boxes (instrument move/rotate, conductor move, per-chair nudge, title),
// so we can skip rebuilding them mid-drag.
function quietDragMoved(): boolean {
  return !!(chairDrag?.moved || deskDrag?.moved || conductorDragState?.moved || dragState?.moved
    || rotateState?.moved || titleDrag?.moved)
}

function rowHasLayoutTweak(r: typeof config.rows[number]): boolean {
  return r.gapBefore !== undefined || r.arcStart !== undefined || r.arcEnd !== undefined ||
    r.straightSpacing !== undefined || r.straightOffset !== undefined ||
    r.chairs.some(c => c.offset !== undefined)
}

// The per-row spread value as shown in its box (arc degrees / straight spacing).
function rowSpreadValue(g: import('./types').RowGeometry): number {
  return g.isStraight ? Math.round(g.spacing) : Math.round((g.arcStart - g.arcEnd) * 180 / Math.PI)
}

// Builds the Layout tab's per-row editor: one box per row showing its distance
// from the conductor and its spread (arc range for curved rows, chair spacing
// for straight), each editable, with a per-row reset. Reads the geometry the
// renderer computed this frame (renderer.layoutRows).
function updateLayoutRowList() {
  const geoms = renderer.layoutRows
  if (geoms.length !== config.rows.length) { layoutRowList.innerHTML = ''; return }

  layoutRowList.innerHTML = config.rows.map((row, i) => {
    const g = geoms[i]
    const label = config.showRowLabels ? `Row ${row.label}` : `Row ${i + 1}`
    const spread = g.isStraight
      ? `<label>Spacing<input type="number" class="lay-spread" data-row="${i}" min="20" max="200" step="1" value="${rowSpreadValue(g)}"></label>`
      : `<label>Arc°<input type="number" class="lay-spread" data-row="${i}" min="10" max="350" step="1" value="${rowSpreadValue(g)}"></label>`
    return `<div class="layout-row-item" data-row-index="${i}">
      <span class="layout-row-name">${label}</span>
      <label>Dist<input type="number" class="lay-dist" data-row="${i}" min="40" max="2000" step="1" value="${Math.round(g.r)}"></label>
      ${spread}
      <button class="lay-reset" data-row="${i}" title="Reset this row"${rowHasLayoutTweak(row) ? '' : ' disabled'}>↺</button>
    </div>`
  }).join('')
}

// Lightweight in-place refresh of the existing boxes' numbers + reset states,
// used during a drag so we don't rebuild the DOM every frame. Skips whichever
// input is focused so it never fights the user's typing. Falls back to a full
// rebuild if the structure no longer matches.
function syncLayoutRowValues() {
  const geoms = renderer.layoutRows
  const items = layoutRowList.querySelectorAll<HTMLElement>('.layout-row-item')
  if (items.length !== config.rows.length || geoms.length !== config.rows.length) {
    updateLayoutRowList()
    return
  }
  config.rows.forEach((row, i) => {
    const g = geoms[i]
    const item = items[i]
    const distInput = item.querySelector<HTMLInputElement>('.lay-dist')!
    const spreadInput = item.querySelector<HTMLInputElement>('.lay-spread')!
    const resetBtn = item.querySelector<HTMLButtonElement>('.lay-reset')!
    if (document.activeElement !== distInput) distInput.value = String(Math.round(g.r))
    if (document.activeElement !== spreadInput) spreadInput.value = String(rowSpreadValue(g))
    resetBtn.disabled = !rowHasLayoutTweak(row)
  })
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
  INSTRUMENT_GROUPS.forEach(g => g.items.forEach((item, idx) => {
    matchers.push({ name: item, section: g.name, orderInSection: idx })
    // Also classify the abbreviated form (what the picker stamps and what the
    // presets use), so e.g. "Fl 1" lands in Woodwinds, not "Other".
    const ab = INSTRUMENT_ABBREV[item]
    if (ab && ab !== item) matchers.push({ name: ab, section: g.name, orderInSection: idx })
  }))
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

// Device-pixel-ratio used for the current backing store. Capped so a 3× phone
// doesn't allocate an enormous canvas. pointerCanvasCoords needs the same value
// the last render used, so it's a module global set here.
let renderDpr = 1

function resizeCanvas() {
  // Measure the canvas's own rendered box (not the parent's) so any padding on
  // #canvas-area — e.g. the top strip on mobile that clears the overlay
  // buttons — is respected and the backing never mismatches the display size.
  // The backing matches that box's aspect 1:1 (no squish) and is dpr-bigger so
  // the chart stays crisp on retina / phone screens.
  renderDpr = Math.min(window.devicePixelRatio || 1, 3)
  canvas.width = Math.max(1, Math.round(canvas.clientWidth * renderDpr))
  canvas.height = Math.max(1, Math.round(canvas.clientHeight * renderDpr))
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
  let charts, folders
  try {
    [charts, folders] = await Promise.all([library.listCharts(), library.listFolders()])
  } catch {
    // IndexedDB can be unavailable (private browsing, locked-down browser).
    libraryList.innerHTML = '<p class="lib-empty">⚠ Your browser blocked local storage, so the chart library isn\'t available here. You can still use <strong>Save JSON</strong> / <strong>Load JSON</strong> in the Export tab.</p>'
    return
  }
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
        <button class="lib-chart-action" data-lib-action="rename" data-id="${c.id}" title="Rename">✏️</button>
        <button class="lib-chart-action" data-lib-action="duplicate" data-id="${c.id}" title="Duplicate">📋</button>
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
    markSaved()        // freshly loaded from the library = clean
    updateLibraryCurrentTitle()
    closeLibrary()
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
bindNumber(titleGapInput,
  () => config.titleGap ?? 0,
  v => { config.titleGap = Math.max(0, Math.min(200, v || 0)) })
bindText(layoutSelect, () => config.layout, v => { config.layout = v as ChartConfig['layout'] })
bindText(notesArea, () => config.notes, v => { config.notes = v })
bindBool(showNumbersCheck, () => config.showNumbers, v => { config.showNumbers = v })
bindBool(restartNumbersCheck, () => config.numberRestartPerRow, v => { config.numberRestartPerRow = v })
bindBool(showRowLabelsCheck, () => config.showRowLabels, v => { config.showRowLabels = v })
bindBool(conductorStandCheck, () => config.conductor.hasStand, v => { config.conductor.hasStand = v })
bindBool(showConductorCheck, () => config.conductor.show, v => { config.conductor.show = v })
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
    // 0 rows is allowed — e.g. a percussion-only chart with just fixed
    // instruments around the conductor.
    const target = Math.max(0, Math.min(20, Number.isFinite(v) ? v : 0))
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
  renderLabelList()
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
    const isStraight = straightFlags[i]

    const div = document.createElement('div')
    div.className = 'row-item'
    div.dataset['rowIndex'] = String(i)
    div.innerHTML = `
      <div class="row-item-header">
        <span class="row-item-name">Row ${row.label}</span>
        <label>Chairs
          <input type="number" min="1" max="30" value="${row.chairs.length}" data-row="${i}" class="chair-count">
        </label>
        <label>Label
          <input type="text" maxlength="6" value="${row.label}" data-row="${i}" class="row-label-input">
        </label>
        <button data-row="${i}" class="remove-row-btn" title="Remove row">✕</button>
      </div>
      <div class="row-item-meta">
        <label class="row-straight-toggle"><input type="checkbox" data-row="${i}" class="row-straight-check" ${isStraight ? 'checked' : ''}> Straight row</label>
      </div>
    `
    rowsContainer.appendChild(div)
  })

  rowsContainer.scrollTop = scrollTop
}

// --- Hover highlight (bidirectional: canvas <-> sidebar row controls) ---
// Makes it obvious which sidebar row maps to which chairs. Hovering a row
// control highlights that whole row of chairs; hovering a chair on the canvas
// highlights just that chair — but both light up the matching row control.
// Re-renders the canvas only (not the row lists) so the highlight classes and
// any input focus survive.

// Highlights the matching row control(s) in the Edit/Layout lists, or clears.
function highlightRowControl(i: number | null) {
  for (const el of document.querySelectorAll('.row-item.row-hover, .layout-row-item.row-hover')) {
    el.classList.remove('row-hover')
  }
  if (i !== null) {
    for (const el of document.querySelectorAll(`.row-item[data-row-index="${i}"], .layout-row-item[data-row-index="${i}"]`)) {
      el.classList.add('row-hover')
    }
  }
}

function rerenderCanvasOnly() {
  renderer.render(canvas, config, { layoutMode, dpr: renderDpr, showGhosts: activeTab !== 'export' })
}

// Sidebar → highlight the whole row of chairs.
function setHoverRow(i: number | null) {
  if (renderer.hoverRowIndex === i && renderer.hoverChair === null) return
  renderer.hoverRowIndex = i
  renderer.hoverChair = null
  rerenderCanvasOnly()
  highlightRowControl(i)
}

// Canvas → highlight just the hovered chair (and flag its row control).
function setHoverChair(hit: { rowIndex: number; chairIndex: number } | null) {
  const c = renderer.hoverChair
  const sameChair = (!c && !hit) ||
    (!!c && !!hit && c.rowIndex === hit.rowIndex && c.chairIndex === hit.chairIndex)
  if (sameChair && renderer.hoverRowIndex === null) return
  renderer.hoverChair = hit
  renderer.hoverRowIndex = null
  rerenderCanvasOnly()
  highlightRowControl(hit ? hit.rowIndex : null)
}

// True while any canvas drag is in progress, so hover detection stays quiet.
function anyDragActive(): boolean {
  return !!(titleDrag || arcRangeDrag || layoutDrag || deskDrag || chairDrag
    || marqueeState || panState || conductorDragState || rotateState || dragState)
}

// The chair under a canvas pointer event (via the chair hit targets), or null.
function chairAtPointer(e: PointerEvent): { rowIndex: number; chairIndex: number } | null {
  const cv = pointerCanvasCoords(e)
  const { x, y } = canvasToChart(cv.x, cv.y)
  const hit = renderer.hitTest(x, y)
  return hit ? { rowIndex: hit.rowIndex, chairIndex: hit.chairIndex } : null
}

// Wires a row-control list so hovering or focusing a row highlights the matching
// chairs on the canvas (the canvas->control direction is handled separately).
function bindRowControlHover(container: HTMLElement) {
  const indexFrom = (t: EventTarget | null): number | null => {
    const item = (t as HTMLElement | null)?.closest?.('[data-row-index]')
    return item ? Number(item.getAttribute('data-row-index')) : null
  }
  container.addEventListener('pointermove', (e) => setHoverRow(indexFrom(e.target)))
  container.addEventListener('pointerleave', () => setHoverRow(null))
  // Keyboard focus / typing in a row's inputs also highlights it.
  container.addEventListener('focusin', (e) => setHoverRow(indexFrom(e.target)))
  container.addEventListener('focusout', (e) => {
    if (!container.contains((e as FocusEvent).relatedTarget as Node)) setHoverRow(null)
  })
}

// Hiding/showing a chair re-packs the row's labels so none get stranded on a
// hidden seat: the toggled chair and every still-enabled chair after it rotate
// their labels by one. Hiding rotates "right" — the toggled (now hidden) seat
// parks the trailing label while the later chairs slide up to fill the gap;
// showing rotates "left", the exact inverse, so un-hiding the same chair
// restores the original order. Pre-existing hidden chairs (e.g. preset spacers)
// are skipped so their blanks never flow into a visible seat.
function repackLabelsAfterToggle(chairs: Chair[], i: number, nowHidden: boolean): void {
  const idxs = [i]
  for (let j = i + 1; j < chairs.length; j++) {
    if (chairs[j].enabled) idxs.push(j)
  }
  if (idxs.length < 2) return   // nothing after it to shift into
  const labels = idxs.map(k => chairs[k].label)
  if (nowHidden) labels.unshift(labels.pop()!)   // rotate right
  else           labels.push(labels.shift()!)    // rotate left
  idxs.forEach((k, n) => { chairs[k].label = labels[n] })
}

// The "paste a list" label editor in the Labels panel — one textarea per row,
// one label per line. Kept in sync with renderRowList (rebuilt on row changes).
function renderLabelList() {
  const scrollTop = labelList.scrollTop
  labelList.innerHTML = config.rows.map((row, i) => {
    // Hidden chairs (disabled seats, preset spacers) are skipped so the list
    // reads as the actual players — no empty lines to keep aligned by hand.
    const visible = row.chairs.filter(c => c.enabled)
    if (visible.length === 0) return ''
    const labelsText = visible.map(c => c.label).join('\n')
    const taRows = Math.min(12, Math.max(2, visible.length))
    return `<div class="label-row">
      <span class="label-row-name">Row ${row.label}</span>
      <textarea class="chair-labels-ta" data-row="${i}" rows="${taRows}">${labelsText}</textarea>
    </div>`
  }).join('')
  labelList.scrollTop = scrollTop
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
  'microphone': 'Microphone',
  'gong': 'Gong',
  'cymbal': 'Suspended Cymbal',
  'snare': 'Snare Drum',
  'chair': 'Chair',
  'stand': 'Music Stand',
  'stool': 'Stool',
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
    inspectorTimpaniOptions.style.display = ''
    inspectorTimpaniStool.checked = inst.stool === true
  } else {
    inspectorCountLabel.style.display = 'none'
    inspectorTimpaniOptions.style.display = 'none'
  }

  if (inst.type === 'microphone') {
    inspectorMicOptions.style.display = ''
    inspectorMicStand.checked = inst.micStand !== false
    inspectorMicWireless.checked = inst.wireless === true
  } else {
    inspectorMicOptions.style.display = 'none'
  }
}

function setSelectedInstrument(id: string | null) {
  selectedInstrumentId = id
  renderer.selectedInstrumentId = id
  renderInspector()
}

function pointerCanvasCoords(e: MouseEvent): { x: number; y: number } {
  // getBoundingClientRect already reflects the canvas's CSS zoom/pan
  // transform, so dividing by rect.width/height back into backing pixels
  // works at any zoom level without referencing viewZoom directly.
  const rect = canvas.getBoundingClientRect()
  // canvas.width/rect.width converts a CSS pointer delta into backing pixels
  // (this already folds in dpr and the CSS view-zoom). Dividing by viewScale*dpr
  // then lands us in the chart's logical coord space, where hit targets live.
  const s = (renderer.viewScale || 1) * renderDpr
  return {
    x: (e.clientX - rect.left) * (canvas.width / rect.width) / s,
    y: (e.clientY - rect.top) * (canvas.height / rect.height) / s,
  }
}

// --- View zoom/pan helpers ---

function applyViewTransform() {
  canvas.style.transform = `translate(${viewPanX}px, ${viewPanY}px) scale(${viewZoom})`
  canvas.classList.toggle('pannable', viewZoom > 1)
  zoomResetBtn.textContent = `${Math.round(viewZoom * 100)}%`
  zoomInBtn.disabled = viewZoom >= VIEW_ZOOM_MAX - 1e-6
  zoomOutBtn.disabled = viewZoom <= VIEW_ZOOM_MIN + 1e-6
}

// Zoom toward an anchor point given in client coords (defaults to the canvas
// centre). Keeps the anchored chart point pinned under the cursor.
function setZoom(target: number, anchorClientX?: number, anchorClientY?: number) {
  const next = Math.max(VIEW_ZOOM_MIN, Math.min(VIEW_ZOOM_MAX, target))
  if (next === viewZoom) return
  const rect = canvas.getBoundingClientRect()
  const ax = anchorClientX ?? rect.left + rect.width / 2
  const ay = anchorClientY ?? rect.top + rect.height / 2
  // panX' = panX + (anchor - rect.left) * (1 - next/zoom)   (see view-state note)
  viewPanX += (ax - rect.left) * (1 - next / viewZoom)
  viewPanY += (ay - rect.top) * (1 - next / viewZoom)
  viewZoom = next
  if (viewZoom === VIEW_ZOOM_MIN) { viewPanX = 0; viewPanY = 0 }
  applyViewTransform()
}

function resetZoom() {
  viewZoom = 1
  viewPanX = 0
  viewPanY = 0
  applyViewTransform()
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

// --- Layout-tab handle drags ---

const LAYOUT_MIN_SPACING = 34   // px floor so straight-row chairs never overlap

// Applies the in-progress distance/span drag to the dragged row. Distance is
// a radial (arc) / vertical (straight) delta from grab point; span moves the
// row's ends — symmetric by default, Shift moves only the grabbed end.
function applyLayoutDrag(e: MouseEvent) {
  if (!layoutDrag) return
  const cv = pointerCanvasCoords(e)
  const { x, y } = canvasToChart(cv.x, cv.y)
  if (!layoutDrag.moved) {
    if (Math.hypot(x - layoutDrag.start.x, y - layoutDrag.start.y) < DRAG_THRESHOLD) return
    history.push(layoutDrag.preDragConfig)
    layoutDrag.moved = true
  }

  const { ox, oy, yDir } = renderer.conductorOrigin
  const xDir = -yDir
  const g = layoutDrag.geom0
  const row = config.rows[layoutDrag.rowIndex]
  const N = row.chairs.length

  if (layoutDrag.kind === 'distance') {
    // Radial distance from the conductor (arc) / vertical distance (straight).
    const dist = (px: number, py: number) =>
      g.isStraight ? (py - oy) * yDir : Math.hypot(px - ox, py - oy)
    let newR = g.r + (dist(x, y) - dist(layoutDrag.start.x, layoutDrag.start.y))
    const minR = g.rowIndex === 0 ? 60 : g.prevR + 44
    newR = Math.max(minR, newR)
    row.gapBefore = newR - g.base
  } else if (g.isStraight) {
    // Span = chair spacing. Work along the row's x axis.
    const exOf = (px: number) => (px - ox) / xDir
    const delta = exOf(x) - exOf(layoutDrag.start.x)
    const halfW0 = ((N - 1) * g.spacing) / 2
    const minHalf = (LAYOUT_MIN_SPACING * (N - 1)) / 2
    if (e.shiftKey) {
      // Move the grabbed end only; keep the opposite end fixed.
      const grabbingRight = layoutDrag.kind === 'span-end'
      const fixed = g.centerOffset + (grabbingRight ? -halfW0 : halfW0)
      const moving = g.centerOffset + (grabbingRight ? halfW0 : -halfW0) + delta
      const width = Math.max(LAYOUT_MIN_SPACING * (N - 1), Math.abs(moving - fixed))
      row.straightSpacing = width / (N - 1)
      row.straightOffset = grabbingRight ? fixed + width / 2 : fixed - width / 2
    } else {
      // Symmetric: both ends move oppositely, centre fixed.
      const sign = layoutDrag.kind === 'span-end' ? 1 : -1
      const halfW = Math.max(minHalf, halfW0 + sign * delta)
      row.straightSpacing = (2 * halfW) / (N - 1)
      row.straightOffset = g.centerOffset
    }
  } else {
    // Arc span — work in the row's angle space. The left end sits at ~π, on
    // the atan2 ±π seam, so the raw delta can jump by 2π; wrap it to (-π, π].
    const angOf = (px: number, py: number) => Math.atan2((py - oy) / yDir, (px - ox) / xDir)
    let dA = angOf(x, y) - angOf(layoutDrag.start.x, layoutDrag.start.y)
    dA = Math.atan2(Math.sin(dA), Math.cos(dA))
    let start = g.arcStart
    let end = g.arcEnd
    if (e.shiftKey) {
      if (layoutDrag.kind === 'span-end') end = g.arcEnd + dA
      else start = g.arcStart + dA
    } else if (layoutDrag.kind === 'span-end') {
      end = g.arcEnd + dA; start = g.arcStart - dA
    } else {
      start = g.arcStart + dA; end = g.arcEnd - dA
    }
    // Min span = where the chairs would touch at this radius (so you can keep
    // narrowing until they meet); max ≈ a near-full circle.
    const minSpan = Math.min(Math.PI * 0.98, ((N - 1) * LAYOUT_MIN_SPACING) / g.r)
    const maxSpan = Math.PI * 1.95
    if (e.shiftKey && layoutDrag.kind === 'span-end') {
      end = Math.min(start - minSpan, Math.max(start - maxSpan, end))
    } else if (e.shiftKey) {
      start = Math.max(end + minSpan, Math.min(end + maxSpan, start))
    } else {
      const mid = (start + end) / 2
      const half = Math.min(maxSpan, Math.max(minSpan, start - end)) / 2
      start = mid + half; end = mid - half
    }
    row.arcStart = start
    row.arcEnd = end
  }
  renderChart()
}

// Slides the grabbed chair along its row to follow the pointer, clamped so it
// can't get within LAYOUT_MIN_SPACING of either neighbour (no overlap). Edge
// chairs are unbounded on their open side. Stores the result as chair.offset.
function applyChairDrag(e: MouseEvent) {
  if (!chairDrag) return
  const cv = pointerCanvasCoords(e)
  const { x, y } = canvasToChart(cv.x, cv.y)
  if (!chairDrag.moved) {
    if (Math.hypot(x - chairDrag.start.x, y - chairDrag.start.y) < DRAG_THRESHOLD) return
    history.push(chairDrag.preDragConfig)
    chairDrag.moved = true
  }

  const { ox, oy, yDir } = renderer.conductorOrigin
  const xDir = -yDir
  const { rowIndex, chairIndex: i } = chairDrag
  const row = config.rows[rowIndex]
  const chair = row.chairs[i]
  const N = row.chairs.length

  if (chairDrag.isStraight) {
    const exOf = (px: number) => (px - ox) / xDir
    let exT = exOf(x)
    const left = i > 0 ? renderer.chairCenter(rowIndex, i - 1) : null    // smaller x
    const right = i < N - 1 ? renderer.chairCenter(rowIndex, i + 1) : null // larger x
    if (left) exT = Math.max(exOf(left.x) + LAYOUT_MIN_SPACING, exT)
    if (right) exT = Math.min(exOf(right.x) - LAYOUT_MIN_SPACING, exT)
    chair.offset = exT - chairDrag.base
  } else {
    const r = chairDrag.r
    const angOf = (px: number, py: number) => Math.atan2((py - oy) / yDir, (px - ox) / xDir)
    // Work in angular *displacement* from the chair's natural slot, wrapped to
    // (-π, π]. Using the raw pointer angle makes an end chair jump to the far
    // side when dragged past the row end (across the atan2 ±π seam).
    const norm = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))
    let disp = norm(chairDrag.naturalAngle - angOf(x, y))
    const minGap = LAYOUT_MIN_SPACING / r
    const left = i > 0 ? renderer.chairCenter(rowIndex, i - 1) : null    // larger angle
    const right = i < N - 1 ? renderer.chairCenter(rowIndex, i + 1) : null // smaller angle
    // Toward the row end (right / smaller angle) = larger displacement.
    if (right) disp = Math.min(disp, norm(chairDrag.naturalAngle - (angOf(right.x, right.y) + minGap)))
    if (left) disp = Math.max(disp, norm(chairDrag.naturalAngle - (angOf(left.x, left.y) - minGap)))
    chair.offset = disp * r
  }
  renderChart()
}

// Slides a whole desk (both chairs + their shared stand) along its row,
// applying the same tangential displacement to both chairs' offsets and
// clamping so the pair can't overlap the chairs on either side.
function applyDeskDrag(e: MouseEvent) {
  if (!deskDrag) return
  const cv = pointerCanvasCoords(e)
  const { x, y } = canvasToChart(cv.x, cv.y)
  if (!deskDrag.moved) {
    if (Math.hypot(x - deskDrag.start.x, y - deskDrag.start.y) < DRAG_THRESHOLD) return
    history.push(deskDrag.preDragConfig)
    deskDrag.moved = true
  }

  const { ox, oy, yDir } = renderer.conductorOrigin
  const xDir = -yDir
  const { rowIndex, i, off0, centers } = deskDrag
  const chairs = config.rows[rowIndex].chairs
  const ci = chairs[i], ci1 = chairs[i + 1]

  if (deskDrag.isStraight) {
    const exOf = (px: number) => (px - ox) / xDir
    // Raw tangential displacement the pointer has travelled along the row.
    let delta = exOf(x) - exOf(deskDrag.start.x)
    // Clamp: leftmost chair stays clear of the left neighbour, rightmost of the
    // right neighbour (exOf grows with chair index).
    if (centers.left) delta = Math.max(delta, exOf(centers.left.x) + LAYOUT_MIN_SPACING - exOf(centers.i.x))
    if (centers.right) delta = Math.min(delta, exOf(centers.right.x) - LAYOUT_MIN_SPACING - exOf(centers.i1.x))
    ci.offset = off0[0] + delta
    ci1.offset = off0[1] + delta
  } else {
    const r = deskDrag.r
    const angOf = (px: number, py: number) => Math.atan2((py - oy) / yDir, (px - ox) / xDir)
    const norm = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))
    // Angular displacement of the desk; +ve drives the pair toward the row end
    // (decreasing angle), which is what a positive chair.offset encodes.
    let dA = norm(angOf(deskDrag.start.x, deskDrag.start.y) - angOf(x, y))
    const minGap = LAYOUT_MIN_SPACING / r
    // Outer chairs' start angles; after the drag chair i sits at angle_i − dA.
    const aI = angOf(centers.i.x, centers.i.y)
    const aI1 = angOf(centers.i1.x, centers.i1.y)
    // chair i must stay minGap below the left neighbour (larger angle): aI − dA ≤ aLeft − minGap.
    if (centers.left) dA = Math.max(dA, aI - (angOf(centers.left.x, centers.left.y) - minGap))
    // chair i+1 must stay minGap above the right neighbour (smaller angle): aI1 − dA ≥ aRight + minGap.
    if (centers.right) dA = Math.min(dA, aI1 - (angOf(centers.right.x, centers.right.y) + minGap))
    ci.offset = off0[0] + dA * r
    ci1.offset = off0[1] + dA * r
  }
  renderChart()
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

  setSelectedInstrument(null)
  updateAllInputs()
  renderChart()
}

// --- Inline chair-label editor (Label tool: click a chair, type its name) ---

let editingChair: { rowIndex: number; chairIndex: number } | null = null
// True while the shared label input is editing the conductor podium instead of
// a chair. The two are mutually exclusive — opening one closes the other.
let editingConductor = false

// Screen position (within #canvas-area) of a chair's drawn centre, accounting
// for chartScale and the CSS view zoom/pan, so the floating input sits on it.
// Screen position of an arbitrary chart-space point (chairs, conductor, …),
// accounting for chartScale and the CSS view zoom/pan, so a floating input can
// sit on it.
function chartPointToScreen(c: { x: number; y: number }): { x: number; y: number } {
  const scale = config.chartScale ?? 1
  const { ox, oy } = renderer.conductorOrigin
  const canvasX = (c.x - ox) * scale + ox
  const canvasY = (c.y - oy) * scale + oy
  // canvasX/Y are in logical chart space; multiply by the auto-fit scale for
  // CSS px, then by the view zoom/pan. The label editor is positioned relative
  // to #canvas-area, so add the canvas's own offset within it (the mobile top
  // padding pushes the canvas down; 0 on desktop).
  const fit = renderer.viewScale || 1
  return {
    x: canvas.offsetLeft + viewPanX + canvasX * fit * viewZoom,
    y: canvas.offsetTop + viewPanY + canvasY * fit * viewZoom,
  }
}

function chairScreenPos(rowIndex: number, chairIndex: number): { x: number; y: number } | null {
  const c = renderer.chairCenter(rowIndex, chairIndex)
  if (!c) return null
  return chartPointToScreen(c)
}

// Float the shared label input at a screen position and arm it for editing.
function showLabelEditor(pos: { x: number; y: number }, value: string) {
  chairLabelInput.style.left = `${pos.x}px`
  chairLabelInput.style.top = `${pos.y}px`
  chairLabelInput.style.display = ''
  chairLabelInput.value = value
  chairLabelInput.focus()
  chairLabelInput.select()
}

function openChairLabelEditor(rowIndex: number, chairIndex: number) {
  const chair = config.rows[rowIndex]?.chairs[chairIndex]
  if (!chair || !chair.enabled) return
  const pos = chairScreenPos(rowIndex, chairIndex)
  if (!pos) return
  editingConductor = false
  editingChair = { rowIndex, chairIndex }
  showLabelEditor(pos, chair.label ?? '')
}

// Rename the conductor podium in place, reusing the same floating input as
// chair labels (instead of the browser's ugly window.prompt).
function openConductorLabelEditor() {
  const { ox, oy } = renderer.conductorOrigin
  editingChair = null
  editingConductor = true
  showLabelEditor(chartPointToScreen({ x: ox, y: oy }), config.conductor.label ?? 'COND')
}

function commitChairLabel() {
  if (editingConductor) {
    if ((config.conductor.label ?? 'COND') !== chairLabelInput.value) {
      history.push(config)
      // Blank reverts to the default rather than leaving an empty podium.
      config.conductor.label = chairLabelInput.value.trim() || undefined
      renderChart()
    }
    return
  }
  if (bulkLabelTargets) {
    // Free-type bulk label from a marquee: write to every target (skipping
    // already-labelled chairs unless "Overwrite labels" is on).
    const overwrite = overwriteLabels
    const targets = bulkLabelTargets.filter(r => {
      const c = config.rows[r.rowIndex]?.chairs[r.chairIndex]
      return c?.enabled && (overwrite || !c.label)
    })
    if (targets.length && chairLabelInput.value !== '') {
      history.push(config)
      for (const r of targets) config.rows[r.rowIndex].chairs[r.chairIndex].label = chairLabelInput.value
      renderChart()
    }
    return
  }
  if (!editingChair) return
  const chair = config.rows[editingChair.rowIndex]?.chairs[editingChair.chairIndex]
  if (chair && (chair.label ?? '') !== chairLabelInput.value) {
    history.push(config)
    chair.label = chairLabelInput.value
    renderChart()
  }
}

function closeChairLabelEditor() {
  editingChair = null
  editingConductor = false
  bulkLabelTargets = null
  chairLabelInput.style.display = 'none'
}

// After Enter: commit, then hop to the next enabled chair in the same row.
// The conductor isn't part of a row, so there's nowhere to advance to — close.
function advanceChairLabel() {
  if (editingConductor || bulkLabelTargets) { closeChairLabelEditor(); return }
  if (!editingChair) return
  const { rowIndex, chairIndex } = editingChair
  const chairs = config.rows[rowIndex].chairs
  let next = chairIndex + 1
  while (next < chairs.length && !chairs[next].enabled) next++
  if (next < chairs.length) openChairLabelEditor(rowIndex, next)
  else closeChairLabelEditor()
}

// --- Canvas interaction ---
//
// Uses pointer events (not mouse events) so everything works with a mouse,
// touch, or pen. Touch gets implicit pointer capture, and `touch-action: none`
// on the canvas stops a drag from scrolling the page. Secondary fingers
// (non-primary pointers) are ignored so multi-touch doesn't fight a drag.

const DRAG_THRESHOLD = 4   // pixels before a press is treated as a drag

canvas.addEventListener('pointerdown', (e) => {
  if (!e.isPrimary) return
  const cv = pointerCanvasCoords(e)
  const { x, y } = canvasToChart(cv.x, cv.y)

  // Export tab: the canvas is view-only — no chair / instrument / conductor
  // editing. Panning the zoomed view is still allowed.
  if (activeTab === 'export') {
    if (viewZoom > 1) {
      panState = { startX: e.clientX, startY: e.clientY, panX0: viewPanX, panY0: viewPanY, moved: false }
    }
    return
  }

  // Fixed-instrument editing (delete / rotate / select + drag) works in every
  // editable tab, Layout included — instruments are freely positioned, not
  // part of the row geometry.
  if (renderer.deleteHandleHitTest(x, y) && selectedInstrumentId) {
    history.push(config)
    config.instruments = config.instruments.filter(i => i.id !== selectedInstrumentId)
    setSelectedInstrument(null)
    renderChart()
    return
  }
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
  const instHit = renderer.instrumentHitTest(x, y)
  if (instHit) {
    setSelectedInstrument(instHit.id)
    dragState = {
      instrumentId: instHit.id,
      offsetX: x - instHit.cx,
      offsetY: y - instHit.cy,
      preDragConfig: cloneConfig(config),
      moved: false,
      // Stand tool (in the chair-tool tabs, not Layout): a plain click toggles
      // the stand, but the instrument is still draggable to reposition it.
      toggleStandOnClick: !layoutMode && activeTool === 'stand',
    }
    renderChart()
    return
  }

  // Conductor: drag to move the whole chart, in the positioning tabs.
  if (conductorMovable() && renderer.conductorHitTest(x, y)) {
    conductorDragState = {
      startX: cv.x, startY: cv.y,
      initialOffsetX: config.conductor.offsetX,
      initialOffsetY: config.conductor.offsetY,
      preDragConfig: cloneConfig(config),
      moved: false,
    }
    if (selectedInstrumentId) { setSelectedInstrument(null); renderChart() }
    return
  }

  // Layout tab: row geometry handles / per-chair nudge / pan.
  if (layoutMode) {
    // Title is draggable here. It's drawn in raw canvas px, so test/drag with
    // the un-transformed pointer (cv), not the chart-space coords.
    if (renderer.titleHitTest(cv.x, cv.y)) {
      titleDrag = {
        startX: cv.x, startY: cv.y,
        x0: config.titleOffsetX ?? 0, y0: config.titleOffsetY ?? 0,
        preDragConfig: cloneConfig(config), moved: false,
      }
      return
    }
    const handle = renderer.layoutHandleHitTest(x, y)
    if (handle) {
      if (handle.kind === 'arc-range-start' || handle.kind === 'arc-range-end') {
        arcRangeDrag = { startX: x, startY: y, preDragConfig: cloneConfig(config), moved: false }
        return
      }
      if (handle.kind === 'desk' && handle.chairIndex !== undefined) {
        const g = renderer.layoutRows[handle.rowIndex]
        const i = handle.chairIndex
        const row = config.rows[handle.rowIndex]
        const ci = renderer.chairCenter(handle.rowIndex, i)
        const ci1 = renderer.chairCenter(handle.rowIndex, i + 1)
        if (g && ci && ci1) {
          deskDrag = {
            rowIndex: handle.rowIndex, i, isStraight: g.isStraight, r: g.r,
            off0: [row.chairs[i].offset ?? 0, row.chairs[i + 1].offset ?? 0],
            centers: {
              i: ci, i1: ci1,
              left: i > 0 ? renderer.chairCenter(handle.rowIndex, i - 1) : null,
              right: i + 2 < row.chairs.length ? renderer.chairCenter(handle.rowIndex, i + 2) : null,
            },
            start: { x, y },
            preDragConfig: cloneConfig(config), moved: false,
          }
          return
        }
      }
      const geom0 = renderer.layoutRows[handle.rowIndex]
      if (geom0 && (handle.kind === 'distance' || handle.kind === 'span-start' || handle.kind === 'span-end')) {
        layoutDrag = {
          rowIndex: handle.rowIndex,
          kind: handle.kind,
          geom0,
          start: { x, y },
          preDragConfig: cloneConfig(config),
          moved: false,
        }
        return
      }
    }
    const hit = renderer.hitTest(x, y)
    const g = hit ? renderer.layoutRows[hit.rowIndex] : null
    if (hit && g) {
      const chair = config.rows[hit.rowIndex].chairs[hit.chairIndex]
      const off0 = chair.offset ?? 0
      const { ox, oy, yDir } = renderer.conductorOrigin
      const xDir = -yDir
      // Back the current offset out of the drawn position to recover the
      // chair's natural slot, so the new offset is just (natural − target).
      const naturalAngle = g.isStraight ? 0
        : Math.atan2((hit.y - oy) / yDir, (hit.x - ox) / xDir) + off0 / g.r
      const base = g.isStraight ? (hit.x - ox) / xDir - off0 : 0
      chairDrag = {
        rowIndex: hit.rowIndex, chairIndex: hit.chairIndex,
        isStraight: g.isStraight, r: g.r, naturalAngle, base,
        start: { x, y }, preDragConfig: cloneConfig(config), moved: false,
      }
      return
    }
    // Empty space: deselect any instrument, otherwise pan the zoomed view.
    if (selectedInstrumentId) { setSelectedInstrument(null); renderChart() }
    else if (viewZoom > 1) {
      panState = { startX: e.clientX, startY: e.clientY, panX0: viewPanX, panY0: viewPanY, moved: false }
    }
    return
  }

  // Edit / Setup (non-layout). The conductor in Edit isn't movable — a click
  // renames it (handled in the click listener). Chairs are handled there too.
  if (renderer.conductorHitTest(x, y)) {
    if (selectedInstrumentId) { setSelectedInstrument(null); renderChart() }
    return
  }
  if (selectedInstrumentId) {
    setSelectedInstrument(null)
    renderChart()
  }
  // Edit tab at 100% zoom: a mouse/pen drag is a marquee bulk-select (touch
  // drags never marquee — a finger needs to pan/scroll, not draw a box). When
  // zoomed in, keep the existing drag-to-pan behaviour instead (no transform to
  // fight at 100%, so the screen-space overlay box maps 1:1 to the canvas).
  if (activeTab === 'edit' && viewZoom === 1 && e.pointerType !== 'touch') {
    marqueeState = { startClientX: e.clientX, startClientY: e.clientY, startChart: { x, y }, moved: false }
  } else if (viewZoom > 1) {
    panState = { startX: e.clientX, startY: e.clientY, panX0: viewPanX, panY0: viewPanY, moved: false }
  }
})

window.addEventListener('pointermove', (e) => {
  if (!e.isPrimary) return
  // Layout-tab title drag (raw canvas px → config.titleOffset).
  if (titleDrag) {
    const cv = pointerCanvasCoords(e)
    const dx = cv.x - titleDrag.startX
    const dy = cv.y - titleDrag.startY
    if (!titleDrag.moved) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return
      history.push(titleDrag.preDragConfig)
      titleDrag.moved = true
    }
    config.titleOffsetX = titleDrag.x0 + dx
    config.titleOffsetY = titleDrag.y0 + dy
    renderChart()
    return
  }
  // Default arc-range drag — sets config.arcRange (moves all non-edited rows).
  if (arcRangeDrag) {
    const cv = pointerCanvasCoords(e)
    const { x, y } = canvasToChart(cv.x, cv.y)
    if (!arcRangeDrag.moved) {
      if (Math.hypot(x - arcRangeDrag.startX, y - arcRangeDrag.startY) < DRAG_THRESHOLD) return
      history.push(arcRangeDrag.preDragConfig)
      arcRangeDrag.moved = true
    }
    const { ox, oy, yDir } = renderer.conductorOrigin
    const xDir = -yDir
    const a = Math.atan2((y - oy) / yDir, (x - ox) / xDir)
    const range = Math.max(Math.PI / 3, Math.min(Math.PI, 2 * Math.abs(a - Math.PI / 2)))
    config.arcRange = range
    arcRangeInput.value = String(Math.round((range * 180) / Math.PI))
    renderChart()
    return
  }
  // Layout-tab handle drag (distance / span).
  if (layoutDrag) {
    applyLayoutDrag(e)
    return
  }
  // Layout-tab desk-group drag (slides a two-chair desk along the row).
  if (deskDrag) {
    applyDeskDrag(e)
    return
  }
  // Layout-tab per-chair nudge.
  if (chairDrag) {
    applyChairDrag(e)
    return
  }

  // Edit-tab marquee — resize the screen-space overlay box from the grab point
  // to the pointer. Positioned within #canvas-area (the box's offset parent).
  if (marqueeState) {
    if (!marqueeState.moved) {
      if (Math.hypot(e.clientX - marqueeState.startClientX, e.clientY - marqueeState.startClientY) < DRAG_THRESHOLD) return
      marqueeState.moved = true
      marqueeBox.style.display = ''
    }
    const area = canvasArea.getBoundingClientRect()
    const x0 = Math.min(marqueeState.startClientX, e.clientX) - area.left
    const y0 = Math.min(marqueeState.startClientY, e.clientY) - area.top
    marqueeBox.style.left = `${x0}px`
    marqueeBox.style.top = `${y0}px`
    marqueeBox.style.width = `${Math.abs(e.clientX - marqueeState.startClientX)}px`
    marqueeBox.style.height = `${Math.abs(e.clientY - marqueeState.startClientY)}px`
    return
  }

  // View pan — drag empty space while zoomed in. Works in raw screen pixels
  // (the CSS transform's own units), independent of chart coords.
  if (panState) {
    const dx = e.clientX - panState.startX
    const dy = e.clientY - panState.startY
    if (!panState.moved) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return
      panState.moved = true
      canvas.classList.add('panning')
    }
    viewPanX = panState.panX0 + dx
    viewPanY = panState.panY0 + dy
    applyViewTransform()
    return
  }

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

window.addEventListener('pointerup', (e) => {
  if (!e.isPrimary) return
  if (panState?.moved) suppressClickAfterPan = true
  // Edit-tab marquee release: apply the active tool to every chair in the box.
  // A box that never moved is just a click — let the click handler do its thing.
  if (marqueeState) {
    if (marqueeState.moved) {
      const cv = pointerCanvasCoords(e)
      const end = canvasToChart(cv.x, cv.y)
      const start = marqueeState.startChart
      const refs = renderer.chairsInRect(start.x, start.y, end.x, end.y)
      const centre = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
      applyBulkTool(refs, centre)
      suppressClickAfterPan = true   // swallow the trailing click
    }
    marqueeState = null
    marqueeBox.style.display = 'none'
  }
  // Stand tool: a press on an instrument that never became a drag toggles its
  // music stand (a real drag just repositioned it instead).
  if (dragState && !dragState.moved && dragState.toggleStandOnClick) {
    const inst = config.instruments.find(i => i.id === dragState!.instrumentId)
    if (inst) {
      history.push(config)
      inst.hasStand = !inst.hasStand
      renderChart()
    }
  }
  const finishedLayoutDrag = layoutDrag?.moved || chairDrag?.moved || deskDrag?.moved
    || conductorDragState?.moved || arcRangeDrag?.moved
  dragState = null
  rotateState = null
  conductorDragState = null
  panState = null
  layoutDrag = null
  chairDrag = null
  deskDrag = null
  titleDrag = null
  arcRangeDrag = null
  canvas.classList.remove('panning')
  // The per-row boxes are skipped mid-drag; refresh them now the drag is done.
  if (finishedLayoutDrag && layoutMode) updateLayoutRowList()
})

// Click handler runs after mouseup. Skip if the click landed on an instrument
// or its rotate handle (already handled in mousedown) so chair/conductor logic
// doesn't fire on top.
// Layout tab: double-click a handle to reset that row's tweak.
canvas.addEventListener('dblclick', (e) => {
  if (!layoutMode) return
  const cv = pointerCanvasCoords(e)
  // Double-click the title to snap it back to its auto position.
  if (renderer.titleHitTest(cv.x, cv.y) && (config.titleOffsetX || config.titleOffsetY)) {
    history.push(config)
    delete config.titleOffsetX
    delete config.titleOffsetY
    renderChart()
    return
  }
  const { x, y } = canvasToChart(cv.x, cv.y)
  const handle = renderer.layoutHandleHitTest(x, y)
  if (handle) {
    // Default arc-range handles → reset the default back to a full 180°.
    if (handle.kind === 'arc-range-start' || handle.kind === 'arc-range-end') {
      if ((config.arcRange ?? Math.PI) !== Math.PI) {
        history.push(config)
        config.arcRange = Math.PI
        arcRangeInput.value = '180'
        renderChart()
      }
      return
    }
    const row = config.rows[handle.rowIndex]
    // Desk handle → clear the sideways nudge on both chairs of the pair.
    if (handle.kind === 'desk' && handle.chairIndex !== undefined) {
      const a = row.chairs[handle.chairIndex], b = row.chairs[handle.chairIndex + 1]
      if (a?.offset !== undefined || b?.offset !== undefined) {
        history.push(config)
        if (a) delete a.offset
        if (b) delete b.offset
        renderChart()
      }
      return
    }
    history.push(config)
    if (handle.kind === 'distance') {
      delete row.gapBefore
    } else {
      delete row.arcStart
      delete row.arcEnd
      delete row.straightSpacing
      delete row.straightOffset
    }
    renderChart()
    return
  }
  // Double-click a chair to clear its sideways nudge.
  const hit = renderer.hitTest(x, y)
  if (hit) {
    const chair = config.rows[hit.rowIndex].chairs[hit.chairIndex]
    if (chair.offset !== undefined) {
      history.push(config)
      delete chair.offset
      renderChart()
    }
  }
})

// --- Shared chair mutations (single click + marquee bulk-apply) ---

function applyStoolToChair(chair: Chair, mode: StoolMode) {
  chair.isStool = mode === 'stool'
  chair.noSeat = mode === 'standing'
}

// The seat/stand state a chair is currently in, expressed as a tool mode —
// used to work out the next option when cycling on repeated clicks.
function chairStoolMode(chair: Chair): StoolMode {
  if (chair.noSeat) return 'standing'
  if (chair.isStool) return 'stool'
  return 'chair'
}
function chairStandMode(rowChairs: Chair[], i: number): StandMode {
  const chair = rowChairs[i]
  if (chair.standAfter) return 'desk'
  if (chair.hasStand) return 'solo'
  return 'remove'
}
function nextInCycle<T>(cycle: T[], current: T): T {
  const i = cycle.indexOf(current)
  return cycle[(i + 1) % cycle.length] as T
}
// True if this click lands on the same chair the cycling tool last acted on
// (so it should step to the next option rather than re-apply the armed mode).
function isRepeatCycleClick(tool: ChairTool, hit: { rowIndex: number; chairIndex: number }): boolean {
  return lastCycledChair !== null && lastCycledChair.tool === tool
    && lastCycledChair.rowIndex === hit.rowIndex && lastCycledChair.chairIndex === hit.chairIndex
}

// Stand for one chair. 'desk' shares a stand with the next enabled neighbour;
// any desk that paired *into* this chair from the left is dissolved first so we
// never leave a half-desk pointing at a now-soloed/removed seat.
function applyStandToChair(rowChairs: Chair[], i: number, mode: StandMode) {
  const chair = rowChairs[i]
  const prev = rowChairs[i - 1]
  if (prev?.standAfter) prev.standAfter = false
  chair.hasStand = false
  chair.standAfter = false
  if (mode === 'remove') return
  if (mode === 'solo') { chair.hasStand = true; return }
  const next = rowChairs[i + 1]
  if (next?.enabled) { chair.standAfter = true; next.hasStand = false; next.standAfter = false }
  else chair.hasStand = true   // no neighbour to desk with → solo
}

// Marquee Stand: 'desk' pairs *consecutive adjacent* selected chairs within each
// row into shared desks (leftover → solo); solo/remove go per-chair.
function applyStandModeToTargets(targets: { rowIndex: number; chairIndex: number }[]) {
  const byRow = new Map<number, number[]>()
  for (const r of targets) (byRow.get(r.rowIndex) ?? byRow.set(r.rowIndex, []).get(r.rowIndex)!).push(r.chairIndex)
  for (const [rowIndex, idxs] of byRow) {
    idxs.sort((a, b) => a - b)
    const rowChairs = config.rows[rowIndex].chairs
    if (standMode !== 'desk') {
      for (const i of idxs) applyStandToChair(rowChairs, i, standMode)
      continue
    }
    // Clear own + incoming pairing across the whole selection first.
    for (const i of idxs) {
      const prev = rowChairs[i - 1]; if (prev?.standAfter) prev.standAfter = false
      rowChairs[i].hasStand = false; rowChairs[i].standAfter = false
    }
    let k = 0
    while (k < idxs.length) {
      const i = idxs[k], j = idxs[k + 1]
      if (j === i + 1 && rowChairs[j].enabled) {
        rowChairs[i].standAfter = true
        rowChairs[j].hasStand = false; rowChairs[j].standAfter = false
        k += 2
      } else {
        rowChairs[i].hasStand = true
        k += 1
      }
    }
  }
}

// Open the floating label input in bulk mode (free-type Label tool + marquee):
// committing writes the typed value to every target at once.
function openBulkLabelEditor(targets: { rowIndex: number; chairIndex: number }[], pos: { x: number; y: number }) {
  editingChair = null
  editingConductor = false
  bulkLabelTargets = targets
  showLabelEditor(pos, '')
}

// The floating "Overwrite labels" toggle only matters while bulk-labelling with
// a mouse, so it's shown over the canvas just for the Label / Instruments tools
// in the Edit tab, and only where a marquee is possible (a fine pointer).
function syncDragControls() {
  const show = hasFinePointer && activeTab === 'edit'
    && (activeTool === 'label' || activeTool === 'instrument')
  dragOverwriteBtn.style.display = show ? '' : 'none'
}

// Apply the active chair tool to every enabled chair caught by a marquee drag,
// in a single undo step. `centre` is the box centre (chart coords), used only to
// place the free-type bulk-label input.
function applyBulkTool(refs: { rowIndex: number; chairIndex: number }[], centre: { x: number; y: number }) {
  const targets = refs.filter(r => config.rows[r.rowIndex]?.chairs[r.chairIndex]?.enabled)
  if (targets.length === 0) return

  if (activeTool === 'label' || activeTool === 'instrument') {
    if (selectedLabel === null) { openBulkLabelEditor(targets, chartPointToScreen(centre)); return }
    const toWrite = targets.filter(r => overwriteLabels || !config.rows[r.rowIndex].chairs[r.chairIndex].label)
    if (toWrite.length === 0) return
    history.push(config)
    for (const r of toWrite) config.rows[r.rowIndex].chairs[r.chairIndex].label = selectedLabel
    renderChart()
    return
  }

  history.push(config)
  if (activeTool === 'color') {
    for (const r of targets) config.rows[r.rowIndex].chairs[r.chairIndex].color = activeColor
  } else if (activeTool === 'toggle') {
    for (const r of targets) config.rows[r.rowIndex].chairs[r.chairIndex].enabled = false
  } else if (activeTool === 'stool') {
    for (const r of targets) applyStoolToChair(config.rows[r.rowIndex].chairs[r.chairIndex], stoolMode)
  } else if (activeTool === 'stand') {
    applyStandModeToTargets(targets)
  }
  // A marquee isn't a single-chair click, so the next click should re-apply
  // the armed mode rather than cycle.
  lastCycledChair = null
  renderChart()
}

canvas.addEventListener('click', (e) => {
  // A drag-pan just ended — swallow the click so it doesn't toggle a chair.
  if (suppressClickAfterPan) {
    suppressClickAfterPan = false
    return
  }
  // Layout tab suspends chair/conductor click-editing; Export is view-only.
  if (layoutMode || activeTab === 'export') return
  const cv = pointerCanvasCoords(e)
  const { x, y } = canvasToChart(cv.x, cv.y)
  if (renderer.deleteHandleHitTest(x, y)) return
  if (renderer.rotateHandleHitTest(x, y)) return
  if (renderer.instrumentHitTest(x, y)) return

  // Edit tab: click the conductor to rename its podium label. (In Setup/Layout
  // a click is the tail of a move, so renaming there would be surprising.)
  if (renderer.conductorHitTest(x, y)) {
    if (activeTab === 'edit') openConductorLabelEditor()
    return
  }

  const hit = renderer.hitTest(x, y)
  if (!hit) return
  // Label tool → type a free-text label right on the chair.
  if (activeTool === 'label') {
    openChairLabelEditor(hit.rowIndex, hit.chairIndex)
    return
  }
  // Instruments tool → stamp the picked instrument (no-op until one is picked).
  if (activeTool === 'instrument') {
    if (selectedLabel === null) return
    history.push(config)
    config.rows[hit.rowIndex].chairs[hit.chairIndex].label = selectedLabel
    renderChart()
    return
  }

  history.push(config)
  const chair = config.rows[hit.rowIndex].chairs[hit.chairIndex]

  if (activeTool === 'color') {
    chair.color = activeColor
    lastCycledChair = null
  } else if (activeTool === 'toggle') {
    chair.enabled = !chair.enabled
    // Re-pack labels so the hidden seat doesn't strand its label (and un-hiding
    // restores it) — see repackLabelsAfterToggle.
    repackLabelsAfterToggle(config.rows[hit.rowIndex].chairs, hit.chairIndex, !chair.enabled)
    lastCycledChair = null
  } else if (activeTool === 'stool') {
    // First click on a chair applies the armed seat type (the sub-panel acts as
    // a mode selector for both clicks and marquee drags); clicking the same
    // chair again cycles through Chair / Stool / Standing. If the chair is
    // already in the armed mode, applying it would do nothing, so cycle instead.
    const current = chairStoolMode(chair)
    const mode = isRepeatCycleClick('stool', hit) || current === stoolMode
      ? nextInCycle(STOOL_CYCLE, current) : stoolMode
    applyStoolToChair(chair, mode)
    lastCycledChair = { rowIndex: hit.rowIndex, chairIndex: hit.chairIndex, tool: 'stool' }
  } else if (activeTool === 'stand') {
    // First click applies the armed stand mode; repeated clicks on the same
    // chair cycle through Solo / Remove / In desks. If the chair is already in
    // the armed mode, applying it would do nothing, so cycle instead.
    const rowChairs = config.rows[hit.rowIndex].chairs
    const current = chairStandMode(rowChairs, hit.chairIndex)
    const mode = isRepeatCycleClick('stand', hit) || current === standMode
      ? nextInCycle(STAND_CYCLE, current) : standMode
    applyStandToChair(rowChairs, hit.chairIndex, mode)
    lastCycledChair = { rowIndex: hit.rowIndex, chairIndex: hit.chairIndex, tool: 'stand' }
  }

  renderChart()
})

// --- Events ---

function bindEvents() {
  for (const el of [titleInput, layoutSelect, notesArea, showNumbersCheck,
    restartNumbersCheck, showRowLabelsCheck, conductorStandCheck, showConductorCheck, flipCheck,
    straightRowsInput, rowCountInput, showArcCheck, arcRangeInput, rowSpacingInput,
    showStageDirectionsCheck, chartScaleInput, bgFitSelect, showCreditCheck]) {
    el.addEventListener('change', () => { readInputs(); updateAllInputs(); renderChart() })
  }

  // Bidirectional row-hover highlight. Canvas hover -> highlight the chairs
  // under the cursor and their sidebar row control; hovering/focusing a row
  // control highlights the matching chairs on the canvas.
  canvas.addEventListener('pointermove', (e) => {
    if (!e.isPrimary || anyDragActive()) return
    if (activeTab !== 'edit' && activeTab !== 'layout') return
    setHoverChair(chairAtPointer(e))
  })
  canvas.addEventListener('pointerleave', () => setHoverChair(null))
  bindRowControlHover(rowsContainer)
  bindRowControlHover(layoutRowList)

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
    renderLabelList()   // chair count / row label changed → rebuild the paste list
    renderChart()
  })

  // Row list: remove row
  rowsContainer.addEventListener('click', (e) => {
    const target = e.target as HTMLElement
    if (target.classList.contains('remove-row-btn')) {
      const rowIdx = Number(target.dataset['row'])
      if (isNaN(rowIdx)) return
      history.push(config)
      config.rows.splice(rowIdx, 1)
      config.straightRows = Math.min(config.straightRows, config.rows.length)
      updateAllInputs()
      renderChart()
    }
  })

  // Paste-a-list label editor (Labels panel) — live update on every keystroke.
  labelList.addEventListener('input', (e) => {
    const target = e.target as HTMLTextAreaElement
    if (!target.classList.contains('chair-labels-ta')) return
    const rowIdx = Number(target.dataset['row'])
    if (isNaN(rowIdx)) return
    const lines = target.value.split('\n')
    // One line per *visible* chair — hidden seats are skipped (they aren't
    // shown in the textarea), so walk an independent line cursor.
    let li = 0
    config.rows[rowIdx].chairs.forEach((chair) => {
      if (!chair.enabled) return
      chair.label = lines[li++] ?? ''
    })
    renderChart()
  })

  // Push to history on blur (not on every keystroke).
  labelList.addEventListener('focusout', (e) => {
    const target = e.target as HTMLElement
    if (!target.classList.contains('chair-labels-ta')) return
    history.push(config)
  })

  // Tab / Shift+Tab moves between the per-row label editors.
  labelList.addEventListener('keydown', (e) => {
    const target = e.target as HTMLTextAreaElement
    if (!target.classList.contains('chair-labels-ta')) return
    if (e.key !== 'Tab') return
    e.preventDefault()
    // Walk the rendered textareas directly so Tab skips any rows that were
    // omitted (every chair hidden) without landing on a gap.
    const tas = [...labelList.querySelectorAll<HTMLTextAreaElement>('.chair-labels-ta')]
    const cur = tas.indexOf(target)
    tas[e.shiftKey ? cur - 1 : cur + 1]?.focus()
  })

  // Add fixed instrument
  addInstrumentButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const type = btn.dataset['addInstrument'] as InstrumentType
      history.push(config)
      const sameTypeCount = config.instruments.filter(i => i.type === type).length
      const inst = makeInstrument(type, config.flipped, sameTypeCount, renderer.backRowRadius(config))
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

  // Inspector — timpani player stool toggle
  inspectorTimpaniStool.addEventListener('change', () => {
    const inst = config.instruments.find(i => i.id === selectedInstrumentId)
    if (!inst || inst.type !== 'timpani') return
    history.push(config)
    inst.stool = inspectorTimpaniStool.checked
    renderChart()
  })

  // Inspector — microphone toggles (on a stand? wireless?)
  inspectorMicStand.addEventListener('change', () => {
    const inst = config.instruments.find(i => i.id === selectedInstrumentId)
    if (!inst || inst.type !== 'microphone') return
    history.push(config)
    inst.micStand = inspectorMicStand.checked
    renderChart()
  })
  inspectorMicWireless.addEventListener('change', () => {
    const inst = config.instruments.find(i => i.id === selectedInstrumentId)
    if (!inst || inst.type !== 'microphone') return
    history.push(config)
    inst.wireless = inspectorMicWireless.checked
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

  // Sidebar tab navigation (Setup / Edit / Layout / Export). Both the top tab
  // buttons and the bottom Next/Back nav buttons end up calling this.
  const switchTab = (tab: string | undefined) => {
    if (!tab) return
    activeTab = tab
    setHoverRow(null)         // drop any row-hover highlight when changing tabs
    closeChairLabelEditor()   // don't leave the inline editor floating after a tab change
    // Export is view-only — drop any instrument selection so its (now
    // non-interactive) handles don't linger on the chart.
    if (tab === 'export' && selectedInstrumentId) { setSelectedInstrument(null); renderChart() }
    tabButtons.forEach(b => b.classList.toggle('active', b.dataset['tab'] === tab))
    tabContents.forEach(c => c.classList.toggle('active', c.dataset['tabContent'] === tab))
    // Scroll the sidebar back to the top so Next/Back doesn't strand the
    // user partway down the new tab.
    document.getElementById('sidebar')?.scrollTo({ top: 0 })
    // Entering/leaving the Layout tab flips the canvas into geometry-editing
    // mode (arc guides + handles); re-render so the guides appear/disappear.
    const nowLayout = tab === 'layout'
    if (nowLayout !== layoutMode) {
      layoutMode = nowLayout
      renderChart()
    }
    syncDragControls()   // canvas drag-behaviour control is Edit-tab only
  }
  tabButtons.forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset['tab'])))
  tabNavButtons.forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset['tabNav'])))

  // Clears the armed instrument selection (highlight + status + selectedLabel).
  // Called from setChairTool whenever the active chair tool changes.
  function clearLabelSelection() {
    selectedLabel = null
    instrumentPickerList.querySelectorAll('.active').forEach(el => el.classList.remove('active'))
    instrumentPickerStatus.textContent = 'Pick an instrument or part below, then click any chair to stamp it.'
  }

  // Single source of truth for "what does clicking a chair do". The four
  // Edit Chairs tool buttons set toggle/stand/stool/color; picking an
  // instrument in the Labels panel sets 'label' (no matching tool button, so
  // they all de-highlight). Keeps the tool buttons, sub-panels and label
  // selection in sync.
  function setChairTool(tool: ChairTool) {
    activeTool = tool
    lastCycledChair = null   // a new chair always starts from the armed mode
    toolButtons.forEach(b => b.classList.toggle('active', b.dataset['tool'] === tool))
    colorPickerLabel.style.display = tool === 'color' ? '' : 'none'
    colorBulkPanel.style.display = tool === 'color' ? '' : 'none'
    standBulkPanel.style.display = tool === 'stand' ? '' : 'none'
    stoolBulkPanel.style.display = tool === 'stool' ? '' : 'none'
    labelPanel.style.display = tool === 'label' ? '' : 'none'
    syncDragControls()
    // Rebuild the paste list on entry so it reflects any chairs hidden/shown
    // since it was last drawn (the toggle tool only re-renders the canvas).
    if (tool === 'label') renderLabelList()
    instrumentPanel.style.display = tool === 'instrument' ? '' : 'none'
    editChairsHint.textContent = TOOL_HINTS[tool]
    // Always clear the instrument selection: switching to a non-label tool
    // leaves label mode, and switching INTO the Label tool means free-type
    // (the picker re-sets selectedLabel itself, after this call).
    clearLabelSelection()
    closeChairLabelEditor()
  }

  // Tool selection
  toolButtons.forEach(btn => {
    btn.addEventListener('click', () => setChairTool(btn.dataset['tool'] as ChairTool))
  })

  // Inline chair-label editor key handling.
  chairLabelInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commitChairLabel(); advanceChairLabel() }
    else if (e.key === 'Escape') { e.preventDefault(); closeChairLabelEditor() }
    e.stopPropagation()   // keep global shortcuts out while typing
  })
  chairLabelInput.addEventListener('blur', () => { commitChairLabel(); closeChairLabelEditor() })

  // Instrument-label picker lives in the Labels panel and is always visible.
  renderInstrumentPicker()

  // Stand bulk actions (apply to every chair in every row)
  // Stand sub-panel is a mode selector: the armed mode (Solo / In desks /
  // Remove) is what both a single chair click and a marquee drag apply.
  const STAND_MODE_MAP: Record<string, StandMode> = { 'per-chair': 'solo', 'per-desk': 'desk', 'remove': 'remove' }
  standBulkButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      standMode = STAND_MODE_MAP[btn.dataset['standBulk'] ?? 'per-chair'] ?? 'solo'
      standBulkButtons.forEach(b => b.classList.toggle('active', b === btn))
    })
  })

  // Stool sub-panel is a mode selector (Chair / Stool / Standing).
  const STOOL_MODE_MAP: Record<string, StoolMode> = { 'chairs': 'chair', 'stools': 'stool', 'standing': 'standing' }
  stoolBulkButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      stoolMode = STOOL_MODE_MAP[btn.dataset['stoolBulk'] ?? 'chairs'] ?? 'chair'
      stoolBulkButtons.forEach(b => b.classList.toggle('active', b === btn))
    })
  })

  // "Overwrite labels" drag toggle (floats over the canvas for Label/Instruments).
  dragOverwriteBtn.addEventListener('click', () => {
    overwriteLabels = !overwriteLabels
    dragOverwriteBtn.classList.toggle('active', overwriteLabels)
  })

  // Reset every chair's colour back to the default (Colour tool bulk action).
  resetColorsBtn.addEventListener('click', () => {
    history.push(config)
    config.rows.forEach(row => row.chairs.forEach(c => { c.color = DEFAULT_CHAIR_COLOR }))
    renderChart()
  })

  clearLabelsBtn.addEventListener('click', () => {
    const labelled = config.rows.reduce(
      (n, row) => n + row.chairs.filter(c => c.label).length, 0)
    if (labelled === 0) return
    if (!confirm(`Clear ${labelled} chair label${labelled !== 1 ? 's' : ''}? This can be undone.`)) return
    history.push(config)
    config.rows.forEach(row => row.chairs.forEach(c => { c.label = '' }))
    renderLabelList()
    renderChart()
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
            // The picker only shows under the Instruments tool, so picking just
            // arms the chosen label for the next chair clicks.
            selectedLabel = label
            instrumentPickerList.querySelectorAll('.active').forEach(el => el.classList.remove('active'))
            b.classList.add('active')
            instrumentPickerStatus.textContent = `Selected: "${label}". Click any chair to stamp it.`
          })
          return b
        }
        // Button text shows the full instrument name; the stamped label is the
        // abbreviated form so it fits the chair boxes (matching the presets).
        const short = abbrevInstrument(name)
        row.appendChild(makeBtn(name, short, true))
        for (const n of [1, 2, 3]) {
          row.appendChild(makeBtn(String(n), `${short} ${n}`, false))
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

  // Zoom controls (view-only; see view-state note near the top)
  const ZOOM_STEP = 1.25
  zoomInBtn.addEventListener('click', () => setZoom(viewZoom * ZOOM_STEP))
  zoomOutBtn.addEventListener('click', () => setZoom(viewZoom / ZOOM_STEP))
  zoomResetBtn.addEventListener('click', resetZoom)
  // Wheel over the canvas zooms toward the cursor. Trackpad pinch arrives as
  // wheel + ctrlKey, which we also treat as zoom.
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault()
    const factor = Math.exp(-e.deltaY * 0.0015)
    setZoom(viewZoom * factor, e.clientX, e.clientY)
  }, { passive: false })
  applyViewTransform()
  resetPositionBtn.addEventListener('click', () => {
    if (config.conductor.offsetX === 0 && config.conductor.offsetY === 0) return
    history.push(config)
    config.conductor.offsetX = 0
    config.conductor.offsetY = 0
    renderChart()
  })

  // Reset every per-row / per-chair Layout-tab tweak back to the defaults.
  resetLayoutBtn.addEventListener('click', () => {
    if (!window.confirm('Reset all manual row and chair position tweaks back to the default layout?')) return
    history.push(config)
    for (const row of config.rows) {
      delete row.gapBefore
      delete row.arcStart
      delete row.arcEnd
      delete row.straightSpacing
      delete row.straightOffset
      for (const chair of row.chairs) delete chair.offset
    }
    delete config.titleOffsetX
    delete config.titleOffsetY
    renderChart()
  })

  // Per-row inspector (Layout tab): edit distance / spread numerically.
  layoutRowList.addEventListener('change', (e) => {
    const input = (e.target as HTMLElement).closest('input') as HTMLInputElement | null
    if (!input) return
    const i = Number(input.dataset['row'])
    const g = renderer.layoutRows[i]
    const row = config.rows[i]
    if (!g || !row) return
    history.push(config)
    if (input.classList.contains('lay-dist')) {
      const minR = i === 0 ? 60 : g.prevR + 44
      const newR = Math.max(minR, Number(input.value) || g.r)
      row.gapBefore = newR - g.base
    } else if (g.isStraight) {
      row.straightSpacing = Math.max(LAYOUT_MIN_SPACING, Number(input.value) || g.spacing)
    } else {
      const N = row.chairs.length
      const minSpan = Math.min(Math.PI * 0.98, ((N - 1) * LAYOUT_MIN_SPACING) / g.r)
      const span = Math.max(minSpan, Math.min(Math.PI * 1.95, ((Number(input.value) || 180) * Math.PI) / 180))
      const center = (g.arcStart + g.arcEnd) / 2
      row.arcStart = center + span / 2
      row.arcEnd = center - span / 2
    }
    renderChart()
  })
  layoutRowList.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.lay-reset') as HTMLElement | null
    if (!btn) return
    const row = config.rows[Number(btn.dataset['row'])]
    if (!row) return
    history.push(config)
    delete row.gapBefore; delete row.arcStart; delete row.arcEnd
    delete row.straightSpacing; delete row.straightOffset
    for (const chair of row.chairs) delete chair.offset
    renderChart()
  })
  document.addEventListener('keydown', (e) => {
    // While typing a chair label inline, let its own handler deal with keys
    // (Enter/Escape) and keep global shortcuts (undo, delete…) out of the way.
    if (document.activeElement === chairLabelInput) return
    // Close any open modal / drawer on Escape
    if (e.key === 'Escape') {
      if (customOrchestraModal.style.display !== 'none') {
        customOrchestraModal.style.display = 'none'
        return
      }
      if (aboutModal.style.display !== 'none') {
        aboutModal.style.display = 'none'
        return
      }
      if (isLibraryOpen()) {
        closeLibrary()
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

  // Warn before leaving with unsaved edits (relative to the last Save/Load).
  // Flush the autosave synchronously first so the work is recoverable whatever
  // the user chooses. Browsers show their own generic message, not returnValue.
  window.addEventListener('beforeunload', (e) => {
    persistWorkingChart()
    if (JSON.stringify(config) === savedSnapshot) return
    e.preventDefault()
    e.returnValue = ''
  })

  // Save / load
  saveBtn.addEventListener('click', () => { saveToJson(config); markSaved() })
  loadInput.addEventListener('change', async () => {
    const file = loadInput.files?.[0]
    if (!file) return
    try {
      setConfig(await loadFromJson(file))
      // Loaded from disk → no library entry yet. Next Save creates one.
      currentChartId = null
      markSaved()        // matches the file just loaded = clean
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

  // PNG export renders to an off-screen canvas shaped like A4 landscape (the
  // intended print target) so the chart auto-fills the page rather than the
  // screen-shaped on-screen canvas. Selection handles are suppressed.
  exportPngBtn.addEventListener('click', () => {
    const ex = document.createElement('canvas')
    ex.width = EXPORT_W
    ex.height = EXPORT_H
    const savedSel = renderer.selectedInstrumentId
    renderer.selectedInstrumentId = null
    renderer.hoverRowIndex = null
    renderer.hoverChair = null
    try {
      renderer.render(ex, config, { dpr: 1, showGhosts: false })
      exportToPng(ex, config.title)
    } finally {
      renderer.selectedInstrumentId = savedSel
      renderChart()   // restore the on-screen canvas + renderer state
    }
  })

  // Print → triggers the browser print dialog. The @media print CSS in
  // style.css hides every UI control, leaving only the canvas centred on
  // the page. Users can then pick "Save as PDF" from the print dialog to
  // get a PDF for free with no extra dependencies. beforeprint re-renders the
  // canvas at A4-landscape proportions so the chart fills the page (no
  // letterboxing from the screen's aspect ratio); afterprint restores it.
  window.addEventListener('beforeprint', () => {
    const savedSel = renderer.selectedInstrumentId
    renderer.selectedInstrumentId = null
    renderer.hoverRowIndex = null
    renderer.hoverChair = null
    canvas.width = EXPORT_W
    canvas.height = EXPORT_H
    renderer.render(canvas, config, { dpr: 1, showGhosts: false })
    renderer.selectedInstrumentId = savedSel
  })
  window.addEventListener('afterprint', () => renderChart())
  printBtn.addEventListener('click', () => window.print())

  // --- Library drawer ---
  libraryOpenBtn.addEventListener('click', openLibrary)
  libraryCloseBtn.addEventListener('click', closeLibrary)
  libraryBackdrop.addEventListener('click', closeLibrary)

  librarySaveBtn.addEventListener('click', async () => {
    // If we have a current chart loaded, update it in place. Otherwise
    // create a new entry — title defaults to config.title but the user
    // gets a quick prompt so they can adjust.
    let title = config.title || 'Untitled'
    let folder = ''
    try {
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
      markSaved()        // persisted to the library = clean
      updateLibraryCurrentTitle()
      await renderLibrary()
    } catch {
      alert(LIBRARY_ERROR)
    }
  })

  libraryNewChartBtn.addEventListener('click', () => {
    if (currentChartId && !window.confirm('Discard current chart and start a new blank one? Anything unsaved here will be lost — use Save first if you want to keep it.')) return
    setConfig(makeDefaultConfig())
    currentChartId = null
    markSaved()        // a brand-new blank chart has nothing unsaved yet
    updateLibraryCurrentTitle()
    closeLibrary()
  })

  libraryNewFolderBtn.addEventListener('click', async () => {
    const name = window.prompt('Folder name:')
    if (name === null || !name.trim()) return
    try {
      await library.createFolder(name.trim())
      await renderLibrary()
    } catch {
      alert(LIBRARY_ERROR)
    }
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
    handleLibraryAction(action, id, folder).catch(() => alert(LIBRARY_ERROR))
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

  // Clear preset → reset the seating to plain default rows (no colours, labels,
  // stools/standing or fixed instruments). Title, notes, background and
  // conductor placement are left alone.
  clearPresetBtn.addEventListener('click', () => {
    history.push(config)
    const def = makeDefaultConfig()
    config.rows = def.rows
    config.instruments = []
    config.layout = 'semicircle'
    config.straightRows = 0
    config.arcRange = def.arcRange
    config.rowSpacing = def.rowSpacing
    config.flipped = false
    setSelectedInstrument(null)
    presetSelect.value = ''
    updateAllInputs()
    renderChart()
  })

  // --- About modal ---
  aboutBtn.addEventListener('click', () => { aboutModal.style.display = 'flex' })
  aboutCloseBtn.addEventListener('click', () => { aboutModal.style.display = 'none' })
  aboutModal.addEventListener('click', (e) => {
    if (e.target === aboutModal) aboutModal.style.display = 'none'
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
