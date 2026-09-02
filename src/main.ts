import './style.css'
import { makeDefaultConfig, makeRow, makeInstrument, History, cloneConfig, DEFAULT_CHAIR_COLOR } from './state'
import { Renderer, type HoverPreview } from './renderer'
import {
  PRESETS, buildPreset, parseOrchestraNotation, describeComposition,
  type Preset,
} from './presets'
import { saveToJson, loadFromJson, encodeToHash, decodeFromHash, exportToPng } from './serializer'
import * as library from './library'
import { showAlert, showConfirm, showPrompt } from './dialog'
import { showContextMenu, closeContextMenu, contextMenuOpen, type MenuItem } from './context-menu'
import type { ChartConfig, InstrumentType, Chair } from './types'
import { RISER_PAD_MAX } from './section-layout'

// --- App state ---
let config: ChartConfig = makeDefaultConfig()
const history = new History()
const renderer = new Renderer()

// Off-screen render size for PNG export / print — A4 landscape proportions
// (297×210 ≈ 1.414:1) at a print-friendly resolution, so exports fill the page.
const EXPORT_W = 2100
const EXPORT_H = Math.round(EXPORT_W / Math.SQRT2)   // 1485 — A4's √2 aspect ratio

let activeColor = '#a8d8ea'
type ChairTool = 'color' | 'toggle' | 'stand' | 'stool' | 'label'
// The armed Edit Chairs tool, or null = no tool armed ("select mode"), the
// default: clicking a chair opens its context menu instead of mutating it.
// A tool arms via its Edit-tab button and disarms via a second click on the
// same button, the canvas pill's ✕, or Escape. While a tool is armed the
// #tool-pill over the canvas names it (see updateToolPill), so what the next
// click will do is always visible.
let activeTool: ChairTool | null = null

// One-line explanation per chair tool, shown under the Edit Chairs buttons for
// whichever tool is active (set in setChairTool).
const TOOL_HINTS: Record<ChairTool, string> = {
  toggle: "Click a chair to remove it while holding its space — the other chairs stay put, leaving a clean gap (e.g. an empty desk or a short row). Click the gap again to bring it back.",
  stand: 'Pick a stand type below, then click a chair (or drag a box over several) to apply it.',
  stool: 'Pick a seat type below, then click a chair (or drag a box over several) to apply it.',
  color: 'Click a chair to paint it the swatch colour. Click the swatch to change the colour.',
  label: 'Pick an instrument below to stamp it — or click a chair with nothing selected to type your own (Enter jumps to the next chair). Paste a list below.',
}
// Shown when no tool is armed. Must match the default text in index.html.
const NEUTRAL_HINT = 'No tool picked — click a chair to open its menu, or drag a box over several to act on them all at once (including moving them to another row). Or pick a tool above to apply one change to lots of chairs quickly (click it again to put it down).'

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
// Zoom per pixel of (normalised) wheel delta, as exp(-delta * this). At 0.003
// a typical 100px mouse notch is ~1.35x and a trackpad pinch feels responsive
// across the short 1–6 range; the previous 0.0015 made both a long grind.
const ZOOM_WHEEL_SENSITIVITY = 0.003
let panState: { startX: number; startY: number; panX0: number; panY0: number; moved: boolean } | null = null
let suppressClickAfterPan = false
// Touch long-press → the chair/stand context menu (touch has no right-click).
let longPressTimer: number | null = null
let longPressStart: { x: number; y: number } | null = null
function cancelLongPress() {
  if (longPressTimer !== null) { clearTimeout(longPressTimer); longPressTimer = null }
  longPressStart = null
}

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

// --- Section-label matching (used by "Tidy sections" to clump low strings) ---
// Normalise a chair label to a bare section token: lower-case, strip spaces,
// dots, dashes and any trailing part number ("Vc 2" / "cello-1" → "vc"/"cello").
function normalizeSectionLabel(label: string): string {
  return label.trim().toLowerCase().replace(/[\s._-]/g, '').replace(/\d+$/, '')
}
const VIOLIN_LABELS = new Set(['vln', 'vn', 'violin', 'violins', 'violini', 'violinii', 'vni', 'vnii'])
const VIOLA_LABELS = new Set(['vla', 'va', 'viola', 'violas'])
const CELLO_LABELS = new Set(['vc', 'vlc', 'vcl', 'cello', 'celli', 'violoncello', 'violoncelli'])
const BASS_LABELS = new Set(['cb', 'db', 'kb', 'bass', 'basses', 'contrabass', 'contrabasses', 'doublebass', 'doublebasses', 'kontrabass', 'stringbass'])
// A bowed-string section? The fanned-wedge layout is an orchestral string
// arrangement, so Tidy only wedges these and gates on violins being present.
function isViolinSection(label: string): boolean {
  return VIOLIN_LABELS.has(normalizeSectionLabel(label))
}
function isStringSection(label: string): boolean {
  const n = normalizeSectionLabel(label)
  return VIOLIN_LABELS.has(n) || VIOLA_LABELS.has(n) || CELLO_LABELS.has(n) || BASS_LABELS.has(n)
}
// The `group` key of the first chair whose label matches one of `labels`, or
// null if none — used to find the group other sections should merge into.
function findSectionGroup(
  targetRows: { row: import('./types').Row }[],
  labels: Set<string>,
): string | null {
  for (const { row } of targetRows) {
    const hit = row.chairs.find(c => c.group && labels.has(normalizeSectionLabel(c.label)))
    if (hit?.group) return hit.group
  }
  return null
}
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

// Active drag of a riser platform's resize handle (Layout tab). `baseline` is
// the handle's pad=0 reference geometry (renderer.riserHandleBaseline),
// captured at grab time. pad0 is the row's riserPad when the drag started;
// the new pad is pad0 plus however much further the pointer is from the
// baseline centre than it was at grab time — a *relative* delta (matching
// the 'distance' handle) rather than an absolute distance, so an imprecise
// initial click doesn't jump the platform size before any drag happens.
let riserSizeDrag: {
  rowIndex: number
  baseline: { center: { x: number; y: number }; baseDist: number }
  pad0: number
  start: { x: number; y: number }
  preDragConfig: ChartConfig
  moved: boolean
} | null = null

// True while handling a change from a Layout-tab per-row Dist/Arc input: the
// ensuing renderChart should refresh those boxes IN PLACE (syncLayoutRowValues)
// rather than rebuilding their DOM, which would yank the <input> the user is
// still stepping (breaks Safari's number-stepper after one click).
let layoutInputEditing = false

// Active Layout-tab title drag. The title is drawn in raw canvas px (not the
// chartScale frame), so this works in screen px and stores config.titleOffset.
let titleDrag: {
  startX: number; startY: number; x0: number; y0: number
  preDragConfig: ChartConfig; moved: boolean
} | null = null

// Active drag of a chart-wide default arc handle. Plain drag sets the arc's
// WIDTH (config.arcRange); Shift/Cmd rotates the whole default arc
// (config.arcCenter) — the chart-wide analogue of Shift-dragging one row's
// end. `startAngle`/`center0` are captured at grab time so the rotate is a
// relative delta rather than snapping the centre onto the pointer.
let arcRangeDrag: {
  startX: number; startY: number
  startAngle: number; center0: number
  preDragConfig: ChartConfig; moved: boolean
} | null = null

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
  'Soprano Sax': 'Sop S', 'Alto Sax': 'Alto S', 'Tenor Sax': 'Tenor S', 'Bari Sax': 'Bari S',
  'Bass Sax': 'Bass S',
  // Brass
  Horn: 'Hn', Trumpet: 'Tpt', Cornet: 'Crt', Flugelhorn: 'Flug',
  Trombone: 'Tbn', 'Bass Trombone': 'B Tbn', Baritone: 'Bar', Euphonium: 'Euph',
  // Strings
  // 'Vln', not 'Vn', so the picker stamps exactly what the orchestra generator
  // writes (STR_NAMES in presets.ts) — otherwise a chart mixes both spellings
  // and the tally lists the generated violins under "Other".
  Violin: 'Vln', Viola: 'Va', Cello: 'Vc', 'Double Bass': 'Cb',
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

// Abbreviations this app used to stamp. Only the tally reads these, so an
// existing chart labelled the old way still lands in the right section rather
// than dropping into "Other" after the spelling changed.
const LEGACY_ABBREV: Record<string, string> = {
  Violin: 'Vn',
}

// Currently selected fixed instrument (for drag/inspector/delete)
let selectedInstrumentId: string | null = null

// Last arrow-key nudge of a selected instrument: one history push per burst
// of keypresses (same instrument, <1s apart), not one per press.
let lastArrowNudge: { id: string; time: number } | null = null

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
  // Set when Alt/Option-dragging duplicated the instrument: this drag moves
  // the COPY, and holds the id of the original. If the pointer never actually
  // moves, the copy sits exactly on top of the original and is useless, so
  // pointerup deletes it again (see the pointerup handler).
  duplicatedFrom?: string
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
  chartScaleInput, stageTemplateSelect, bgInput, bgClearBtn, bgStatus, bgFitSelect, showCreditCheck,
  flipCheck, straightRowsInput, straightRowsLabel, arcRangeInput, arcRangeLabel,
  rowSpacingInput, riserStepHeightInput, rowCountInput, aboutBtn, aboutModal, aboutCloseBtn,
  rowsContainer,
  colorPicker, colorPickerLabel, colorBulkPanel, resetColorsBtn,
  undoBtn, redoBtn, zoomInBtn, zoomOutBtn, zoomResetBtn,
  resetPositionBtn, resetLayoutBtn, tidySectionsBtn, layoutRowList, addRowBtn, removeLastRowBtn, saveBtn,
  loadInput, exportPngBtn, printBtn, shareLinkBtn, shareUrlDisplay, presetSelect, applyPresetBtn, clearPresetBtn,
  libraryDrawer, libraryBackdrop, libraryOpenBtn, libraryCloseBtn,
  libraryCurrentTitle, librarySaveBtn, libraryNewChartBtn, libraryNewFolderBtn,
  librarySearch, libraryList,
  customOrchestraBtn, customOrchestraModal, customOrchestraTitle, customOrchestraNotation,
  customOrchestraPreview, customOrchestraApply, customOrchestraCancel,
  coModeSimpleBtn, coModeAdvancedBtn, coSimplePanel, coAdvancedPanel,
  coFl, coOb, coCl, coBsn, coHn, coTpt, coTbn, coTuba,
  coVn1, coVn2, coVa, coVc, coCb, coTimp, coHarp, coPiano,
  toolButtons, chairLabelInput, editChairsHint, labelPanel, clearLabelsBtn, instrumentPanel,
  marqueeBox, dragOverwriteBtn, handleTip, toolPill, toolPillText, toolPillClose,
  standBulkPanel, stoolBulkPanel, standBulkButtons, stoolBulkButtons,
  instrumentPickerList, labelList, instrumentPickerStatus,
  showTallyBtn, tallyOverlay, tallyBody, tallyTotal, tallyMinimizeBtn, tallyCloseBtn,
  addInstrumentButtons, inspector, inspectorType, inspectorLabel,
  inspectorCountLabel, inspectorCount, inspectorRotateLeft, inspectorRotateRight,
  inspectorDelete, inspectorMicOptions, inspectorMicStand, inspectorMicWireless,
  inspectorTimpaniOptions, inspectorTimpaniStool,
  setupIntroHint, dismissIntroHintBtn,
} from './dom'

// --- Init ---

async function init() {
  if (location.hash) {
    // An explicit shared-chart link wins over anything else. (Async because
    // the current hash format inflates via DecompressionStream.)
    const loaded = await decodeFromHash(location.hash)
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
  localiseShortcutKeys()
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
// The About panel's shortcut table is written with Mac key names; swap them
// for the Windows/Linux equivalents in place so the reference matches the
// keyboard in front of the user. (The handlers accept both either way.)
function localiseShortcutKeys() {
  if (modKeyLabel() === 'Cmd') return
  for (const el of document.querySelectorAll('.shortcut-table kbd')) {
    if (el.textContent === 'Cmd') el.textContent = 'Ctrl'
    else if (el.textContent === 'Alt') el.textContent = 'Alt'   // same on Windows
  }
}

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
  renderer.hoverPreview = currentHoverPreview()
  // Selection + drop slots are an Edit-tab, no-tool-armed affordance only.
  const selectable = activeTab === 'edit' && !layoutMode && activeTool === null
  renderer.selectedChairs = new Set(
    selectable ? selectedChairs.map(r => `${r.rowIndex}:${r.chairIndex}`) : [])
  renderer.showDropPoints = selectable && selectedChairs.length > 0
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
    if (layoutDrag?.moved || arcRangeDrag?.moved || layoutInputEditing) syncLayoutRowValues()
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
    r.straightSpacing !== undefined || r.straightOffset !== undefined || r.riser !== undefined ||
    r.riserPad !== undefined || r.chairs.some(c => c.offset !== undefined)
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
    const label = config.showRowLabels ? `Row ${escapeHtml(row.label)}` : `Row ${i + 1}`
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
    // …and any spelling an older version stamped, so charts saved before the
    // abbreviation was aligned with the presets still classify correctly.
    const legacy = LEGACY_ABBREV[item]
    if (legacy) matchers.push({ name: legacy, section: g.name, orderInSection: idx })
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
    const next = await showPrompt('Rename chart:', chart.title, { title: 'Rename chart', okLabel: 'Rename' })
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
    const choice = await showPrompt(
      'Pick an existing folder or type a new name. Leave blank to unfile.',
      '',
      { title: 'Move chart', placeholder: 'Folder name (blank = unfiled)', okLabel: 'Move', suggestions: folders },
    )
    if (choice === null) return
    const target = choice.trim().toLowerCase() === '(unfiled)' ? '' : choice.trim()
    if (target && !folders.includes(target)) await library.createFolder(target)
    await library.moveChart(id, target)
    await renderLibrary()
    return
  }
  if (action === 'delete' && id) {
    const chart = await library.loadChart(id)
    if (!chart) return
    if (!await showConfirm(`Delete "${chart.title}"? This cannot be undone.`, { title: 'Delete chart', confirmLabel: 'Delete', danger: true })) return
    await library.deleteChart(id)
    if (currentChartId === id) currentChartId = null
    updateLibraryCurrentTitle()
    await renderLibrary()
    return
  }
  if (action === 'delete-folder' && folder !== null) {
    if (!await showConfirm(`Delete folder "${folder}"? Any charts inside will become Unfiled.`, { title: 'Delete folder', confirmLabel: 'Delete', danger: true })) return
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
bindText(stageTemplateSelect,
  () => config.stageTemplate ?? '',
  v => { config.stageTemplate = (v === 'flat-hall' || v === 'concert-shell' || v === 'apron') ? v : undefined })
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
      config.rows.push(makeRow(8, nextRowLabel()))
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
bindNumber(riserStepHeightInput,
  () => config.riserStepHeight ?? 20,
  v => { config.riserStepHeight = Math.max(0, Math.min(100, Number.isFinite(v) ? v : 20)) })

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

    const riserLevel = row.riser ?? 0
    const riserOptions = [1, 2, 3, 4, 5, 6].map(n =>
      `<option value="${n}"${riserLevel === n ? ' selected' : ''}>${n}</option>`).join('')

    const div = document.createElement('div')
    div.className = 'row-item'
    div.dataset['rowIndex'] = String(i)
    div.innerHTML = `
      <div class="row-item-header">
        <span class="row-item-name" data-row="${i}" title="Click to rename">Row ${escapeHtml(row.label)}</span>
        <input type="text" maxlength="6" value="${escapeHtml(row.label)}" data-row="${i}" class="row-label-input">
        <label>Chairs
          <input type="number" min="1" max="30" value="${row.chairs.length}" data-row="${i}" class="chair-count">
        </label>
        <button data-row="${i}" class="remove-row-btn" title="Remove row">✕</button>
      </div>
      <div class="row-item-meta">
        <label class="row-straight-toggle"><input type="checkbox" data-row="${i}" class="row-straight-check" ${isStraight ? 'checked' : ''}> Straight row</label>
        <label class="row-riser-toggle" title="Put this row on a riser platform">Riser
          <select class="row-riser" data-row="${i}">
            <option value="0"${riserLevel === 0 ? ' selected' : ''}>—</option>
            ${riserOptions}
          </select>
        </label>
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

// The armed-tool hover preview for the current mode, or null. Only tools with
// one deterministic click outcome preview: Hide (chair dims), Colour (armed
// swatch washes on), Label with an armed instrument (label ghosts in).
// Free-type Label opens an editor and stand/stool cycle, so they don't.
function currentHoverPreview(): HoverPreview | null {
  if (layoutMode || activeTab !== 'edit') return null
  if (activeTool === 'toggle') return { kind: 'hide' }
  if (activeTool === 'color') return { kind: 'color', color: activeColor }
  if (activeTool === 'label' && selectedLabel !== null) return { kind: 'label', text: selectedLabel }
  return null
}

function rerenderCanvasOnly() {
  renderer.hoverPreview = currentHoverPreview()
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
// Escape mid-gesture aborts it: the config snaps back to the pre-drag
// snapshot every drag already captures, so you don't have to finish a wrong
// drag and then undo it. Returns true if something was actually cancelled.
function cancelActiveDrag(): boolean {
  const active = dragState ?? rotateState ?? conductorDragState ?? layoutDrag
    ?? riserSizeDrag ?? chairDrag ?? deskDrag ?? titleDrag ?? arcRangeDrag
  if (!active && !marqueeState && !panState) return false
  // Only a drag that got past its threshold has mutated anything (and pushed
  // history); restoring rolls back both the edit and that history entry.
  if (active?.moved) {
    history.undo(config)
    setConfig(active.preDragConfig)
  }
  dragState = null
  rotateState = null
  conductorDragState = null
  layoutDrag = null
  riserSizeDrag = null
  chairDrag = null
  deskDrag = null
  titleDrag = null
  arcRangeDrag = null
  panState = null
  marqueeState = null
  marqueeBox.style.display = 'none'
  canvas.classList.remove('panning')
  suppressClickAfterPan = true   // don't let the release fire a chair tool
  renderChart()
  return true
}

function anyDragActive(): boolean {
  return !!(titleDrag || arcRangeDrag || layoutDrag || riserSizeDrag || deskDrag || chairDrag
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
      <span class="label-row-name">Row ${escapeHtml(row.label)}</span>
      <textarea class="chair-labels-ta" data-row="${i}" rows="${taRows}">${escapeHtml(labelsText)}</textarea>
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
  'bass-drum': 'Bass Drum',
  'trap-table': 'Traps Table',
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
  // Snap anything within a hair of fit back to exactly 1 so the `viewZoom === 1`
  // marquee check (and the fit == no-pan state) stays reliable despite float
  // drift from repeated multiplicative zoom steps.
  const raw = Math.max(VIEW_ZOOM_MIN, Math.min(VIEW_ZOOM_MAX, target))
  const next = raw < VIEW_ZOOM_MIN + 1e-3 ? VIEW_ZOOM_MIN : raw
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
// Shift-rotate step for fixed instruments: 15° gives the useful 45°/90° stops.
const ROTATE_SNAP = Math.PI / 12

// Chairs picked out by a marquee drag while no tool is armed. They stay
// selected after the bulk menu closes, which is what turns every gap in every
// row into an orange drop slot — so a block of desks can be placed exactly
// rather than only appended. Cleared by Escape, a click on empty canvas, a
// successful drop, or a tab change.
let selectedChairs: { rowIndex: number; chairIndex: number }[] = []
// Set when an Escape keypress found a context menu open — see the Escape
// branch of the keydown handler for why this can't just call contextMenuOpen().
let escapeClosedMenu = false

function setSelectedChairs(next: { rowIndex: number; chairIndex: number }[]) {
  selectedChairs = next
  renderChart()
}

function clearSelectedChairs(): boolean {
  if (selectedChairs.length === 0) return false
  selectedChairs = []
  renderChart()
  return true
}

// True while the spacebar is held: a canvas drag then pans the zoomed view
// instead of editing, so you can reposition a magnified chart without hunting
// for empty background to grab (the Photoshop convention).
let spaceHeld = false

// Wrap an angle difference into (-π, π]. Arc ends sit near the atan2 ±π seam,
// where a raw subtraction can jump by 2π and send a drag flying.
const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))

// Which span-drag behaviour a modifier selects. Plain drag is the common case
// (widen/narrow about the centre); Shift slides the WHOLE row sideways — the
// thing testers reached for first and couldn't find; Cmd/Ctrl is the niche
// "drag just this end" (it used to be Shift, which wasted the obvious
// modifier on the rarest action).
type SpanMode = 'symmetric' | 'move-row' | 'one-end'
const spanModeFor = (e: MouseEvent): SpanMode =>
  e.shiftKey ? 'move-row' : (e.metaKey || e.ctrlKey) ? 'one-end' : 'symmetric'

// Applies the in-progress distance/span drag to the dragged row. Distance is
// a radial (arc) / vertical (straight) delta from grab point; span reshapes or
// slides the row depending on the modifier (see SpanMode).
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
    const mode = spanModeFor(e)
    if (mode === 'move-row') {
      // Slide the whole row sideways — spacing untouched, centre follows the
      // pointer. (Big-band rows in particular get nudged left/right as a block.)
      row.straightOffset = g.centerOffset + delta
    } else if (mode === 'one-end') {
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
    const mode = spanModeFor(e)
    let start = g.arcStart
    let end = g.arcEnd
    if (mode === 'move-row') {
      // Slide the whole row along its arc — both ends rotate by the same
      // angle, so the span is preserved and no clamping is needed. The arc
      // analogue of nudging a straight row sideways.
      row.arcStart = g.arcStart + dA
      row.arcEnd = g.arcEnd + dA
      renderChart()
      return
    }
    if (mode === 'one-end') {
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
    if (mode === 'one-end' && layoutDrag.kind === 'span-end') {
      end = Math.min(start - minSpan, Math.max(start - maxSpan, end))
    } else if (mode === 'one-end') {
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

// --- Layout-tab handle tooltip ---
//
// Hovering a drag handle explains that handle, including its modifier keys.
// Modifiers are otherwise invisible: a tester wanting to shift a whole big-band
// row never found the gesture, and the fix can't be "more sidebar text" (the
// Layout tab is already a legend). A tooltip costs nothing until you reach for
// the handle you're curious about.
function handleTipHtml(handle: import('./types').LayoutHandleHit): string {
  const mod = modKeyLabel()
  switch (handle.kind) {
    case 'distance':
      return 'Drag to move this row in / out · double-click resets'
    case 'span-start':
    case 'span-end': {
      const straight = renderer.layoutRows[handle.rowIndex]?.isStraight
      const widen = straight ? 'Drag to spread the chairs' : 'Drag to widen the arc'
      const slide = straight ? 'slide the whole row' : 'slide the row along its arc'
      return `${widen} · <b>Shift</b>-drag to ${slide} · <b>${mod}</b>-drag this end only`
    }
    case 'desk':
      return 'Drag to slide this desk pair · double-click resets'
    case 'arc-range-start':
    case 'arc-range-end':
      // Symmetric handles, so there's no "one end" case — Shift and Cmd both
      // rotate. Naming only Shift keeps the tip short; Cmd works too.
      return `Drag to set the default arc width · <b>Shift</b>-drag to rotate the whole arc `
        + '· moves every row you haven’t adjusted · double-click resets'
    case 'riser-size':
      return 'Drag to enlarge this riser platform · double-click resets'
    default:
      return ''
  }
}

function hideHandleTip() {
  handleTip.style.display = 'none'
}

function updateHandleTip(e: MouseEvent) {
  // Hover is a mouse concept, and the handles only exist in layout mode.
  if (!layoutMode || !hasFinePointer) { hideHandleTip(); return }
  const cv = pointerCanvasCoords(e)
  const { x, y } = canvasToChart(cv.x, cv.y)
  const handle = renderer.layoutHandleHitTest(x, y)
  const html = handle ? handleTipHtml(handle) : ''
  if (!html) { hideHandleTip(); return }
  if (handleTip.innerHTML !== html) handleTip.innerHTML = html
  handleTip.style.display = 'block'
  // Offset below-right of the cursor, flipped/clamped to stay in the canvas.
  const area = canvasArea.getBoundingClientRect()
  let left = e.clientX - area.left + 14
  let top = e.clientY - area.top + 18
  if (left + handleTip.offsetWidth > area.width - 4) left = Math.max(4, left - handleTip.offsetWidth - 28)
  if (top + handleTip.offsetHeight > area.height - 4) top = Math.max(4, top - handleTip.offsetHeight - 26)
  handleTip.style.left = `${left}px`
  handleTip.style.top = `${top}px`
}

// A screen-pixel move takes this many riser-pad px — under 1 so the handle
// feels deliberate rather than twitchy (dragging the whole 0..RISER_PAD_MAX
// range takes a comfortably long swipe, regardless of chart zoom level).
const RISER_DRAG_DAMPING = 0.45

// Applies the in-progress riser-platform resize drag: pad0 plus how much
// further the pointer has moved from the baseline centre since the drag
// started (a relative delta, like the 'distance' handle) — not the pointer's
// absolute distance, which would jump the platform size on grab if the click
// wasn't exactly on the baseline corner. The raw delta is in chart-space px,
// which pointerCanvasCoords derived by DIVIDING the real screen movement by
// viewScale — so on a zoomed-out (small viewScale) chart, the same physical
// drag produces a much bigger chart-space delta than on a zoomed-in one.
// Multiplying back by viewScale converts it to actual screen px moved before
// applying the damping factor, so the handle feels the same regardless of
// how big or zoomed-out the chart currently is.
function applyRiserSizeDrag(e: MouseEvent) {
  if (!riserSizeDrag) return
  const cv = pointerCanvasCoords(e)
  const { x, y } = canvasToChart(cv.x, cv.y)
  if (!riserSizeDrag.moved) {
    if (Math.hypot(x - riserSizeDrag.start.x, y - riserSizeDrag.start.y) < DRAG_THRESHOLD) return
    history.push(riserSizeDrag.preDragConfig)
    riserSizeDrag.moved = true
  }
  const { center, baseDist } = riserSizeDrag.baseline
  const dist = (px: number, py: number) => Math.hypot(px - center.x, py - center.y) - baseDist
  const rawDelta = dist(x, y) - dist(riserSizeDrag.start.x, riserSizeDrag.start.y)
  const screenDelta = rawDelta * (renderer.viewScale || 1)
  const pad = Math.max(0, Math.min(RISER_PAD_MAX, riserSizeDrag.pad0 + screenDelta * RISER_DRAG_DAMPING))
  const row = config.rows[riserSizeDrag.rowIndex]
  if (row) { if (pad < 0.5) delete row.riserPad; else row.riserPad = pad }
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
    void showAlert(built.error, { title: "Couldn't apply preset" })
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
  // Replacing the whole chart is a big, silent jump — remind that it's one
  // undo away (non-blocking; a confirm dialog here would punish the common
  // "just browsing presets" case).
  showToast(`${preset.name} applied — press ${modKeyLabel()}+Z to undo`)
}

// --- Transient toast (non-blocking, bottom-centre of the canvas) ---

const modKeyLabel = () =>
  /Mac|iPhone|iPad/.test(navigator.platform ?? '') ? 'Cmd' : 'Ctrl'

let toastEl: HTMLElement | null = null
let toastTimer: ReturnType<typeof setTimeout> | null = null

// Shows a short-lived, non-interactive notice over the canvas. Re-calling
// while one is visible replaces the text and restarts the clock. Built lazily
// so charts that never toast pay nothing.
function showToast(message: string) {
  if (!toastEl) {
    toastEl = document.createElement('div')
    toastEl.id = 'canvas-toast'
    canvasArea.appendChild(toastEl)
  }
  toastEl.textContent = message
  toastEl.classList.add('visible')
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toastEl?.classList.remove('visible'), 3200)
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

  // Space-drag pans the zoomed view, whatever is under the pointer. Only
  // meaningful while zoomed in — at fit there's nothing to pan to.
  if (spaceHeld && viewZoom > 1) {
    panState = { startX: e.clientX, startY: e.clientY, panX0: viewPanX, panY0: viewPanY, moved: false }
    canvas.classList.add('panning')
    return
  }

  // An orange drop slot wins over everything beneath it — slots sit on chair
  // edges, and clicking one is the whole point of having a selection.
  if (selectedChairs.length > 0) {
    const slot = renderer.dropPointHitTest(x, y)
    if (slot) {
      history.push(config)
      moveChairsToRow(selectedChairs, slot.rowIndex, slot.insertIndex)
      selectedChairs = []
      renderRowList()
      renderLabelList()
      renderChart()
      suppressClickAfterPan = true   // don't let the release re-open a menu
      return
    }
  }

  // Touch long-press opens the chair/stand context menu (no right-click on
  // touch). If it fires we swallow the tap that would otherwise apply a tool.
  if (e.pointerType === 'touch' && activeTab === 'edit') {
    longPressStart = { x: e.clientX, y: e.clientY }
    const chartX = x, chartY = y, clientX = e.clientX, clientY = e.clientY
    longPressTimer = window.setTimeout(() => {
      longPressTimer = null
      if (openChairContextMenu(clientX, clientY, chartX, chartY)) {
        suppressClickAfterPan = true
        marqueeState = null
        marqueeBox.style.display = 'none'
        dragState = null
      }
    }, 500)
  }

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
    // The instrument (and its ✕ handle) are gone now, so the trailing click
    // would fall through to the chair beneath and fire the active chair tool
    // on it. Swallow that click.
    suppressClickAfterPan = true
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
    // Snapshot BEFORE any duplication, so the drag's single history entry
    // rolls back the copy and its move together.
    const preDragConfig = cloneConfig(config)
    let dragId = instHit.id
    let duplicatedFrom: string | undefined
    // Alt/Option-drag copies the instrument and drags the copy — the standard
    // design-tool gesture, and much quicker than a palette trip per extra mic
    // or music stand.
    if (e.altKey) {
      const original = config.instruments.find(i => i.id === instHit.id)
      if (original) {
        const copy = { ...original, id: crypto.randomUUID() }
        config.instruments.push(copy)
        dragId = copy.id
        duplicatedFrom = original.id
      }
    }
    setSelectedInstrument(dragId)
    dragState = {
      instrumentId: dragId,
      offsetX: x - instHit.cx,
      offsetY: y - instHit.cy,
      preDragConfig,
      moved: false,
      duplicatedFrom,
      // Stand tool (in the chair-tool tabs, not Layout): a plain click toggles
      // the stand, but the instrument is still draggable to reposition it.
      // An Alt-drag is a copy gesture, never a stand toggle.
      toggleStandOnClick: !layoutMode && activeTool === 'stand' && !duplicatedFrom,
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
        const { ox, oy, yDir } = renderer.conductorOrigin
        arcRangeDrag = {
          startX: x, startY: y,
          startAngle: Math.atan2((y - oy) / yDir, (x - ox) / -yDir),
          center0: config.arcCenter ?? Math.PI / 2,
          preDragConfig: cloneConfig(config), moved: false,
        }
        return
      }
      if (handle.kind === 'riser-size') {
        const baseline = renderer.riserHandleBaseline(handle.rowIndex)
        if (baseline) {
          riserSizeDrag = {
            rowIndex: handle.rowIndex, baseline,
            pad0: config.rows[handle.rowIndex]?.riserPad ?? 0,
            start: { x, y }, preDragConfig: cloneConfig(config), moved: false,
          }
          return
        }
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
  // drags never marquee — a finger needs to pan/scroll, not draw a box). With
  // a tool armed the box applies that tool; with none armed it opens the bulk
  // chair menu instead. When zoomed in, keep the existing drag-to-pan
  // behaviour (no transform to fight at 100%, so the box maps 1:1).
  if (activeTab === 'edit' && viewZoom === 1 && e.pointerType !== 'touch') {
    marqueeState = { startClientX: e.clientX, startClientY: e.clientY, startChart: { x, y }, moved: false }
  } else if (viewZoom > 1) {
    panState = { startX: e.clientX, startY: e.clientY, panX0: viewPanX, panY0: viewPanY, moved: false }
  }
})

window.addEventListener('pointermove', (e) => {
  if (!e.isPrimary) return
  // Any real movement cancels a pending long-press (it's a drag, not a press).
  if (longPressTimer !== null && longPressStart) {
    if (Math.hypot(e.clientX - longPressStart.x, e.clientY - longPressStart.y) > 10) cancelLongPress()
  }
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
  // Default arc drag — width (plain) or rotation (Shift/Cmd). Either moves
  // every row that hasn't had its own arc edited.
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
    // The arc-range handles are symmetric, so there's no "one end only" case
    // to distinguish — Shift and Cmd both mean "rotate the whole arc".
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      config.arcCenter = arcRangeDrag.center0 + wrapAngle(a - arcRangeDrag.startAngle)
    } else {
      const center = config.arcCenter ?? Math.PI / 2
      const range = Math.max(Math.PI / 3, Math.min(Math.PI, 2 * Math.abs(wrapAngle(a - center))))
      config.arcRange = range
      arcRangeInput.value = String(Math.round((range * 180) / Math.PI))
    }
    renderChart()
    return
  }
  // Layout-tab handle drag (distance / span).
  if (layoutDrag) {
    applyLayoutDrag(e)
    return
  }
  // Layout-tab riser-platform resize drag.
  if (riserSizeDrag) {
    applyRiserSizeDrag(e)
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
    // Shift snaps to 15° steps — squaring a piano or drum kit to the stage by
    // eye never quite lands, and 15° also gives the useful 45°/90° stops.
    inst.rotation = e.shiftKey ? Math.round(newRotation / ROTATE_SNAP) * ROTATE_SNAP : newRotation
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
  cancelLongPress()   // a lift before 500ms is a tap, not a long-press
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
      // Tool armed → apply it to the box. No tool (select mode) → offer the
      // boxed chairs' actions in one menu, "Move to row" included.
      if (activeTool === null) {
        // Keep the box selected after the menu closes, so the orange drop
        // slots stay available for placing it precisely.
        const valid = refs.filter(r => config.rows[r.rowIndex]?.chairs[r.chairIndex])
        setSelectedChairs(valid)
        if (valid.length > 0) openBulkChairMenu(valid, e.clientX, e.clientY, centre)
      } else applyBulkTool(refs, centre)
      suppressClickAfterPan = true   // swallow the trailing click
    }
    marqueeState = null
    marqueeBox.style.display = 'none'
  }
  // Alt-drag that never moved: the copy is sitting exactly on top of the
  // original, so drop it and hand the selection back rather than leaving an
  // invisible stacked duplicate behind.
  if (dragState && !dragState.moved && dragState.duplicatedFrom) {
    const copyId = dragState.instrumentId
    config.instruments = config.instruments.filter(i => i.id !== copyId)
    setSelectedInstrument(dragState.duplicatedFrom)
    renderChart()
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
    || conductorDragState?.moved || arcRangeDrag?.moved || riserSizeDrag?.moved
  dragState = null
  rotateState = null
  conductorDragState = null
  panState = null
  layoutDrag = null
  riserSizeDrag = null
  chairDrag = null
  deskDrag = null
  titleDrag = null
  arcRangeDrag = null
  canvas.classList.remove('panning')
  // The per-row boxes are skipped mid-drag; refresh them now the drag is done.
  if (finishedLayoutDrag && layoutMode) updateLayoutRowList()
})

// --- Two-finger touch pinch zoom (tablets / phones) ---
// The canvas has touch-action: none, so the browser hands us raw touch
// pointers instead of gesturing itself. Two simultaneous touches zoom the
// view about their midpoint — the same maths as ctrl+wheel — and follow the
// midpoint as a two-finger pan while zoomed in. The moment the second finger
// lands, whatever single-finger gesture was in progress is abandoned.
const touchPoints = new Map<number, { x: number; y: number }>()
let pinchState: { startDist: number; zoom0: number; lastMid: { x: number; y: number } } | null = null

canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch') return
  touchPoints.set(e.pointerId, { x: e.clientX, y: e.clientY })
  if (touchPoints.size === 2) {
    const [a, b] = [...touchPoints.values()]
    pinchState = {
      startDist: Math.hypot(a.x - b.x, a.y - b.y),
      zoom0: viewZoom,
      lastMid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    }
    // This gesture is a pinch — abandon anything the first finger started.
    cancelLongPress()
    dragState = null; rotateState = null; conductorDragState = null
    panState = null; layoutDrag = null; riserSizeDrag = null
    chairDrag = null; deskDrag = null; titleDrag = null; arcRangeDrag = null
    marqueeState = null
    marqueeBox.style.display = 'none'
    suppressClickAfterPan = true
  }
})
window.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'touch' || !touchPoints.has(e.pointerId)) return
  touchPoints.set(e.pointerId, { x: e.clientX, y: e.clientY })
  if (!pinchState || touchPoints.size < 2) return
  const [a, b] = [...touchPoints.values()]
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  // Follow the midpoint (two-finger pan) — only while actually zoomed in, so
  // the "no pan at fit" invariant (viewZoom === 1 ⇒ pan 0,0) holds.
  if (viewZoom > 1) {
    viewPanX += mid.x - pinchState.lastMid.x
    viewPanY += mid.y - pinchState.lastMid.y
    applyViewTransform()
  }
  pinchState.lastMid = mid
  // …and scale about it.
  const dist = Math.hypot(a.x - b.x, a.y - b.y)
  if (pinchState.startDist > 0) {
    setZoom(pinchState.zoom0 * (dist / pinchState.startDist), mid.x, mid.y)
  }
})
const endTouchPoint = (e: PointerEvent) => {
  if (e.pointerType !== 'touch') return
  touchPoints.delete(e.pointerId)
  if (touchPoints.size < 2) pinchState = null
}
window.addEventListener('pointerup', endTouchPoint)
window.addEventListener('pointercancel', endTouchPoint)

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
    // Default arc handles → reset both width and rotation (a full 180°
    // centred on the apex), so one double-click undoes either gesture.
    if (handle.kind === 'arc-range-start' || handle.kind === 'arc-range-end') {
      if ((config.arcRange ?? Math.PI) !== Math.PI || config.arcCenter !== undefined) {
        history.push(config)
        config.arcRange = Math.PI
        delete config.arcCenter
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
    // Riser resize handle → snap the platform back to its automatic size.
    if (handle.kind === 'riser-size') {
      if (row.riserPad !== undefined) {
        history.push(config)
        delete row.riserPad
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

// Move chairs into another row, keeping their labels, colours, stands and seat
// types. The Edit tab's "Chairs" number box can only append blanks or truncate
// from the end, so this is the only way to reshape a section across rows —
// e.g. putting two violin desks side by side in the back row instead of one
// desk per row. Chairs are appended to the destination; in a tidied string
// chart the wedge layout re-clusters them with their section-mates by `group`,
// so they land in the right block without further fiddling.
//
// A desk (shared stand) survives the move when BOTH its chairs travel together
// — they stay adjacent in the destination. When only one half moves, the pair
// dissolves and each player keeps a stand of their own, which is the least
// surprising outcome. Returns how many chairs actually moved.
function moveChairsToRow(
  targets: { rowIndex: number; chairIndex: number }[],
  dest: number,
  insertIndex?: number,
): number {
  const destRow = config.rows[dest]
  if (!destRow) return 0

  const byRow = new Map<number, number[]>()
  for (const t of targets) {
    // Without an explicit slot, moving to the row you're already in is a no-op;
    // with one, it's a meaningful reorder, so those chairs stay in play.
    if (insertIndex === undefined && t.rowIndex === dest) continue
    const list = byRow.get(t.rowIndex) ?? []
    if (!list.includes(t.chairIndex)) list.push(t.chairIndex)
    byRow.set(t.rowIndex, list)
  }
  if (byRow.size === 0) return 0

  // The exact Chair objects on the move, so a desk whose partner is also
  // moving can keep its shared stand.
  const moving = new Set<Chair>()
  for (const [ri, idxs] of byRow) {
    for (const i of idxs) {
      const c = config.rows[ri]?.chairs[i]
      if (c) moving.add(c)
    }
  }

  detachLeavingDesks(byRow, moving)

  const moved: Chair[] = []
  // Removing chairs that sat before the target slot shifts it left by that many.
  let shift = 0
  for (const ri of [...byRow.keys()].sort((a, b) => a - b)) {
    const chairs = config.rows[ri].chairs
    const idxs = byRow.get(ri)!.sort((a, b) => a - b)
    if (ri === dest && insertIndex !== undefined) {
      shift = idxs.filter(i => i < insertIndex).length
    }
    // Ascending, so a desk pair stays adjacent (and in order) once appended.
    for (const i of idxs) moved.push(chairs[i])
    // Descending so earlier splices don't shift the later indices.
    for (const i of [...idxs].reverse()) chairs.splice(i, 1)
  }
  const at = insertIndex !== undefined
    ? Math.max(0, Math.min(destRow.chairs.length, insertIndex - shift))
    : sectionInsertIndex(destRow, moved[0])
  destRow.chairs.splice(at, 0, ...moved)
  return moved.length
}

// Detach the chairs listed in `byRow` from any desk they're half of, so the
// players left behind keep a stand of their own rather than being orphaned on
// a shared stand pointing at nothing. A desk whose BOTH halves are leaving is
// left intact — for a move they stay adjacent in the destination, and for a
// delete they both vanish anyway. Must run before any splicing, while the
// indices still line up.
function detachLeavingDesks(byRow: Map<number, number[]>, leaving: Set<Chair>) {
  for (const [ri, idxs] of byRow) {
    const chairs = config.rows[ri]?.chairs
    if (!chairs) continue
    for (const i of idxs) {
      const c = chairs[i], next = chairs[i + 1], prev = chairs[i - 1]
      if (!c) continue
      // c owned a shared stand: keep it only if the partner is leaving too.
      if (c.standAfter && (!next || !leaving.has(next))) {
        c.standAfter = false
        c.hasStand = true
        if (next) next.hasStand = true
      }
      // c was the far half of someone else's desk.
      if (prev?.standAfter && !leaving.has(prev)) {
        prev.standAfter = false
        prev.hasStand = true
        c.hasStand = true
      }
    }
  }
}

// Group chair refs by row, de-duplicated. Shared by the move and delete paths.
function chairRefsByRow(targets: { rowIndex: number; chairIndex: number }[]): Map<number, number[]> {
  const byRow = new Map<number, number[]>()
  for (const t of targets) {
    if (!config.rows[t.rowIndex]?.chairs[t.chairIndex]) continue
    const list = byRow.get(t.rowIndex) ?? []
    if (!list.includes(t.chairIndex)) list.push(t.chairIndex)
    byRow.set(t.rowIndex, list)
  }
  return byRow
}

// Remove chairs from the chart entirely — the row shrinks and the remaining
// chairs re-space. Distinct from Hide, which keeps the seat's place so the row
// doesn't shift. Returns how many were deleted.
function deleteChairs(targets: { rowIndex: number; chairIndex: number }[]): number {
  const byRow = chairRefsByRow(targets)
  if (byRow.size === 0) return 0
  const leaving = new Set<Chair>()
  for (const [ri, idxs] of byRow) {
    for (const i of idxs) leaving.add(config.rows[ri].chairs[i])
  }
  detachLeavingDesks(byRow, leaving)
  let removed = 0
  for (const [ri, idxs] of byRow) {
    const chairs = config.rows[ri].chairs
    for (const i of [...idxs].sort((a, b) => b - a)) {
      chairs.splice(i, 1)
      removed++
    }
  }
  return removed
}

// Where a moved block should land in the destination row when no explicit slot
// was picked: right after the last chair of the same section, so a violin desk
// joins the other violins instead of being stranded on the end of the row.
// Matches on `group` (set by Tidy sections) or the exact label — deliberately
// NOT normalizeSectionLabel, which strips the part number and would treat
// "Vln 1" and "Vln 2" as the same section. Falls back to appending.
function sectionInsertIndex(destRow: typeof config.rows[number], first: Chair | undefined): number {
  const key = (c: Chair) => (c.group?.trim() || c.label.trim()).toLowerCase()
  const want = first ? key(first) : ''
  if (!want) return destRow.chairs.length
  let last = -1
  destRow.chairs.forEach((c, i) => { if (key(c) === want) last = i })
  return last >= 0 ? last + 1 : destRow.chairs.length
}

// The label a newly appended row should take: continue A, B, C… while the
// chart is lettered (as every preset is), otherwise fall back to the numeric
// position. Keeps "Add row" and "move to a new row" naming the same way.
function nextRowLabel(): string {
  const labels = config.rows.map(r => r.label.trim())
  if (labels.length > 0 && labels.every(l => /^[A-Z]$/.test(l))) {
    const max = Math.max(...labels.map(l => l.charCodeAt(0)))
    if (max < 'Z'.charCodeAt(0)) return String.fromCharCode(max + 1)
  }
  return String(config.rows.length + 1)
}

// Append an empty row at the back and return its index — the destination for
// "move to a new row".
function appendEmptyRow(): number {
  config.rows.push(makeRow(0, nextRowLabel()))
  // straightRows counts from the BACK, so appending would silently flip the
  // front-most straight row into an arc row. Bump it so every existing row
  // keeps rendering exactly as it did, and the new back row continues the
  // pattern of the one it follows.
  if (config.straightRows > 0) config.straightRows++
  return config.rows.length - 1
}

// "Move to row" segment options. A selection sitting entirely in one row can't
// move to that row, so it's dropped; a selection spanning rows keeps every
// destination (gathering them all into one row is the point). The trailing
// "+ New" option makes a fresh row at the back and moves them there — the
// quickest way to split a crowded row, or to start the next row back from
// chairs you've already labelled.
function moveRowOptions(sourceRows: Set<number>, onMove: (dest: number | 'new') => void) {
  const options = config.rows
    .map((row, i) => ({ row, i }))
    .filter(({ i }) => !(sourceRows.size === 1 && sourceRows.has(i)))
    .map(({ row, i }) => ({ label: row.label || String(i + 1), onClick: () => onMove(i) }))
  options.push({ label: '+ New', onClick: () => onMove('new') })
  return options
}

// Resolve a "Move to row" destination, creating the row when asked for.
const resolveMoveDest = (dest: number | 'new') => dest === 'new' ? appendEmptyRow() : dest

// --- Right-click / long-press context menu on a chair or stand ---------------
const CHAIR_SWATCHES = ['#a8d8ea', '#b6e2a1', '#f6d365', '#f4a261', '#e5a1c4', '#cfcfcf', '#ffffff']

// Pop a native colour picker for one chair (the menu's "custom colour").
function openChairColorPicker(rowIndex: number, chairIndex: number) {
  const chair = config.rows[rowIndex]?.chairs[chairIndex]
  if (!chair) return
  const input = document.createElement('input')
  input.type = 'color'
  input.value = /^#[0-9a-fA-F]{6}$/.test(chair.color) ? chair.color : '#a8d8ea'
  input.style.cssText = 'position:fixed;left:-9999px;top:0'
  document.body.appendChild(input)
  input.addEventListener('change', () => {
    history.push(config)
    chair.color = input.value
    renderChart()
    input.remove()
  })
  input.addEventListener('blur', () => setTimeout(() => input.remove(), 0))
  input.click()
}

// Build + show the context menu for whatever is under (x,y) in chart coords.
// A stand × takes priority over its chair. Returns false if nothing was hit.
function openChairContextMenu(clientX: number, clientY: number, x: number, y: number): boolean {
  const mut = (fn: () => void) => { history.push(config); fn(); renderChart() }

  const standHit = renderer.standHitTest(x, y)
  if (standHit) {
    const rowChairs = config.rows[standHit.rowIndex].chairs
    const isDesk = chairStandMode(rowChairs, standHit.chairIndex) === 'desk'
    showContextMenu(clientX, clientY, 'Music stand', [
      isDesk
        ? { kind: 'action', label: 'Give its own stand', onClick: () => mut(() => applyStandToChair(rowChairs, standHit.chairIndex, 'solo')) }
        : { kind: 'action', label: 'Share between chairs', onClick: () => mut(() => applyStandToChair(rowChairs, standHit.chairIndex, 'desk')) },
      { kind: 'action', label: 'Remove stand', danger: true, onClick: () => mut(() => applyStandToChair(rowChairs, standHit.chairIndex, 'remove')) },
    ])
    return true
  }

  const hit = renderer.hitTest(x, y)
  if (hit) {
    const rowChairs = config.rows[hit.rowIndex].chairs
    const chair = rowChairs[hit.chairIndex]
    const seat = chairStoolMode(chair)
    const stand = chairStandMode(rowChairs, hit.chairIndex)
    const items: MenuItem[] = [
      { kind: 'action', label: chair.enabled ? 'Hide chair' : 'Show chair', onClick: () => mut(() => { chair.enabled = !chair.enabled }) },
      { kind: 'action', label: 'Edit label…', onClick: () => openChairLabelEditor(hit.rowIndex, hit.chairIndex) },
      { kind: 'segment', label: 'Seat', options: [
        { label: 'Chair',    active: seat === 'chair',    onClick: () => mut(() => applyStoolToChair(chair, 'chair')) },
        { label: 'Stool',    active: seat === 'stool',    onClick: () => mut(() => applyStoolToChair(chair, 'stool')) },
        { label: 'Standing', active: seat === 'standing', onClick: () => mut(() => applyStoolToChair(chair, 'standing')) },
      ] },
      // Lets you add a stand to a chair that has none — there's no × to right-
      // click in that case. Desk = shared between this chair and the next.
      { kind: 'segment', label: 'Stand', options: [
        { label: 'None', active: stand === 'remove', onClick: () => mut(() => applyStandToChair(rowChairs, hit.chairIndex, 'remove')) },
        { label: 'Solo', active: stand === 'solo',   onClick: () => mut(() => applyStandToChair(rowChairs, hit.chairIndex, 'solo')) },
        { label: 'Desk', active: stand === 'desk',   onClick: () => mut(() => applyStandToChair(rowChairs, hit.chairIndex, 'desk')) },
      ] },
      { kind: 'swatches', label: 'Colour', colors: CHAIR_SWATCHES, current: chair.color,
        onPick: (c) => mut(() => { chair.color = c }),
        onCustom: () => openChairColorPicker(hit.rowIndex, hit.chairIndex) },
    ]
    // Relocate this chair to another row (only worth offering with somewhere
    // to send it). A desk gets a second option that takes both players, so
    // reshaping a string section doesn't mean moving stands one at a time.
    const afterMove = () => { renderRowList(); renderLabelList() }
    if (config.rows.length > 1) {
      items.push({ kind: 'segment', label: 'Move to row', options: moveRowOptions(
        new Set([hit.rowIndex]),
        dest => mut(() => { moveChairsToRow([{ rowIndex: hit.rowIndex, chairIndex: hit.chairIndex }], resolveMoveDest(dest)); afterMove() }),
      ) })
      const partner = chair.standAfter ? hit.chairIndex + 1
        : rowChairs[hit.chairIndex - 1]?.standAfter ? hit.chairIndex - 1
        : null
      if (partner !== null && rowChairs[partner]) {
        items.push({ kind: 'segment', label: 'Move desk to row', options: moveRowOptions(
          new Set([hit.rowIndex]),
          dest => mut(() => {
            moveChairsToRow([
              { rowIndex: hit.rowIndex, chairIndex: Math.min(hit.chairIndex, partner) },
              { rowIndex: hit.rowIndex, chairIndex: Math.max(hit.chairIndex, partner) },
            ], resolveMoveDest(dest))
            afterMove()
          }),
        ) })
      }
    }
    items.push({ kind: 'action', label: 'Delete chair', danger: true, onClick: () => mut(() => {
      deleteChairs([{ rowIndex: hit.rowIndex, chairIndex: hit.chairIndex }])
      afterMove()
      updateAllInputs()
    }) })
    // Clicking a chair selects it as well as opening its menu, so the orange
    // drop slots appear for a single chair exactly as they do for a marquee —
    // otherwise "select then place" only works for boxed selections, which is
    // an arbitrary distinction from the user's side. Only in select mode; with
    // a tool armed the selection would be invisible (see renderChart's gate).
    if (activeTool === null) {
      setSelectedChairs([{ rowIndex: hit.rowIndex, chairIndex: hit.chairIndex }])
    }
    showContextMenu(clientX, clientY, 'Chair', items)
    return true
  }
  return false
}

// Bulk version of the chair context menu, opened by marquee-selecting chairs
// while NO tool is armed. Same actions as the single-chair menu, applied to the
// whole box in one undo step — the noun-first counterpart to arming a tool and
// dragging over chairs. "Move to row" is the reason this exists: reshaping a
// string section means relocating several chairs at once.
function openBulkChairMenu(
  refs: { rowIndex: number; chairIndex: number }[],
  clientX: number, clientY: number,
  centre: { x: number; y: number },
): boolean {
  const chairOf = (r: { rowIndex: number; chairIndex: number }) =>
    config.rows[r.rowIndex]?.chairs[r.chairIndex]
  const targets = refs.filter(r => chairOf(r))
  if (targets.length === 0) return false

  const mut = (fn: () => void) => {
    history.push(config)
    fn()
    renderRowList()
    renderLabelList()
    renderChart()
  }
  // Show a segment option as active only when every selected chair agrees —
  // a mixed selection shows none highlighted, which reads honestly.
  const allAre = <T,>(read: (c: Chair) => T, value: T) => targets.every(r => read(chairOf(r)!) === value)
  const standOf = (r: { rowIndex: number; chairIndex: number }) =>
    chairStandMode(config.rows[r.rowIndex].chairs, r.chairIndex)
  const allStand = (m: StandMode) => targets.every(r => standOf(r) === m)
  const colours = new Set(targets.map(r => chairOf(r)!.color))

  const items: MenuItem[] = [
    { kind: 'action', label: 'Edit labels…', onClick: () => openBulkLabelEditor(targets, chartPointToScreen(centre)) },
    { kind: 'segment', label: 'Visible', options: [
      { label: 'Show', active: allAre(c => c.enabled, true), onClick: () => mut(() => { for (const r of targets) chairOf(r)!.enabled = true }) },
      { label: 'Hide', active: allAre(c => c.enabled, false), onClick: () => mut(() => { for (const r of targets) chairOf(r)!.enabled = false }) },
    ] },
    { kind: 'segment', label: 'Seat', options: [
      { label: 'Chair',    active: allAre(chairStoolMode, 'chair'),    onClick: () => mut(() => { for (const r of targets) applyStoolToChair(chairOf(r)!, 'chair') }) },
      { label: 'Stool',    active: allAre(chairStoolMode, 'stool'),    onClick: () => mut(() => { for (const r of targets) applyStoolToChair(chairOf(r)!, 'stool') }) },
      { label: 'Standing', active: allAre(chairStoolMode, 'standing'), onClick: () => mut(() => { for (const r of targets) applyStoolToChair(chairOf(r)!, 'standing') }) },
    ] },
    { kind: 'segment', label: 'Stand', options: [
      { label: 'None', active: allStand('remove'), onClick: () => mut(() => applyStandModeToTargets(targets, 'remove')) },
      { label: 'Solo', active: allStand('solo'),   onClick: () => mut(() => applyStandModeToTargets(targets, 'solo')) },
      { label: 'Desks', active: allStand('desk'),  onClick: () => mut(() => applyStandModeToTargets(targets, 'desk')) },
    ] },
    { kind: 'swatches', label: 'Colour', colors: CHAIR_SWATCHES,
      current: colours.size === 1 ? [...colours][0] : '',
      onPick: (c) => mut(() => { for (const r of targets) chairOf(r)!.color = c }),
      onCustom: () => openBulkColorPicker(targets) },
  ]
  if (config.rows.length > 1) {
    items.push({ kind: 'segment', label: 'Move to row', options: moveRowOptions(
      new Set(targets.map(r => r.rowIndex)),
      dest => mut(() => { moveChairsToRow(targets, resolveMoveDest(dest)); selectedChairs = [] }),
    ) })
  }
  items.push({ kind: 'action', label: `Delete ${targets.length} chair${targets.length !== 1 ? 's' : ''}`,
    danger: true, onClick: () => mut(() => { deleteChairs(targets); selectedChairs = []; updateAllInputs() }) })
  showContextMenu(clientX, clientY, `${targets.length} chair${targets.length !== 1 ? 's' : ''}`, items)
  return true
}

// Custom colour for a whole marquee selection (the bulk menu's "custom").
function openBulkColorPicker(targets: { rowIndex: number; chairIndex: number }[]) {
  const first = config.rows[targets[0].rowIndex]?.chairs[targets[0].chairIndex]
  const input = document.createElement('input')
  input.type = 'color'
  input.value = first && /^#[0-9a-fA-F]{6}$/.test(first.color) ? first.color : '#a8d8ea'
  input.style.cssText = 'position:fixed;left:-9999px;top:0'
  document.body.appendChild(input)
  input.addEventListener('change', () => {
    history.push(config)
    for (const r of targets) {
      const c = config.rows[r.rowIndex]?.chairs[r.chairIndex]
      if (c) c.color = input.value
    }
    renderChart()
    input.remove()
  })
  input.click()
}

// Marquee Stand: 'desk' pairs *consecutive adjacent* selected chairs within each
// row into shared desks (leftover → solo); solo/remove go per-chair.
function applyStandModeToTargets(targets: { rowIndex: number; chairIndex: number }[], mode: StandMode = standMode) {
  const byRow = new Map<number, number[]>()
  for (const r of targets) (byRow.get(r.rowIndex) ?? byRow.set(r.rowIndex, []).get(r.rowIndex)!).push(r.chairIndex)
  for (const [rowIndex, idxs] of byRow) {
    idxs.sort((a, b) => a - b)
    const rowChairs = config.rows[rowIndex].chairs
    if (mode !== 'desk') {
      for (const i of idxs) applyStandToChair(rowChairs, i, mode)
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
  const show = hasFinePointer && activeTab === 'edit' && activeTool === 'label'
  dragOverwriteBtn.style.display = show ? '' : 'none'
}

// The armed-tool pill floating over the canvas: names the armed tool and its
// payload (armed instrument label, stand/seat mode, colour swatch) so the
// next click's effect is always visible without glancing at the sidebar.
// Hidden when no tool is armed or on the view-only / geometry tabs. Shown on
// Setup as well as Edit because armed tools apply to chair clicks there too.
// Re-run whenever the tool or its payload changes, and on tab switches.
function updateToolPill() {
  const show = activeTool !== null && (activeTab === 'edit' || activeTab === 'setup')
  toolPill.style.display = show ? '' : 'none'
  if (!show || activeTool === null) return
  let html = ''
  if (activeTool === 'toggle') {
    html = '<b>Hide</b> — click a chair to hide / show it'
  } else if (activeTool === 'stand') {
    const m = { solo: 'Solo', desk: 'In desks', remove: 'Remove' }[standMode]
    html = `<b>Music Stand: ${m}</b> — click or drag a box over chairs`
  } else if (activeTool === 'stool') {
    const m = { chair: 'Chair', stool: 'Stool', standing: 'Standing' }[stoolMode]
    html = `<b>Chair Type: ${m}</b> — click or drag a box over chairs`
  } else if (activeTool === 'color') {
    html = `<b>Colour</b> <span class="tool-pill-swatch" style="background:${escapeHtml(activeColor)}"></span> — click or drag a box over chairs`
  } else if (activeTool === 'label') {
    html = selectedLabel !== null
      ? `<b>Label: “${escapeHtml(selectedLabel)}”</b> — click chairs to stamp it`
      : '<b>Label</b> — click a chair to type its name'
  }
  toolPillText.innerHTML = html
}

// Apply the active chair tool to every enabled chair caught by a marquee drag,
// in a single undo step. `centre` is the box centre (chart coords), used only to
// place the free-type bulk-label input.
function applyBulkTool(refs: { rowIndex: number; chairIndex: number }[], centre: { x: number; y: number }) {
  if (activeTool === null) return   // select mode: nothing to bulk-apply
  const targets = refs.filter(r => config.rows[r.rowIndex]?.chairs[r.chairIndex]?.enabled)
  if (targets.length === 0) return

  if (activeTool === 'label') {
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

// Right-click a chair or stand → a small menu of its actions (an alternative to
// picking a tool). Only in the Edit tab, where chair editing lives.
canvas.addEventListener('contextmenu', (e) => {
  if (activeTab !== 'edit') return          // let the browser's own menu show elsewhere
  e.preventDefault()
  const cv = pointerCanvasCoords(e)
  const { x, y } = canvasToChart(cv.x, cv.y)
  openChairContextMenu(e.clientX, e.clientY, x, y)
})

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

  // No tool armed (select mode, the default): clicking a chair or stand opens
  // the same menu as a right-click — noun-first editing, no mode to remember.
  if (activeTool === null) {
    // Nothing under the pointer → treat it as "deselect".
    if (activeTab === 'edit' && !openChairContextMenu(e.clientX, e.clientY, x, y)) {
      clearSelectedChairs()
    }
    return
  }

  // Stand tool: clicking directly on a stand ×  is equivalent to clicking
  // its owning chair — resolve the stand hit first so the × is a valid target.
  const standHit = activeTool === 'stand' ? renderer.standHitTest(x, y) : null
  const hit = standHit ?? renderer.hitTest(x, y)
  if (!hit) return
  // Label tool → type a free-text label right on the chair.
  // Label tool: if an instrument is armed from the picker, clicking stamps it;
  // otherwise clicking opens the free-type editor to type a name.
  if (activeTool === 'label') {
    if (selectedLabel !== null) {
      history.push(config)
      config.rows[hit.rowIndex].chairs[hit.chairIndex].label = selectedLabel
      renderChart()
    } else {
      openChairLabelEditor(hit.rowIndex, hit.chairIndex)
    }
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
  // Registered before any context menu exists, so this capture-phase listener
  // runs ahead of the menu's own capture-phase Escape handler and can see that
  // the menu was still open when the key went down.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && contextMenuOpen()) escapeClosedMenu = true
  }, true)

  for (const el of [titleInput, layoutSelect, notesArea, showNumbersCheck,
    restartNumbersCheck, showRowLabelsCheck, conductorStandCheck, showConductorCheck, flipCheck,
    straightRowsInput, rowCountInput, showArcCheck, arcRangeInput, rowSpacingInput,
    riserStepHeightInput, showStageDirectionsCheck, chartScaleInput, stageTemplateSelect,
    bgFitSelect, showCreditCheck]) {
    el.addEventListener('change', () => { readInputs(); updateAllInputs(); renderChart() })
  }

  // Bidirectional row-hover highlight. Canvas hover -> highlight the chairs
  // under the cursor and their sidebar row control; hovering/focusing a row
  // control highlights the matching chairs on the canvas.
  canvas.addEventListener('pointermove', (e) => {
    if (!e.isPrimary) return
    if (anyDragActive()) { hideHandleTip(); return }
    if (activeTab !== 'edit' && activeTab !== 'layout') return
    updateHandleTip(e)
    setHoverChair(chairAtPointer(e))
  })
  canvas.addEventListener('pointerleave', () => { setHoverChair(null); hideHandleTip() })
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
        // New chairs inherit the row's prevailing stand state (the last
        // existing chair's) instead of always defaulting to no stand —
        // growing a row of stand-equipped chairs shouldn't silently add
        // stand-less ones at the end.
        const inheritStand = current.length > 0 ? current[current.length - 1].hasStand : true
        for (let i = current.length; i < count; i++) {
          current.push({ id: crypto.randomUUID(), enabled: true, color: '#e8e8e8', label: '', hasStand: inheritStand, standAfter: false })
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
    } else if (target.classList.contains('row-riser')) {
      const lvl = Number(target.value) || 0
      if (lvl <= 0) delete config.rows[rowIdx].riser
      else config.rows[rowIdx].riser = lvl
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
    } else if (target.classList.contains('row-item-name')) {
      // Click the row name to rename it in place, freeing the header from an
      // always-visible Label input (there's now a Riser control there too).
      const header = target.closest('.row-item-header')
      const input = header?.querySelector<HTMLInputElement>('.row-label-input')
      if (header && input) {
        header.classList.add('editing')
        input.focus()
        input.select()
      }
    }
  })

  // Row list: commit/cancel the inline rename on Enter/Escape. Collapse the
  // 'editing' class directly here rather than leaning on the blur/focusout
  // that follows — blur doesn't reliably fire synchronously in every
  // environment, and Enter with an unchanged value never fires 'change' (the
  // handler that would otherwise trigger a rebuild), so this must not depend
  // on either. The plain-blur-to-elsewhere case (no key) still collapses via
  // the focusout listener below.
  rowsContainer.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement
    if (!target.classList.contains('row-label-input')) return
    if (e.key === 'Enter') {
      target.blur()
      target.closest('.row-item-header')?.classList.remove('editing')
    } else if (e.key === 'Escape') {
      const rowIdx = Number(target.dataset['row'])
      const row = config.rows[rowIdx]
      if (row) (target as HTMLInputElement).value = row.label
      target.blur()
      target.closest('.row-item-header')?.classList.remove('editing')
    }
  })
  rowsContainer.addEventListener('focusout', (e) => {
    const target = e.target as HTMLElement
    if (!target.classList.contains('row-label-input')) return
    target.closest('.row-item-header')?.classList.remove('editing')
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
    config.rows.push(makeRow(8, nextRowLabel()))
    updateAllInputs()
    renderChart()
  })

  removeLastRowBtn.addEventListener('click', () => {
    if (config.rows.length === 0) return
    history.push(config)
    config.rows.pop()
    // Keep straightRows in range if we removed a row it was counting.
    config.straightRows = Math.min(config.straightRows, config.rows.length)
    setHoverRow(null)         // any hover on the removed row is now stale
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
    closeContextMenu()        // and don't leave a context menu floating either
    hideHandleTip()           // the layout handles it describes are gone too
    selectedChairs = []       // selection + drop slots are Edit-tab only
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
    updateToolPill()     // pill shows only where armed tools apply (Edit/Setup)
  }
  tabButtons.forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset['tab'])))
  tabNavButtons.forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset['tabNav'])))

  // Clears the armed instrument selection (highlight + status + selectedLabel).
  // Called from setChairTool whenever the active chair tool changes.
  function clearLabelSelection() {
    selectedLabel = null
    instrumentPickerList.querySelectorAll('.active').forEach(el => el.classList.remove('active'))
    // Status only carries the dynamic "Selected: X" feedback; the general
    // instruction lives in the tool hint above, so keep this empty when idle.
    instrumentPickerStatus.textContent = ''
  }

  // Single source of truth for "what does clicking a chair do". Each Edit Chairs
  // tool button arms one of toggle/stand/stool/label/color; null puts the tool
  // down (select mode — a chair click opens its context menu). The Label tool
  // has two modes: with an instrument armed from the picker a click stamps it,
  // otherwise a click opens the free-type editor. Keeps the tool buttons,
  // sub-panels, label selection and the canvas tool pill in sync.
  function setChairTool(tool: ChairTool | null) {
    activeTool = tool
    lastCycledChair = null   // a new chair always starts from the armed mode
    toolButtons.forEach(b => b.classList.toggle('active', b.dataset['tool'] === tool))
    colorPickerLabel.style.display = tool === 'color' ? '' : 'none'
    colorBulkPanel.style.display = tool === 'color' ? '' : 'none'
    standBulkPanel.style.display = tool === 'stand' ? '' : 'none'
    stoolBulkPanel.style.display = tool === 'stool' ? '' : 'none'
    // The Label tool shows both the instrument picker (stamp a named part) and
    // the free-type / paste panel — two ways to put a label on a chair.
    labelPanel.style.display = tool === 'label' ? '' : 'none'
    instrumentPanel.style.display = tool === 'label' ? '' : 'none'
    syncDragControls()
    // Rebuild the paste list on entry so it reflects any chairs hidden/shown
    // since it was last drawn (the toggle tool only re-renders the canvas).
    if (tool === 'label') renderLabelList()
    editChairsHint.textContent = tool ? TOOL_HINTS[tool] : NEUTRAL_HINT
    // Always clear the instrument selection: switching to a non-label tool
    // leaves label mode, and switching INTO the Label tool means free-type
    // (the picker re-sets selectedLabel itself, after this call).
    clearLabelSelection()
    closeChairLabelEditor()
    updateToolPill()
    // The hover preview depends on the armed tool; refresh the canvas so a
    // chair already under the pointer previews the NEW tool, not the old one.
    rerenderCanvasOnly()
  }

  // Tool selection. Clicking the already-armed tool's button puts it down
  // again (back to select mode), so every way into a mode is also a way out.
  toolButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const tool = btn.dataset['tool'] as ChairTool
      setChairTool(tool === activeTool ? null : tool)
    })
  })
  // The pill's ✕ — same as Escape.
  toolPillClose.addEventListener('click', () => setChairTool(null))

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
      updateToolPill()
    })
  })

  // Stool sub-panel is a mode selector (Chair / Stool / Standing).
  const STOOL_MODE_MAP: Record<string, StoolMode> = { 'chairs': 'chair', 'stools': 'stool', 'standing': 'standing' }
  stoolBulkButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      stoolMode = STOOL_MODE_MAP[btn.dataset['stoolBulk'] ?? 'chairs'] ?? 'chair'
      stoolBulkButtons.forEach(b => b.classList.toggle('active', b === btn))
      updateToolPill()
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

  clearLabelsBtn.addEventListener('click', async () => {
    const labelled = config.rows.reduce(
      (n, row) => n + row.chairs.filter(c => c.label).length, 0)
    if (labelled === 0) return
    if (!await showConfirm(`Clear ${labelled} chair label${labelled !== 1 ? 's' : ''}? This can be undone.`, { title: 'Clear labels', confirmLabel: 'Clear' })) return
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
            updateToolPill()
            rerenderCanvasOnly()   // refresh any live hover preview with the new label
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
    updateToolPill()
    rerenderCanvasOnly()   // refresh any live hover preview with the new colour
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
  // Zoom only on a pinch / ctrl+wheel gesture (macOS trackpad pinch arrives as
  // wheel + ctrlKey). A plain scroll must pass through so the page can scroll —
  // otherwise scrolling over the canvas silently zooms the view, which then
  // turns an Edit-tab marquee drag into a pan and hides the controls below.
  canvas.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return
    e.preventDefault()
    // deltaY isn't always in pixels: Firefox reports LINES (≈3 per notch) and
    // some setups report PAGES, either of which makes a pixel-tuned factor
    // almost imperceptible. Normalise first, then clamp so one outsized event
    // can't leap the whole 1–6 range in a single step.
    const px = e.deltaMode === 1 ? e.deltaY * 16
      : e.deltaMode === 2 ? e.deltaY * 400
      : e.deltaY
    const factor = Math.exp(-Math.max(-240, Math.min(240, px)) * ZOOM_WHEEL_SENSITIVITY)
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
  resetLayoutBtn.addEventListener('click', async () => {
    if (!await showConfirm('Reset all manual row and chair position tweaks back to the default layout?', { title: 'Reset layout', confirmLabel: 'Reset' })) return
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

  // Tidy sections: infer a section grouping from existing chair labels and
  // assign it as `chair.group`, so arc rows fan into one contiguous wedge
  // per section (see renderArcRow's grouped placement) instead of being
  // spread evenly across the row — without dragging a single chair.
  //
  // Two chairs are treated as the same section only if their labels match
  // EXACTLY (after trimming). This app uses the label itself as the section
  // name (e.g. every "Vln 1" chair IS the first-violin section) — there is
  // no per-chair numbering to strip, and guessing at one risks merging
  // genuinely different sections (e.g. "Tpt 1" / "Tpt 2"). An unlabelled
  // chair gets its own one-wide wedge (keyed by its id) rather than no
  // group at all, since a row needs every chair grouped for the wedge
  // layout to apply (see renderArcRow's `allGrouped` check).
  //
  // Old-style hidden placeholder chairs (disabled, no label) were the only
  // way to shape a section's density before grouped wedges existed — the
  // wedge layout doesn't need them, so this also removes any that remain.
  tidySectionsBtn.addEventListener('click', async () => {
    if (config.layout !== 'semicircle') {
      void showAlert('Tidy sections only applies to semicircle charts.', { title: 'Tidy sections' })
      return
    }
    const numRows = config.rows.length
    const isStraightRow = (i: number) =>
      config.rows[i].isStraight ?? (i >= numRows - config.straightRows)
    const targetRows = config.rows
      .map((row, i) => ({ row, i }))
      .filter(({ row, i }) => !isStraightRow(i) && row.chairs.some(c => c.label.trim()))

    if (targetRows.length === 0) {
      void showAlert('No labelled chairs found in any arc row — nothing to tidy.', { title: 'Tidy sections' })
      return
    }
    // Gate: the fanned-wedge layout is an orchestral STRING arrangement
    // (violins/violas/cellos/basses fanning around the conductor). A concert or
    // big band has no violins and its sections don't seat this way, so wedging
    // them scrambles the chart. Require violins before tidying.
    const hasViolins = targetRows.some(({ row }) =>
      row.chairs.some(c => c.label.trim() && isViolinSection(c.label)))
    if (!hasViolins) {
      void showAlert(
        'Tidy sections arranges orchestral string sections (violins, violas, cellos, basses) into fanned wedges. This chart has no violin sections, so there’s nothing for it to tidy.',
        { title: 'Tidy sections' })
      return
    }
    // Count the string chairs that will be wedged and any hidden placeholder
    // chairs that will be removed.
    let spacerCount = 0, groupCount = 0
    for (const { row } of targetRows) {
      for (const c of row.chairs) {
        if (!c.enabled && !c.label.trim()) spacerCount++
        else if (isStringSection(c.label)) groupCount++
      }
    }
    const msg = spacerCount > 0
      ? `Arrange ${groupCount} string chairs into fanned sections, and remove ${spacerCount} unused placeholder chair${spacerCount !== 1 ? 's' : ''}? This can be undone.`
      : `Arrange ${groupCount} string chairs into fanned sections? This can be undone.`
    if (!await showConfirm(msg, { title: 'Tidy sections', confirmLabel: 'Tidy' })) return

    history.push(config)
    for (const { row } of targetRows) {
      row.chairs = row.chairs.filter(c => c.enabled || c.label.trim())
      // Only bowed strings get wedged; winds/brass/percussion keep the even-
      // spread arc layout (they don't fan around the conductor).
      for (const c of row.chairs) c.group = isStringSection(c.label) ? c.label.trim() : undefined
    }
    // Cellos and basses form one continuous low-string block in an orchestra
    // (basses sit behind/beside the cellos), so merge a detected bass section
    // into the cello section's group — otherwise the basses get their own
    // separate, stranded wedge. Labels are matched loosely (case, spacing and
    // trailing part number ignored) against the common cello/bass names.
    const celloGroup = findSectionGroup(targetRows, CELLO_LABELS)
    if (celloGroup) {
      for (const { row } of targetRows) {
        for (const c of row.chairs) {
          if (c.group && BASS_LABELS.has(normalizeSectionLabel(c.label))) c.group = celloGroup
        }
      }
    }
    // No radius fix-up needed: the renderer spaces each grouped row's chairs
    // by fixed pixels ("donut slice" layout), so desks stay clear at the
    // rows' natural (compact) radii.
    renderLabelList()   // spacer chairs may have been removed → rebuild the paste list
    renderChart()
  })

  // Per-row inspector (Layout tab): edit distance / spread numerically.
  layoutRowList.addEventListener('change', (e) => {
    const input = (e.target as HTMLElement).closest('input, select') as HTMLInputElement | HTMLSelectElement | null
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
    // Sync the boxes in place (don't rebuild) so the stepper the user just
    // clicked survives — see layoutInputEditing.
    layoutInputEditing = true
    renderChart()
    layoutInputEditing = false
  })
  layoutRowList.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.lay-reset') as HTMLElement | null
    if (!btn) return
    const row = config.rows[Number(btn.dataset['row'])]
    if (!row) return
    history.push(config)
    delete row.gapBefore; delete row.arcStart; delete row.arcEnd
    delete row.straightSpacing; delete row.straightOffset; delete row.riser; delete row.riserPad
    for (const chair of row.chairs) delete chair.offset
    renderChart()
  })
  document.addEventListener('keydown', (e) => {
    // While typing a chair label inline, let its own handler deal with keys
    // (Enter/Escape) and keep global shortcuts (undo, delete…) out of the way.
    if (document.activeElement === chairLabelInput) return
    // Close any open modal / drawer on Escape
    if (e.key === 'Escape') {
      // An in-progress drag wins: abort it before closing anything else.
      if (cancelActiveDrag()) return
      // The context menu closes itself from a CAPTURE-phase listener, so by
      // the time this bubble-phase handler runs it's already gone. escapeClosedMenu
      // (recorded by our own earlier capture listener) is how we still know
      // this keypress was spent on the menu — otherwise one Escape would both
      // close the menu and drop the selection behind it.
      if (escapeClosedMenu) { escapeClosedMenu = false; return }
      if (clearSelectedChairs()) return
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
      // No overlay open: put down the armed chair tool (matches the pill's ✕).
      if (activeTool !== null) {
        setChairTool(null)
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

    // Spacebar arms pan-drag (see spaceHeld). Held, not toggled, and never
    // while typing — and preventDefault stops the sidebar scrolling under it.
    if (e.code === 'Space') {
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return
      // (No cursor change needed: applyViewTransform already puts the grab
      // cursor on the canvas whenever viewZoom > 1, which is the only time
      // space-pan does anything.)
      spaceHeld = true
      e.preventDefault()
      return
    }

    // Cmd/Ctrl + 1-4 jumps between the sidebar tabs.
    if ((e.metaKey || e.ctrlKey) && ['1', '2', '3', '4'].includes(e.key)) {
      e.preventDefault()
      switchTab((['setup', 'edit', 'layout', 'export'])[Number(e.key) - 1])
    }

    // "?" opens the About panel at its shortcut list. Plain key, so ignore it
    // while typing — and it needs Shift on most layouts, hence no modifier
    // check beyond that.
    if (e.key === '?' && !e.metaKey && !e.ctrlKey) {
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return
      e.preventDefault()
      aboutModal.style.display = 'flex'
      document.getElementById('about-shortcuts')?.scrollIntoView({ block: 'start' })
    }

    // Delete selected chairs (Delete or Backspace). Removes the seats outright,
    // unlike Hide, which keeps their place so the row doesn't shift.
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedChairs.length > 0) {
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return
      e.preventDefault()
      history.push(config)
      deleteChairs(selectedChairs)
      selectedChairs = []
      renderRowList()
      renderLabelList()
      updateAllInputs()
      renderChart()
      return
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

    // Arrow keys nudge the selected instrument (2px; Shift = 10px) — the
    // fine-placement companion to dragging. Same input guard as Delete.
    const ARROW_DELTAS: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
    }
    if (ARROW_DELTAS[e.key] && selectedInstrumentId) {
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return
      const inst = config.instruments.find(i => i.id === selectedInstrumentId)
      if (!inst) return
      e.preventDefault()
      // One undo step per nudge burst, not per keypress: push history only
      // when starting on a different instrument or after a pause, so tapping
      // an arrow 15 times undoes in one go (mirrors the one-push-per-drag rule).
      const now = Date.now()
      if (lastArrowNudge?.id !== inst.id || now - (lastArrowNudge?.time ?? 0) > 1000) {
        history.push(config)
      }
      lastArrowNudge = { id: inst.id, time: now }
      const step = e.shiftKey ? 10 : 2
      const [ax, ay] = ARROW_DELTAS[e.key]
      // Stored position is polar around the conductor, mirrored when the chart
      // is flipped (cx = ox + mirror·d·cos a) — so a screen-space nudge maps to
      // a mirror-scaled delta in the stored frame.
      const mirror = config.flipped ? -1 : 1
      const dx = inst.distance * Math.cos(inst.angle) + mirror * ax * step
      const dy = inst.distance * Math.sin(inst.angle) + mirror * ay * step
      inst.angle = Math.atan2(dy, dx)
      inst.distance = Math.hypot(dx, dy)
      renderChart()
    }
  })

  // Space is held, not toggled. Also released on blur, so alt-tabbing away
  // mid-hold doesn't leave the canvas stuck in pan mode.
  document.addEventListener('keyup', (e) => {
    if (e.code === 'Space') spaceHeld = false
  })
  window.addEventListener('blur', () => { spaceHeld = false })

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
      void showAlert('Could not load chart file.', { title: "Couldn't load" })
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
      void showAlert('Please choose an image file.', { title: 'Background image' })
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
    reader.onerror = () => { void showAlert('Could not read image file.', { title: 'Background image' }) }
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
        const next = await showPrompt('Save chart as:', title, { title: 'Save chart', okLabel: 'Save' })
        if (next === null) return
        title = next.trim() || 'Untitled'
      }
      const id = await library.saveChart(currentChartId, title, folder, config)
      currentChartId = id
      markSaved()        // persisted to the library = clean
      updateLibraryCurrentTitle()
      await renderLibrary()
    } catch {
      void showAlert(LIBRARY_ERROR, { title: 'Library error' })
    }
  })

  libraryNewChartBtn.addEventListener('click', async () => {
    if (currentChartId && !await showConfirm('Discard current chart and start a new blank one? Anything unsaved here will be lost — use Save first if you want to keep it.', { title: 'New blank chart', confirmLabel: 'Discard & start new', danger: true })) return
    setConfig(makeDefaultConfig())
    currentChartId = null
    markSaved()        // a brand-new blank chart has nothing unsaved yet
    updateLibraryCurrentTitle()
    closeLibrary()
  })

  libraryNewFolderBtn.addEventListener('click', async () => {
    const name = await showPrompt('Folder name:', '', { title: 'New folder', okLabel: 'Create' })
    if (name === null || !name.trim()) return
    try {
      await library.createFolder(name.trim())
      await renderLibrary()
    } catch {
      void showAlert(LIBRARY_ERROR, { title: 'Library error' })
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
    handleLibraryAction(action, id, folder).catch(() => { void showAlert(LIBRARY_ERROR, { title: 'Library error' }) })
  })

  shareLinkBtn.addEventListener('click', async () => {
    const { hash, strippedBackground } = await encodeToHash(config)
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
    delete config.arcCenter
    config.rowSpacing = def.rowSpacing
    config.flipped = false
    setSelectedInstrument(null)
    presetSelect.value = ''
    updateAllInputs()
    renderChart()
  })

  // --- Setup intro hint (dismissable) ---
  const HINT_KEY = 'sp_intro_dismissed'
  if (setupIntroHint && localStorage.getItem(HINT_KEY)) setupIntroHint.style.display = 'none'
  dismissIntroHintBtn?.addEventListener('click', () => {
    if (setupIntroHint) setupIntroHint.style.display = 'none'
    localStorage.setItem(HINT_KEY, '1')
  })

  // --- About modal ---
  aboutBtn.addEventListener('click', () => { aboutModal.style.display = 'flex' })
  aboutCloseBtn.addEventListener('click', () => { aboutModal.style.display = 'none' })
  aboutModal.addEventListener('click', (e) => {
    if (e.target === aboutModal) aboutModal.style.display = 'none'
  })

  // --- Custom orchestra modal ---
  // Two ways to specify the composition: "Simple" (labelled per-section count
  // fields, no notation syntax to learn) and "Advanced" (the raw Boosey &
  // Hawkes notation box). Simple just assembles a notation string and feeds
  // the same parseOrchestraNotation -> applyPreset pipeline as Advanced, plus
  // Timpani/Harp/Piano which aren't expressible in notation — those are
  // appended as fixed instruments the same way the Edit tab's add-instrument
  // buttons do (makeInstrument, positioned from the resulting back row).
  let coMode: 'simple' | 'advanced' = 'simple'

  const setCoMode = (mode: 'simple' | 'advanced') => {
    coMode = mode
    coModeSimpleBtn.classList.toggle('active', mode === 'simple')
    coModeAdvancedBtn.classList.toggle('active', mode === 'advanced')
    coSimplePanel.style.display = mode === 'simple' ? '' : 'none'
    coAdvancedPanel.style.display = mode === 'advanced' ? '' : 'none'
    refreshCustomPreview()
  }

  // Assembles a 3-block notation string (Ww - Br - Str) from the Simple
  // fields. Percussion is intentionally omitted from notation — like the
  // built-in Symphony/Chamber presets, timpani is a fixed instrument instead.
  const simpleNotation = (): string => {
    const n = (el: HTMLInputElement) => Math.max(0, Math.min(99, Number(el.value) || 0))
    const ww = [coFl, coOb, coCl, coBsn].map(n).join('.')
    const br = [coHn, coTpt, coTbn, coTuba].map(n).join('.')
    const str = [coVn1, coVn2, coVa, coVc, coCb].map(n).join('.')
    return `${ww} - ${br} - ${str}`
  }

  const openCustomModal = () => {
    customOrchestraTitle.value = ''
    customOrchestraNotation.value = ''
    setCoMode('simple')
    customOrchestraModal.style.display = 'flex'
    setTimeout(() => customOrchestraTitle.focus(), 0)
  }
  const closeCustomModal = () => { customOrchestraModal.style.display = 'none' }

  const refreshCustomPreview = () => {
    const text = coMode === 'simple' ? simpleNotation() : customOrchestraNotation.value.trim()
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
    const lines = [describeComposition(comp)]
    if (coMode === 'simple') {
      const extras: string[] = []
      const rawTimp = Math.max(0, Math.min(6, Number(coTimp.value) || 0))
      const timp = rawTimp === 1 ? 2 : rawTimp  // 1 timpani makes no sense; snap to 2
      if (timp > 0) extras.push(`${timp} Timpani`)
      if (coHarp.checked) extras.push('Harp')
      if (coPiano.checked) extras.push('Piano')
      if (extras.length) lines.push(`Extras: ${extras.join(', ')}`)
    }
    customOrchestraPreview.textContent = lines.join('\n')
    customOrchestraPreview.classList.remove('error')
  }

  customOrchestraBtn.addEventListener('click', openCustomModal)
  customOrchestraCancel.addEventListener('click', closeCustomModal)
  // Click on the backdrop (but not the card) closes
  customOrchestraModal.addEventListener('click', (e) => {
    if (e.target === customOrchestraModal) closeCustomModal()
  })
  coModeSimpleBtn.addEventListener('click', () => setCoMode('simple'))
  coModeAdvancedBtn.addEventListener('click', () => setCoMode('advanced'))
  for (const el of [coFl, coOb, coCl, coBsn, coHn, coTpt, coTbn, coTuba,
    coVn1, coVn2, coVa, coVc, coCb, coTimp, coHarp, coPiano]) {
    el.addEventListener('input', refreshCustomPreview)
  }
  customOrchestraNotation.addEventListener('input', refreshCustomPreview)
  customOrchestraApply.addEventListener('click', () => {
    const notation = coMode === 'simple' ? simpleNotation() : customOrchestraNotation.value.trim()
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
    // Extras (Timpani/Harp/Piano) aren't expressible in notation — add them
    // as fixed instruments now that the rows (and so the back-row radius
    // they're placed relative to) exist. Folds into the same undo step as
    // the preset apply above (no extra history.push).
    if (coMode === 'simple') {
      const rawTimp = Math.max(0, Math.min(6, Number(coTimp.value) || 0))
      const timp = rawTimp === 1 ? 2 : rawTimp  // 1 timpani makes no sense; snap to 2
      const backRadius = renderer.backRowRadius(config)
      if (timp > 0) {
        const inst = makeInstrument('timpani', config.flipped, 0, backRadius)
        inst.count = timp
        config.instruments.push(inst)
      }
      if (coHarp.checked) {
        config.instruments.push(makeInstrument('harp', config.flipped, 0, backRadius))
      }
      if (coPiano.checked) {
        config.instruments.push(makeInstrument('piano', config.flipped, 0, backRadius))
      }
      if (timp > 0 || coHarp.checked || coPiano.checked) renderChart()
    }
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

void init()
